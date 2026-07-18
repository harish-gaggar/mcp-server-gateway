import { z } from 'zod/v4'
import {
  ErrorCode,
  JSONRPCRequest,
  JSONRPCRequestSchema,
  JSONRPCResponse,
  JSONRPCResponseSchema,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
} from '@modelcontextprotocol/sdk/types.js'
import {
  metrics,
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Context,
} from '@opentelemetry/api'
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROMPT_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_JSONRPC_REQUEST_ID,
  ATTR_MCP_METHOD_NAME,
  ATTR_MCP_PROTOCOL_VERSION,
  ATTR_MCP_RESOURCE_URI,
  ATTR_MCP_SESSION_ID,
  ATTR_NETWORK_PROTOCOL_NAME,
  ATTR_RPC_RESPONSE_STATUS_CODE,
  METRIC_MCP_CLIENT_OPERATION_DURATION,
} from '@opentelemetry/semantic-conventions/incubating'
import { performance } from 'node:perf_hooks'
import { merge } from 'es-toolkit'
import { EventSourceParserStream } from 'eventsource-parser/stream'

import { errorResponse } from './utils'

const tracer = trace.getTracer('mcp-gateway.otel')
const meter = metrics.getMeter('mcp-gateway.otel')
const histogram = meter.createHistogram(METRIC_MCP_CLIENT_OPERATION_DURATION, {
  description:
    'The duration of the MCP request or notification as observed on the sender from the time it was sent until the response or ack is received.',
  unit: 'ms',
})

const SESSION_ID_HEADER = 'mcp-session-id'
const PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'

// make a smaller union of types we care about, so we can parse them more directly
const ParsedRequestSchema = z.discriminatedUnion('method', [
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
])

type ParsedRequest = z.infer<typeof ParsedRequestSchema>

function parseRequest(message: JSONRPCRequest) {
  const result = ParsedRequestSchema.safeParse(message)
  return result.success ? result.data : null
}

function getSpanName(request: ParsedRequest | null, message: JSONRPCRequest) {
  switch (request?.method) {
    case 'tools/call':
      return `${request.method} ${request.params.name}`
    case 'prompts/get':
      return `${request.method} ${request.params.name}`
    default:
      return message.method
  }
}

function getRequestAttributes(
  headers: Headers,
  parsed: ParsedRequest | null,
  message: JSONRPCRequest
): Attributes {
  const result: Attributes = {
    [ATTR_MCP_METHOD_NAME]: message.method,
    [ATTR_MCP_PROTOCOL_VERSION]:
      headers.get(PROTOCOL_VERSION_HEADER) ??
      DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    [ATTR_JSONRPC_REQUEST_ID]: message.id,
    [ATTR_NETWORK_PROTOCOL_NAME]: 'http',
  }

  const sessionId = headers.get(SESSION_ID_HEADER)
  if (sessionId) result[ATTR_MCP_SESSION_ID] = sessionId

  if (parsed?.method === 'tools/call') {
    result[ATTR_GEN_AI_TOOL_NAME] = parsed.params.name
    result[ATTR_GEN_AI_OPERATION_NAME] = 'execute_tool'
  }

  if (parsed?.method === 'prompts/get') {
    result[ATTR_GEN_AI_PROMPT_NAME] = parsed.params.name
  }

  if (
    parsed?.method === 'resources/read' ||
    parsed?.method === 'resources/subscribe' ||
    parsed?.method === 'resources/unsubscribe'
  ) {
    result[ATTR_MCP_RESOURCE_URI] = parsed.params.uri
  }

  return result
}

type OtelRequestContext = {
  startTime: number
  span: Span
  context: Context
  requestId: string | number
  attributes: Attributes
}

