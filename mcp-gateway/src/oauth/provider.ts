import { z } from 'zod/v4'
import * as client from 'openid-client'
import { get } from 'es-toolkit/compat'

import baseLogger from '~/logger'
import { duration, httpsUrl, scope, withEnabled } from '~/zod-utils'
import {
  OAUTH_CALLBACK_ENDPOINT,
  GOOGLE_TOKEN_INFO_ENDPOINT,
  GOOGLE_ISSUER,
  GITHUB_EXPIRATION_HDR,
} from '~/constants'

import {
  AuthorizationCodeTokenRequest,
  TokenResponse,
  RefreshTokenRequest,
  TokenError,
  OauthError,
} from './spec'

const TokenExchangeSchema = withEnabled(
  z.object({
    // method by which the exchange function should determine the expiry of the underlying exchanged token
    // if 'none', the gateway will not determine token expiry and will use the default expiry set
    // on the token service
    token_exp_method: z
      .enum(['none', 'introspection', 'google', 'github'])
      .default('none'),

    // default ttl to use if the expiry time can't be found in the token itself
    default_ttl: duration.prefault('1d'),
  })
)

const BaseOauthSchema = z.object({
  client_id: z.string().nonempty(),
  client_secret: z.string().nonempty().optional(),
  // note: for manual oauth implementations this is not necessarily the issuer url
  // but it is used as the base url for discovery in oidc implementations,
  // so we require it for all providers for consistency
  issuer: httpsUrl,
  scope,
  extra_params: z.record(z.string(), z.string()).optional(),
  // whether or not to allow clients to use their own valid oauth tokens
  // and use them with the gateway via token exchange
  token_exchange: TokenExchangeSchema.default({ enabled: false }),
})

const OauthOidcSchema = BaseOauthSchema.extend({
  oidc: z.literal(true),
  // the claim in the token to use as the user id, defaults to 'sub' which is
  // the standard claim for the subject of the token
  user_id_claim: z.string().default('sub'),
})

const OauthUserInfo = z.object({
  // endpoint to hit with the fetched access token. It is assumed that the
  // response will be JSON, and that the user id will be in the field specified by
  // userIdField
  url: httpsUrl,
  // the field in the userinfo response to use as the user id
  // Uses lodash get to allow for nested fields (e.g. "data.id")
  user_id_field: z.string().nonempty(),
})

type OauthUserInfo = z.infer<typeof OauthUserInfo>

// for non-oidc providers, we require the auth and token urls to be provided
const OauthManualSchema = BaseOauthSchema.extend({
  oidc: z.literal(false).default(false),
  auth_url: httpsUrl,
  token_url: httpsUrl,
  // whether or not this oauth provider supports refresh tokens
  supports_refresh: z.boolean().default(false),
  // information to fetch userinfo for non-oidc providers
  user_info: OauthUserInfo.optional(),
})

export const OauthConfig = z.discriminatedUnion('oidc', [
  OauthOidcSchema,
  OauthManualSchema,
])

export type OauthConfig = z.infer<typeof OauthConfig>

async function loadClientConfig(
  config: OauthConfig
): Promise<client.Configuration> {
  if (config.oidc) {
    // server supports oidc, use auto-discovery to determine configuration
    const issuer = new URL(config.issuer)
    return await client.discovery(
      issuer,
      config.client_id,
      config.client_secret
    )
  }

  const meta: client.ServerMetadata = {
    issuer: config.issuer,
    authorization_endpoint: config.auth_url,
    token_endpoint: config.token_url,
    // note: assume the scopes passed in config are all supported by the server
    scopes_supported: config.scope,
    response_types_supported: ['code'], // we only use code
    grant_types_supported: [
      'authorization_code',
      ...(config.supports_refresh ? ['refresh_token'] : []),
    ],
  }

  return new client.Configuration(meta, config.client_id, config.client_secret)
}

const logger = baseLogger.child({ module: 'oauth-provider' })

export class Provider {
  #name: string
  #config: OauthConfig
  #clientConfig: client.Configuration
  #redirectUri: URL

  constructor(
    name: string,
    config: OauthConfig,
    clientConfig: client.Configuration,
    redirectUri: URL
  ) {
    this.#name = name
    this.#config = config
    this.#clientConfig = clientConfig
    this.#redirectUri = redirectUri

    this.#validateExchange()
  }

