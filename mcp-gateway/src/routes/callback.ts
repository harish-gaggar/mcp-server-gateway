import { z } from 'zod/v4'
import { type Application } from 'express'

import baseLogger from '~/logger'
import { OAUTH_CALLBACK_ENDPOINT } from '~/constants'
import { McpServer } from '~/mcp'
import { AuthorizationError } from '~/oauth/spec'
import { TokenService } from '~/oauth/token'

import { getOAuthErrorHandler, parseBody, getNonceKey } from './helpers'

const CallbackSuccessResponse = z.object({
  code: z.string().nonempty(),
  state: z.string().nonempty(),
  iss: z.string().optional(),
})

const CallbackErrorResponse = z.object({
  error: z.string(),
  error_description: z.string().optional(),
})

const CallbackResponse = z.union([
  CallbackSuccessResponse,
  CallbackErrorResponse,
])

const logger = baseLogger.child({ route: 'callback' })

export type CallbackRouteOptions = {
  tokenSvc: TokenService
  servers: Map<string, McpServer>
}

export function addCallbackRoute(
  app: Application,
  { tokenSvc, servers }: CallbackRouteOptions
) {
  app.get(OAUTH_CALLBACK_ENDPOINT, async (req, res) => {
    const query = parseBody(CallbackResponse, req.query)
    if ('error' in query) {
      // todo: show error page
      res.status(400).json(query)
      return
    }

    const { code, state, iss } = query
    const {
      namespace,
      provider,
      client_id,
      nonce,
      redirect_uri,
      client_state,
      scope_hash,
    } = await tokenSvc.unwrapState(state)
    const server = servers.get(namespace)

    if (!server || provider !== server.authProvider?.name) {
      throw new AuthorizationError(
        'invalid state returned from authorization server',
        'invalid_request'
      )
    }

    const nonceKey = getNonceKey(namespace, provider, client_id)
    if (nonce !== req.cookies[nonceKey]) {
      throw new AuthorizationError(
        'invalid state returned from authorization server',
        'invalid_request'
      )
    }

    const wrappedCode = await tokenSvc.wrapAuthCode(namespace, {
      provider,
      client_id,
      scope_hash,
      code,
      auth_iss: iss,
    })

    const redirectUrl = new URL(redirect_uri)
    redirectUrl.searchParams.set('code', wrappedCode)
    if (client_state) {
      redirectUrl.searchParams.set('state', client_state)
    }

    return res.redirect(302, redirectUrl.toString())
  })

  app.use(OAUTH_CALLBACK_ENDPOINT, getOAuthErrorHandler(logger))
}
