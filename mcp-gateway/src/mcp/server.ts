import { z } from 'zod/v4'
import { createHash } from 'node:crypto'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { ATTR_USER_ID } from '@opentelemetry/semantic-conventions/incubating'
import type { Attributes } from '@opentelemetry/api'

import baseLogger, { type Logger } from '~/logger'
import { httpUrl, scope } from '~/zod-utils'
import type { Provider } from '~/oauth/provider'
import { AccessTokenPayload } from '~/oauth/token'
import {
  McpServerRateLimitConfig,
  mcpRateLimitKey,
  type McpRateLimiter,
} from '~/rate-limiting'

import { wrapRequest, processResponse } from './otel'
import { errorResponse } from './utils'

// -32029 is the MCP spec error code for rate limit exceeded
const RATE_LIMIT_ERROR_CODE = -32029

function rateLimitedResponse(): Response {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: RATE_LIMIT_ERROR_CODE, message: 'Rate limit exceeded' },
    id: null,
  })
  return new Response(body, {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function peekToolName(request: Request): Promise<string | null> {
  try {
    const body = await request.clone().json()
    if (
      body &&
      typeof body === 'object' &&
      body.method === 'tools/call' &&
      typeof body.params?.name === 'string'
    ) {
      return body.params.name as string
    }
  } catch {
    // not parseable JSON or unexpected shape — skip tool rate limiting
  }
  return null
}

export const McpServerConfig = z
  .object({
    name: z.string().nonempty(),
    description: z.string().nonempty(),
    endpoint: httpUrl,
    // if not provided, auth will be disabled for this mcp server
    auth_provider: z.string().nonempty().optional(),
    // when true, the upstream Authorization header is set to the user's OIDC
    // id_token instead of the provider access_token. Useful for upstreams that
    // perform their own OIDC token exchange (e.g. JFrog). Requires auth_provider,
    // and the provider must be OIDC and request the "openid" scope.
    forward_id_token: z.boolean().optional(),
    // if set, these will override the scopes set in the auth provider config
    scope: scope.optional(),
    // allowed headers to pass through from MCP requests. Certain headers like
    // Accept, Accept-Encoding, Connection, and mcp-related headers are always
    // forwarded regardless of this setting.
    // NOTE: if an auth_provider is configured, this list CANNOT include
    // the Authorization header
    forwarded_headers: z.string().toLowerCase().array().optional(),
    rate_limit: McpServerRateLimitConfig.optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.auth_provider &&
      data.forwarded_headers?.includes('authorization')
    ) {
      ctx.issues.push({
        code: 'custom',
        message:
          "forwarded_headers cannot include 'Authorization' when auth_provider is set",
        input: data.forwarded_headers,
        path: ['forwarded_headers'],
      })
    }

    if (data.forward_id_token && !data.auth_provider) {
      ctx.issues.push({
        code: 'custom',
        message: 'forward_id_token requires auth_provider to be set',
        input: data.forward_id_token,
        path: ['forward_id_token'],
      })
    }
  })

export type McpServerConfig = z.infer<typeof McpServerConfig>

// headers always forwarded from client requests
const defaultForwardedHeaders = new Set([
  // standard "safe" headers
  'accept',
  // 'accept-encoding',
  'connection',
  'origin',
  // mcp-related headers
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
])

/**
 * Automatically fixes response headers to account for https://github.com/honojs/node-server/issues/121
 */
function handleResponseBody(response: Response) {
  // if there's no body, then hono won't mess with the headers, so we can just return
  if (!response.body) return response

  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export class McpServer {
  #name: string
  #config: McpServerConfig
  #authProvider: Provider | null
  #logger: Logger
  #allowedHeaders: Set<string>

  constructor(
    name: string,
    config: McpServerConfig,
    authProvider: Provider | null
  ) {
    this.#name = name
    this.#config = config
    this.#authProvider = authProvider
    this.#logger = baseLogger.child({
      module: 'mcp-server',
      server: this.#name,
    })

    this.#allowedHeaders = this.#config.forwarded_headers
      ? defaultForwardedHeaders.union(new Set(this.#config.forwarded_headers))
      : defaultForwardedHeaders
  }

  get name() {
    return this.#name
  }

  get config() {
    return { ...this.#config }
  }

  get requiresAuth() {
    return this.#authProvider !== null
  }

  get authProvider() {
    return this.#authProvider
  }

  get scope() {
    return this.#config.scope?.join(' ') ?? this.authProvider?.scope ?? null
  }

  scopeHash(): string {
    const scopes = this.scope?.split(' ') ?? []
    return createHash('sha1')
      .update([...scopes].sort().join(' '))
      .digest('hex')
  }

  #headers(request: Request) {
    const headers = new Headers()

    for (const [key, value] of request.headers) {
      if (this.#allowedHeaders.has(key.toLowerCase())) {
        headers.append(key, value)
      }
    }

    return headers
  }

  #upstreamHeaders(request: Request) {
    const headers = this.#headers(request)
    const upstream = new URL(this.#config.endpoint)
    // Upstream MCP servers validate Host; set it to the backend, not the gateway client.
    headers.set('host', upstream.host)
    headers.delete('content-length')
    return headers
  }

  async handleRequest(
    request: Request,
    accessToken?: AccessTokenPayload,
    rateLimiter?: McpRateLimiter
  ): Promise<Response> {
    const headers = this.#upstreamHeaders(request)
    const attrs: Attributes = {
      'gateway.mcp_server.name': this.#name,
      // the resolved upstream MCP server the request is proxied to
      'gateway.upstream_endpoint': this.#config.endpoint,
    }

    if (this.requiresAuth) {
      // access token should be passed in by the mcp route, so if it's not
      // present here then there's a bug in the mcp route handler, not a failed
      // authentication
      if (!accessToken) throw new TypeError('expected access token')

      // when forward_id_token is set, hand the upstream the user's OIDC id_token
      // (a signed JWT) so it can perform its own token exchange. Otherwise
      // forward the provider access token as usual.
      let upstreamToken = accessToken.access_token
      if (this.#config.forward_id_token) {
        if (!accessToken.id_token) {
          throw errorResponse(
            ErrorCode.InvalidRequest,
            'no id_token available for this session; ensure the provider is OIDC and requests the "openid" scope',
            401
          )
        }
        upstreamToken = accessToken.id_token
      }

      headers.set('Authorization', `Bearer ${upstreamToken}`)
      attrs['gateway.oauth_provider'] = accessToken.provider
      attrs['gateway.oauth_client_id'] = accessToken.client_id
      if (accessToken.user_id) attrs[ATTR_USER_ID] = accessToken.user_id
    }

    // we don't collect OTEL metrics on GET or DELETE requests, so we can
    // just proxy those directly to the mcp endpoint
    if (request.method === 'GET' || request.method === 'DELETE') {
      this.#logger.debug(
        { endpoint: this.#config.endpoint, method: request.method },
        'proxying mcp request to upstream'
      )
      const response = await fetch(this.#config.endpoint, {
        method: request.method,
        headers,
      })
      this.#logger.debug(
        {
          endpoint: this.#config.endpoint,
          method: request.method,
          status: response.status,
        },
        'received response from mcp endpoint'
      )

      return handleResponseBody(response)
    }

    if (rateLimiter && accessToken) {
      const key = mcpRateLimitKey(
        accessToken.client_id,
        accessToken.user_id,
        this.#name
      )

      if (await rateLimiter.checkAll(key)) return rateLimitedResponse()

      // peek at tool name before wrapRequest consumes the body
      const toolName = await peekToolName(request)
      if (toolName && (await rateLimiter.checkTool(toolName, key))) {
        return rateLimitedResponse()
      }
    }

    const [body, ctx] = await wrapRequest(request, attrs)
    let response: Response
    try {
      headers.set('Content-Type', 'application/json')
      this.#logger.debug(
        { endpoint: this.#config.endpoint, method: request.method },
        'forwarding mcp request to upstream'
      )
      response = await fetch(this.#config.endpoint, {
        method: request.method,
        headers,
        body,
      })
      this.#logger.debug(
        {
          endpoint: this.#config.endpoint,
          method: request.method,
          status: response.status,
        },
        'received response from mcp endpoint'
      )
    } catch (error) {
      this.#logger.error({ error }, 'error forwarding request to mcp endpoint')
      ctx?.span.recordException(error as Error)
      throw errorResponse(
        ErrorCode.InternalError,
        'error forwarding request to mcp server',
        500
      )
    }

    // if we have an otel context, process the response for metrics/tracing
    if (ctx) {
      // pass cloned response to allow parsing the body concurrently with returning
      // it to the client. we don't await this because we want to return the
      // response to the client as soon as possible
      processResponse(response.clone(), ctx).catch(error => {
        this.#logger.error({ error }, 'error processing mcp response')
      })
    }

    return handleResponseBody(response)
  }
}