  #validateExchange() {
    if (!this.#config.token_exchange.enabled) return

    const method = this.#config.token_exchange.token_exp_method
    if (
      method === 'introspection' &&
      (!this.#config.oidc ||
        !this.#clientConfig.serverMetadata().introspection_endpoint)
    ) {
      throw new Error(
        'Token introspection is only supported for OIDC providers with an introspection_endpoint set.'
      )
    }
  }

  get name(): string {
    return this.#name
  }

  get canRefresh(): boolean {
    const { grant_types_supported = [] } = this.#clientConfig.serverMetadata()
    return this.#config.oidc
      ? grant_types_supported.includes('refresh_token')
      : this.#config.supports_refresh
  }

  get canExchange(): boolean {
    return this.#config.token_exchange.enabled
  }

  get scope(): string {
    return this.#config.scope.join(' ')
  }

  buildAuthUrl(state: string, code_challenge: string, scopes?: string[]) {
    return client.buildAuthorizationUrl(this.#clientConfig, {
      state,
      redirect_uri: this.#redirectUri.toString(),
      scope: (scopes ?? this.#config.scope).join(' '),
      code_challenge,
      code_challenge_method: 'S256',
      ...this.#config.extra_params,
    })
  }

  /**
   * Performs an authorization code grant using the supplied request info
   */
  async authCodeGrant(
    req: AuthorizationCodeTokenRequest,
    iss?: string
  ): Promise<TokenResponse> {
    const currentUrl = new URL(this.#redirectUri)
    currentUrl.searchParams.set('code', req.code)
    if (iss) currentUrl.searchParams.set('iss', iss)

    try {
      const result = await client.authorizationCodeGrant(
        this.#clientConfig,
        currentUrl,
        { pkceCodeVerifier: req.code_verifier }
      )

      return {
        access_token: result.access_token,
        expires_in: result.expires_in,
        refresh_token: result.refresh_token,
        scope: result.scope,
        token_type: 'Bearer',
        id_token: result.id_token,
      }
    } catch (error) {
      logger.error({ error }, 'error requesting access token')
      if (error instanceof client.ResponseBodyError) {
        throw new OauthError(
          error.error_description ?? 'unknown error',
          error.error
        )
      }

      throw new TokenError(
        'An unexpected error occurred while processing the token request.',
        'server_error'
      )
    }
  }

  /**
   * Performs a refresh token grant using the provided refresh token
   */
  async refreshTokenGrant(req: RefreshTokenRequest): Promise<TokenResponse> {
    if (!this.canRefresh) {
      throw new TokenError(
        'This provider does not support refresh tokens.',
        'unsupported_grant_type'
      )
    }

    try {
      const result = await client.refreshTokenGrant(
        this.#clientConfig,
        req.refresh_token
      )

      return {
        access_token: result.access_token,
        expires_in: result.expires_in,
        refresh_token: result.refresh_token,
        scope: result.scope,
        token_type: 'Bearer',
        id_token: result.id_token,
      }
    } catch (error) {
      logger.error({ error }, 'error refreshing access token')

      if (error instanceof client.ResponseBodyError) {
        throw new OauthError(
          error.error_description ?? 'unknown error',
          error.error
        )
      }

      throw new TokenError(
        'An unexpected error occurred while processing the token request.',
        'server_error'
      )
    }
  }

  async #getUserIdFromClaim(token: string, claim: string) {
    try {
      const result = await client.fetchUserInfo(
        this.#clientConfig,
        token,
        client.skipSubjectCheck
      )

      const userId = result[claim]
      return userId && typeof userId === 'string' ? userId : null
    } catch (error) {
      logger.error({ error }, 'error fetching user info')

      // if the token is invalid or expired, we return null so that the token can be rejected
      if (error instanceof client.WWWAuthenticateChallengeError) {
        throw new TokenError('invalid or expired token', 'invalid_request')
      }

      // for other errors, we throw to indicate a problem with the provider or network
      throw new TokenError(
        'An unexpected error occurred while fetching user info.',
        'server_error'
      )
    }
  }

  async #getUserIdFromUserInfo(token: string, userInfo: OauthUserInfo) {
    try {
      const resp = await fetch(userInfo.url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (resp.status === 401) {
        throw new TokenError('invalid or expired token', 'invalid_request')
      }

      if (!resp.ok) {
        logger.error(
          { status: resp.status, statusText: resp.statusText },
          'unexpected response fetching user info'
        )

        throw new TokenError(
          'An unexpected error occurred while fetching user info.',
          'server_error'
        )
      }

      const json = await resp.json()
      const userId = get(json, userInfo.user_id_field, null)

      return userId && typeof userId === 'string' ? userId : null
    } catch (error) {
      if (error instanceof TokenError) {
        throw error
      }

      logger.error({ error }, 'error fetching user info')
      throw new TokenError(
        'An unexpected error occurred while fetching user info.',
        'server_error'
      )
    }
  }

  /**
   * Gets the user id from the access token given the provider's configuration
   */
  getUserId(token: string) {
    if (this.#config.oidc) {
      const claim = this.#config.user_id_claim
      return this.#getUserIdFromClaim(token, claim)
    }

    if (this.#config.user_info) {
      return this.#getUserIdFromUserInfo(token, this.#config.user_info)
    }

    return null
  }

  // for google oauth providers, we can get token info (including expiration)
  // from the tokeninfo endpoint. Not great to hardcode this, but setting it
  // via configuration is a lot more complicated and probably unnecessary
  async #getGoogleTokenExpiry(token: string) {
    if (!this.#config.oidc || this.#config.issuer !== GOOGLE_ISSUER) {
      throw new TokenError(
        'Token info endpoint is only supported for Google OAuth providers.',
        'unsupported_grant_type'
      )
    }

    const url = new URL(GOOGLE_TOKEN_INFO_ENDPOINT)
    url.searchParams.set('access_token', token)

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })

      if (resp.status === 400) {
        throw new TokenError('invalid or expired token', 'invalid_request')
      }

      if (!resp.ok) {
        logger.error(
          { status: resp.status, statusText: resp.statusText },
          'unexpected response fetching token info'
        )
        throw new TokenError(
          'An unexpected error occurred while fetching token info.',
          'server_error'
        )
      }

      const json = await resp.json()
      if (json.error_description) {
        throw new TokenError(json.error_description, 'invalid_request')
      }

      const exp = parseInt(json.exp ?? '', 10)
      if (!exp || Number.isNaN(exp)) {
        logger.error({ response: json }, 'invalid token info response')
        throw new TokenError(
          'An unexpected error occurred while fetching token info.',
          'server_error'
        )
      }

      return exp
    } catch (error) {
      if (error instanceof TokenError) {
        throw error
      }

      logger.error({ error }, 'error fetching token info')
      throw new TokenError(
        'An unexpected error occurred while fetching token info.',
        'server_error'
      )
    }
  }

  async #getIntrospectionTokenExpiry(token: string) {
    if (!this.#config.oidc) {
      throw new TokenError(
        'Introspection endpoint is only supported for OIDC providers.',
        'unsupported_grant_type'
      )
    }

    const serverMeta = this.#clientConfig.serverMetadata()
    if (!serverMeta.introspection_endpoint) {
      throw new TokenError(
        'This provider does not support token introspection.',
        'unsupported_grant_type'
      )
    }

    try {
      const introspection = await client.tokenIntrospection(
        this.#clientConfig,
        token
      )
      if (!introspection.active) {
        throw new TokenError('invalid or expired token', 'invalid_request')
      }

      const exp = introspection.exp
      if (!exp || typeof exp !== 'number') {
        logger.error(
          { response: introspection },
          'invalid introspection response'
        )
        throw new TokenError(
          'An unexpected error occurred while introspecting the token.',
          'server_error'
        )
      }

      return exp
    } catch (error) {
      if (error instanceof TokenError) {
        throw error
      }

      logger.error({ error }, 'error introspecting token')
      throw new TokenError(
        'An unexpected error occurred while introspecting the token.',
        'server_error'
      )
    }
  }

  async #getGithubTokenExpiry(token: string) {
    // note: we assume here that the configured issuer is the base url of the
    // GHE instance.
    const ghUrl = new URL('/api/v3/user', this.#config.issuer)
    let resp: Response
    try {
      resp = await fetch(ghUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      })
    } catch (error) {
      logger.error({ error }, 'error fetching user info from github')
      throw new TokenError(
        'An unexpected error occurred while fetching user info.',
        'server_error'
      )
    }

    if (resp.status === 401) {
      throw new TokenError('invalid or expired token', 'invalid_request')
    }

    if (!resp.ok) {
      logger.error(
        { status: resp.status, statusText: resp.statusText },
        'unexpected response fetching user info from github'
      )
      throw new TokenError(
        'An unexpected error occurred while fetching user info.',
        'server_error'
      )
    }

    const exp = new Date(
      resp.headers.get(GITHUB_EXPIRATION_HDR) || 'invalid'
    ).getTime()

    return Number.isNaN(exp) ? null : Math.floor(exp / 1000)
  }

  /**
   * Gets the expiration time of the access token, depending on how the provider
   * is configured to determine token expiry. If the provider is not configured
   * for token exchange or if token expiry cannot be determined,
   * this will return null and the gateway will use the default expiry set on
   * the token service.
   */
  async getTokenExpiry(token: string) {
    if (!this.#config.token_exchange.enabled) {
      throw new TokenError(
        'Token expiry is only available for providers that support token exchange.',
        'unsupported_grant_type'
      )
    }

    const { token_exp_method, default_ttl } = this.#config.token_exchange
    let expiry: number | null = null

    switch (token_exp_method) {
      case 'google':
        expiry = await this.#getGoogleTokenExpiry(token)
        break
      case 'introspection':
        expiry = await this.#getIntrospectionTokenExpiry(token)
        break
      case 'github':
        expiry = await this.#getGithubTokenExpiry(token)
        break
    }

    return expiry ?? Math.floor((Date.now() + default_ttl) / 1000)
  }
}

/**
 * Gets the openid client configuration either via OIDC discovery or via
 * manual configuration
 */
async function loadProvider(
  name: string,
  config: OauthConfig,
  baseUrl: string | URL
): Promise<Provider> {
  const clientConfig = await loadClientConfig(config)
  return new Provider(
    name,
    config,
    clientConfig,
    new URL(OAUTH_CALLBACK_ENDPOINT, baseUrl)
  )
}

export async function loadProviders(
  rawConfigs: Record<string, OauthConfig>,
  baseUrl: string | URL
): Promise<Map<string, Provider>> {
  const entries = await Promise.all(
    Object.entries(rawConfigs).map(
      async ([name, config]) =>
        [name, await loadProvider(name, config, baseUrl)] as const
    )
  )

  return new Map(entries)
}
