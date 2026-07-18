import type { z } from 'zod/v4'
import type { ErrorRequestHandler, Request, Response } from 'express'

import type { Logger } from '~/logger'
import type { McpServer } from '~/mcp'
import { OauthError, OAuthErrorResponse } from '~/oauth/spec'

/**
 * Error that can be thrown to short-circuit an express router handler
 * when the request has already been fully handled (e.g. a response has been sent).
 */
export class RequestFinishedError extends Error {
  constructor() {
    super('Request has already been handled')
    this.name = this.constructor.name
  }
}

export function errResponse(
  res: Response,
  status: number,
  data: OAuthErrorResponse
) {
  res.status(status).json(data)
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown) {
  const result = schema.safeParse(body)
  if (!result.success) {
    throw new OauthError('Invalid request body', 'invalid_request', 400)
  }

  return result.data
}

export function getOAuthErrorHandler(logger: Logger): ErrorRequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error, _req, res, _next) => {
    // if the error is an oauth error, use the built-in response handler
    if (error instanceof OauthError) {
      return error.handleResponse(res)
    }

    if (error instanceof RequestFinishedError && res.headersSent) {
      // if the error is a RequestFinishedError and the response has already been sent,
      // we can safely ignore it since it's just a signal to stop further processing
      return
    }

    logger.error({ error }, 'Unhandled error in OAuth router')

    res.status(500).json({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    })
  }
}

export function getConsentKey(
  namespace: string,
  providerName: string,
  clientId: string
) {
  return `consent_${namespace}_${providerName}_${Buffer.from(clientId).toString('base64url')}`
}

export function getNonceKey(
  namespace: string,
  providerName: string,
  clientId: string
) {
  return `nonce_${namespace}_${providerName}_${Buffer.from(clientId).toString('base64url')}`
}

export function parseNamespace(
  servers: Map<string, McpServer>,
  req: Request,
  res: Response
) {
  const namespace = req.params.namespace
  if (!namespace || typeof namespace !== 'string') {
    errResponse(res, 404, {
      error: 'not_found',
      error_description: 'The requested endpoint does not exist',
    })

    throw new RequestFinishedError()
  }

  const mcpServer = servers.get(namespace)
  if (!mcpServer?.requiresAuth) {
    errResponse(res, 404, {
      error: 'not_found',
      error_description: 'The requested endpoint does not exist',
    })

    throw new RequestFinishedError()
  }

  return { namespace, mcpServer, provider: mcpServer.authProvider! }
}
