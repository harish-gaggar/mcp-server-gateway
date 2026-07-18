import ms from 'ms'
import { z } from 'zod/v4'
import {
  Router,
  json,
  urlencoded,
  type Application,
  type RequestHandler,
} from 'express'
import { randomNonce, calculatePKCECodeChallenge } from 'openid-client'
import { startCase } from 'es-toolkit'

import { TOKEN_EXCHANGE_GRANT } from '~/constants'
import baseLogger from '~/logger'
import {
  AuthorizationRequest,
  ClientRegistrationRequest,
  AuthorizationCodeTokenRequest,
  RefreshTokenRequest,
  TokenExchangeRequest,
  TokenError,
  AuthorizationError,
  TokenIntrospectionRequest,
} from '~/oauth/spec'
import type {
  ClientMetadataHandler,
  ClientMetadata,
  DynamicClientHandler,
} from '~/client-handlers'
import type { McpServer } from '~/mcp'
import type { TokenService } from '~/oauth/token'
import type { Provider } from '~/oauth/provider'

import { clientAuth } from './middleware'
import {
  parseBody,
  parseNamespace,
  getOAuthErrorHandler,
  getConsentKey,
  getNonceKey,
} from './helpers'

const logger = baseLogger.child({ component: 'oauth-router' })

const TokenRequest = z.union([
  AuthorizationCodeTokenRequest,
  RefreshTokenRequest,
  TokenExchangeRequest,
  z.object({ grant_type: z.string() }),
])

async function normalizeAuthRequest(request: AuthorizationRequest) {
  if (request.code_challenge_method === 'S256') return request

  // if code_challenge_method isn't S256, we'll force it to be
  const code_challenge = await calculatePKCECodeChallenge(
    request.code_challenge
  )

  return { ...request, code_challenge, code_challenge_method: 'S256' }
}

function getRedirectUri(metadata: ClientMetadata, redirectUri?: string) {
  if (redirectUri) return redirectUri
  if (metadata.redirect_uris.length === 1) {
    return metadata.redirect_uris[0]
  }

  throw new AuthorizationError(
    'redirect_uri is required when multiple redirect URIs are registered',
    'invalid_request'
  )
}

export type OauthRouterOptions = {
  clientSvc: ClientMetadataHandler
  dynamicClientSvc?: DynamicClientHandler | null
  tokenSvc: TokenService
  baseUrl: URL
  servers: Map<string, McpServer>
  oauthTokenLimiter?: RequestHandler | null
}

