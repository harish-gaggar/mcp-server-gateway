import { getRequestListener } from '@hono/node-server'
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  RequestHandler,
} from 'express'
import {
  ErrorCode,
  JSONRPCErrorResponse,
} from '@modelcontextprotocol/sdk/types.js'

import baseLogger from '~/logger'
import { McpServer } from '~/mcp'
import { TokenService, type AccessTokenPayload } from '~/oauth/token'
import type { McpRateLimiter } from '~/rate-limiting'

const logger = baseLogger.child({ module: 'mcp-route' })

type ExpressBindings = { incoming: ExpressRequest; outgoing: ExpressResponse }
type FetchCallback = Parameters<typeof getRequestListener>[0]

function internalError(error: unknown) {
  logger.error({ error }, 'error occurred processing mcp request')

  const resp = JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: ErrorCode.InternalError,
      message: 'Internal error',
    },
  } satisfies JSONRPCErrorResponse)

  return new Response(resp, {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  })
}

function unauthorizedError(
  baseUrl: URL,
  namespace: string,
  subdomain?: string
) {
  const baseUrlClone = new URL(baseUrl)
  let pathname = `/${namespace}/mcp`

  if (subdomain) {
    baseUrlClone.hostname = `${subdomain}.${baseUrlClone.hostname}`
    pathname = '/mcp'
  }

  const metadataUrl = new URL(
    `/.well-known/oauth-protected-resource${pathname}`,
    // use baseUrl instead of requestUrl because hono's request listener uses
    // the socket (whether tls or not) to determine the protocol for the request.url
    // property. When behind a proxy, that doesn't reqlly work, so we have to
    // use the manually configured baseUrl instead.
    baseUrlClone
  )

  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'Content-Type': 'text/plain',
      'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl.toString()}"`,
    },
  })
}

function notFoundError() {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function getMcpRouteHandler(
  baseUrl: URL,
  tokenSvc: TokenService,
  servers: Map<string, McpServer>,
  rateLimiters?: Map<string, McpRateLimiter>
): RequestHandler {
  const getAccessToken = async (
    request: Request,
    namespace: string,
    subdomain?: string
  ) => {
    const authHeader = request.headers.get('authorization')

    const match = authHeader?.match(/^Bearer\s+(.+)$/i)
    if (!match) throw unauthorizedError(baseUrl, namespace, subdomain)

    const [, token] = match
    try {
      return await tokenSvc.unwrapAccessToken(namespace, token)
    } catch (error) {
      logger.error({ error, namespace }, 'error verifying access token')
      throw unauthorizedError(baseUrl, namespace, subdomain)
    }
  }

  const handler = async (request: Request, { incoming }: ExpressBindings) => {
    const namespace = incoming.params.namespace as string
    if (!namespace) return notFoundError()

    const server = servers.get(namespace)
    if (!server) return notFoundError()

    let token: AccessTokenPayload | undefined
    if (server.requiresAuth) {
      token = await getAccessToken(request, namespace, incoming.subdomain)
    }

    const rateLimiter = rateLimiters?.get(namespace)
    return await server.handleRequest(request, token, rateLimiter)
  }

  return getRequestListener(handler as FetchCallback, {
    hostname: baseUrl.hostname,
    overrideGlobalObjects: false,
    errorHandler: error => {
      // allow throwing a response to return early
      if (error instanceof Response) {
        logger.warn(
          { status: error.status },
          'returning early thrown response from mcp route handler'
        )
        return error
      }

      return internalError(error)
    },
  })
}