export async function wrapRequest(
  request: Request,
  extraAttributes?: Attributes
): Promise<[string, OtelRequestContext | null]> {
  if (request.method !== 'POST') throw new TypeError('expected POST request')

  if (request.headers.get('content-type') !== 'application/json') {
    throw errorResponse(ErrorCode.InvalidRequest, 'expected json request body')
  }

  let message: JSONRPCRequest

  try {
    const body = await request.json()

    // if this is a notification, we don't care about the metrics/span tracking
    // so we can just return early without parsing or validating the message
    if (isJSONRPCNotification(body)) return [JSON.stringify(body), null]

    // otherwise, we need to parse and validate the message to extract attributes
    // and inject trace context
    message = JSONRPCRequestSchema.parse(body)
  } catch (error) {
    throw errorResponse(
      ErrorCode.ParseError,
      'invalid JSON-RPC request body: ' +
        (error instanceof Error ? error.message : String(error))
    )
  }

  const parsed = parseRequest(message)
  const spanName = getSpanName(parsed, message)
  const attributes = {
    ...getRequestAttributes(request.headers, parsed, message),
    ...extraAttributes,
  }

  const span = tracer.startSpan(spanName, { attributes, kind: SpanKind.CLIENT })
  const startTime = performance.now()

  // ensure message has meta field to inject trace context into
  message = merge(message, {
    params: { _meta: {} },
  })

  const ctx = trace.setSpan(context.active(), span)
  propagation.inject(ctx, message.params!._meta)

  return [
    JSON.stringify(message),
    { startTime, span, context: ctx, requestId: message.id, attributes },
  ]
}

const acceptedContentTypes = new Set(['application/json', 'text/event-stream'])

function handleError(
  context: OtelRequestContext,
  type: string,
  message: string
) {
  const duration = performance.now() - context.startTime

  context.span
    .setStatus({
      code: SpanStatusCode.ERROR,
      message,
    })
    .setAttribute(ATTR_ERROR_TYPE, type)
    .end()

  histogram.record(duration, {
    ...context.attributes,
    [ATTR_ERROR_TYPE]: type,
  })
}

function handleMessage(context: OtelRequestContext, data: unknown) {
  let response: JSONRPCResponse
  try {
    // handle both string and already-parsed JSON responses, since the event
    // stream parser gives us strings but application/json response body is already parsed
    response = JSONRPCResponseSchema.parse(
      typeof data === 'string' ? JSON.parse(data) : data
    )
  } catch (error) {
    context.span.recordException(error as Error)
    handleError(
      context,
      'invalid_response_message',
      `invalid JSON-RPC response message: ${(error as Error).message}`
    )
    return false
  }

  if (isJSONRPCErrorResponse(response)) {
    context.attributes[ATTR_RPC_RESPONSE_STATUS_CODE] = response.error.code
    handleError(context, 'jsonrpc_error_response', response.error.message)
    return false
  }

  // if this isn't a response to the original request, return false to continue the span
  if (response.id !== context.requestId) return false

  const duration = performance.now() - context.startTime
  context.span.setStatus({ code: SpanStatusCode.OK }).end()
  histogram.record(duration, context.attributes)
  return true
}

export async function processResponse(
  response: Response,
  context: OtelRequestContext
) {
  if (!response.body) throw new TypeError('response has no body')

  const contentType = (response.headers.get('content-type') ?? '')
    .toLowerCase()
    .split(';')[0]
    .trim()

  if (!acceptedContentTypes.has(contentType)) {
    handleError(
      context,
      response.ok ? 'invalid_content_type' : 'http_error',
      response.ok
        ? `unexpected content type: ${contentType}`
        : `HTTP error ${response.status}`
    )

    return await response.body.cancel()
  }

  if (contentType === 'application/json') {
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      if (error instanceof Error) context.span.recordException(error)
      handleError(
        context,
        'invalid_response_body',
        `invalid JSON response body: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return await response.body.cancel()
    }

    handleMessage(context, body)
    return
  }

  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())

  for await (const event of stream) {
    if (event.event && event.event !== 'message') continue

    const done = handleMessage(context, event.data)
    if (done) break
  }

  await stream.cancel()
}