export function addOauthRoutes(
  app: Application,
  {
    clientSvc,
    dynamicClientSvc,
    tokenSvc,
    servers,
    baseUrl,
    oauthTokenLimiter,
  }: OauthRouterOptions
) {
  const router = Router({ mergeParams: true })

  if (dynamicClientSvc) {
    router.post('/register', json(), async (req, res) => {
      const body = parseBody(ClientRegistrationRequest, req.body)

      const { namespace } = parseNamespace(servers, req, res)
      const result = await dynamicClientSvc.register(namespace, body)

      res.status(201).json(result)
    })
  }

  router.get('/authorize', async (req, res) => {
    const { namespace, provider, mcpServer } = parseNamespace(servers, req, res)

    const body = await normalizeAuthRequest(
      parseBody(AuthorizationRequest, req.query)
    )

    const metadata = await clientSvc.loadClientMetadata(
      namespace,
      body.client_id,
      body.redirect_uri
    )

    const redirect_uri = getRedirectUri(metadata, body.redirect_uri)
    const consentKey = getConsentKey(
      namespace,
      provider.name,
      metadata.client_id
    )
    const hasConsent = req.cookies[consentKey] === 'true'
    if (!hasConsent) {
      // render consent page to prompt the user to approve the authorization request
      const hiddenInputs = Object.entries(body).map(([name, value]) => ({
        name,
        value,
      }))

      return res.render('oauth-consent', {
        client: metadata,
        mcp_name: startCase(mcpServer.name),
        scopes: mcpServer.scope,
        provider_name: startCase(provider.name),
        hiddenInputs,
        redirect_uri: body.redirect_uri,
      })
    }

    // if the user has consent, redirect to authorize url
    try {
      const nonce = randomNonce()
      const state = await tokenSvc.wrapState({
        namespace,
        provider: provider.name,
        client_id: metadata.client_id,
        client_state: body.state,
        redirect_uri,
        nonce,
        scope_hash: mcpServer.scopeHash(),
      })

      const authUrl = provider.buildAuthUrl(
        state,
        body.code_challenge,
        mcpServer.config.scope
      )

      const nonceKey = getNonceKey(namespace, provider.name, metadata.client_id)
      res.cookie(nonceKey, nonce, {
        domain:
          baseUrl.hostname !== 'localhost' ? `.${baseUrl.hostname}` : undefined,
        httpOnly: true,
        // Secure cookies are dropped by browsers over http://localhost, which
        // would break local dev. Only require Secure when served over https.
        secure: baseUrl.protocol === 'https:',
        sameSite: 'lax',
        maxAge: ms('15m'),
      })

      res.redirect(302, authUrl.toString())
    } catch (error) {
      // catch errors here so we can redirect
      logger.error({ error }, 'Error during authorization request')

      //
      throw new AuthorizationError(
        'An error occurred while processing the authorization request',
        'server_error',
        redirect_uri
      )
    }
  })

  const AuthorizePostRequest = AuthorizationRequest.extend({
    // add "consent" field based on which button the user clicks
    consent: z.enum(['approved', 'denied']),
  })

  router.post('/authorize', urlencoded(), async (req, res) => {
    const { consent, ...body } = parseBody(AuthorizePostRequest, req.body)
    const { namespace, provider } = parseNamespace(servers, req, res)
    const metadata = await clientSvc.loadClientMetadata(
      namespace,
      body.client_id,
      body.redirect_uri
    )

    const redirect_uri = getRedirectUri(metadata, body.redirect_uri)
    if (consent === 'denied') {
      throw new AuthorizationError(
        'User denied consent',
        'access_denied',
        redirect_uri
      )
    }

    // set a cookie to remember the user's consent for future requests
    const consentKey = getConsentKey(
      namespace,
      provider.name,
      metadata.client_id
    )
    res.cookie(consentKey, 'true', {
      domain:
        baseUrl.hostname !== 'localhost' ? `.${baseUrl.hostname}` : undefined,
      httpOnly: true,
      // See note above: only require Secure when served over https.
      secure: baseUrl.protocol === 'https:',
      sameSite: 'lax',
      maxAge: ms('30d'),
    })

    // redirect back to GET endpoint
    const queryParams = new URLSearchParams(body)
    res.redirect(302, `authorize?${queryParams.toString()}`)
  })

  async function authCodeHandler(
    provider: Provider,
    body: AuthorizationCodeTokenRequest,
    namespace: string,
    clientId: string
  ) {
    const codeData = await tokenSvc.unwrapAuthCode(namespace, body.code)
    if (
      codeData.provider !== provider.name ||
      codeData.client_id !== clientId
    ) {
      throw new TokenError(
        'Authorization code is invalid for this client or provider',
        'invalid_grant'
      )
    }

    const tokenResp = await provider.authCodeGrant(
      { ...body, code: codeData.code },
      codeData.auth_iss
    )
    const userId = await provider.getUserId(tokenResp.access_token)

    return await tokenSvc.wrapTokenResponse(
      namespace,
      {
        provider: provider.name,
        client_id: clientId,
        scope_hash: codeData.scope_hash,
      },
      tokenResp,
      userId
    )
  }

  async function refreshTokenHandler(
    provider: Provider,
    mcpServer: McpServer,
    body: RefreshTokenRequest,
    namespace: string,
    clientId: string
  ) {
    if (!provider.canRefresh) {
      throw new TokenError(
        'This provider does not support refresh tokens.',
        'unsupported_grant_type'
      )
    }

    const tokenData = await tokenSvc.unwrapRefreshToken(
      namespace,
      body.refresh_token
    )
    if (
      tokenData.provider !== provider.name ||
      tokenData.client_id !== clientId
    ) {
      throw new TokenError(
        'Refresh token is invalid for this client or provider',
        'invalid_grant'
      )
    }

    const currentScopeHash = mcpServer.scopeHash()
    if (currentScopeHash !== tokenData.scope_hash) {
      throw new TokenError(
        'Required scopes have changed since this token was issued. Please re-authorize.',
        'invalid_grant'
      )
    }

    const tokenResp = await provider.refreshTokenGrant({
      ...body,
      refresh_token: tokenData.refresh_token,
    })

    const userId = await provider.getUserId(tokenResp.access_token)

    // some OAuth providers don't regenerate a refresh token each time, so
    // if that's the case we need to return the existing refresh token to the client,
    // otherwise the client would lose the ability to refresh in the future
    if (!tokenResp.refresh_token) {
      tokenResp.refresh_token = tokenData.refresh_token
    }

    return await tokenSvc.wrapTokenResponse(
      namespace,
      {
        provider: provider.name,
        client_id: clientId,
        scope_hash: tokenData.scope_hash,
      },
      tokenResp,
      userId
    )
  }

  async function tokenExchangeHandler(
    provider: Provider,
    mcpServer: McpServer,
    body: TokenExchangeRequest,
    namespace: string,
    clientId: string
  ) {
    if (!provider.canExchange) {
      throw new TokenError(
        'This provider does not support token exchange.',
        'unsupported_grant_type'
      )
    }

    const [expiry, userId] = await Promise.all([
      provider.getTokenExpiry(body.subject_token),
      provider.getUserId(body.subject_token),
    ])

    const expires_in = Math.floor((expiry * 1000 - Date.now()) / 1000)
    if (expires_in <= 0) {
      throw new TokenError('Subject token is expired', 'invalid_grant')
    }

    return await tokenSvc.wrapTokenResponse(
      namespace,
      {
        provider: provider.name,
        client_id: clientId,
        scope_hash: mcpServer.scopeHash(),
      },
      { access_token: body.subject_token, token_type: 'Bearer', expires_in },
      userId
    )
  }

  const tokenMiddleware: RequestHandler[] = [urlencoded(), clientAuth(true)]
  if (oauthTokenLimiter) tokenMiddleware.push(oauthTokenLimiter)

  router.post('/token', ...tokenMiddleware, async (req, res) => {
    if (!req.clientAuth) {
      return res.status(400).json({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      })
    }

    const { namespace, provider, mcpServer } = parseNamespace(servers, req, res)
    const body = parseBody(TokenRequest, req.body)

    const metadata = await clientSvc.validateClientAuth(
      namespace,
      req.clientAuth.clientId,
      req.clientAuth.clientSecret
    )

    if (
      metadata.grant_types &&
      !metadata.grant_types.includes(body.grant_type)
    ) {
      throw new TokenError(
        `The client is not authorized to use the ${body.grant_type} grant type`,
        'unauthorized_client'
      )
    }

    if (body.grant_type === 'authorization_code') {
      const result = await authCodeHandler(
        provider,
        body as AuthorizationCodeTokenRequest,
        namespace,
        metadata.client_id
      )
      return res.json(result)
    }

    if (body.grant_type === 'refresh_token') {
      const result = await refreshTokenHandler(
        provider,
        mcpServer,
        body as RefreshTokenRequest,
        namespace,
        metadata.client_id
      )
      return res.json(result)
    }

    if (body.grant_type === TOKEN_EXCHANGE_GRANT) {
      const result = await tokenExchangeHandler(
        provider,
        mcpServer,
        body as TokenExchangeRequest,
        namespace,
        metadata.client_id
      )
      return res.json(result)
    }

    throw new TokenError(
      `Unsupported grant type: ${body.grant_type}`,
      'unsupported_grant_type'
    )
  })

  router.post(
    '/introspect',
    urlencoded(),
    clientAuth(true),
    async (req, res) => {
      const { provider, namespace } = parseNamespace(servers, req, res)

      if (!req.clientAuth) {
        return res.status(400).json({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        })
      }

      const metadata = await clientSvc.validateClientAuth(
        namespace,
        req.clientAuth.clientId,
        req.clientAuth.clientSecret
      )

      const body = parseBody(TokenIntrospectionRequest, req.body)
      const [payload, result] = await tokenSvc.introspectToken(
        namespace,
        body.token
      )

      if (
        provider.name !== payload.provider ||
        payload.client_id !== metadata.client_id
      ) {
        return res.json({ active: false })
      }

      res.json(result)
    }
  )

  // note: this is here to satisfy the oidc spec, but as we don't issue any ID tokens
  // and our access tokens are opaque to clients, we don't have any keys to expose here.
  // In the future, if we add support for signing tokens, we can implement this
  // endpoint to expose the necessary jwks.
  router.get('/jwks', (_req, res) => {
    res.json({ keys: [] })
  })

  // add 404 handler for any unmatched routes
  router.use((_req, res) => {
    res.status(404).json({
      error: 'not_found',
      error_description: 'The requested endpoint does not exist',
    })
  })

  // add error handling middleware to catch any unhandled errors and return a 500
  router.use(getOAuthErrorHandler(logger))

  app.use('/:namespace/oauth', router)
}
