import { z } from 'zod/v4'
import { randomUUID } from 'node:crypto'
import {
  EncryptJWT,
  jwtDecrypt,
  errors,
  type JWTDecryptOptions,
  type JWTPayload,
} from 'jose'
import ms from 'ms'
import Redis from 'ioredis'
import { pick } from 'es-toolkit'

import baseLogger from '~/logger'
import { duration } from '~/zod-utils'

import {
  TokenResponse,
  TokenError,
  OauthError,
  TokenIntrospectionResponse,
} from './spec'

const keySecret = z
  .base64()
  .nonempty()
  .transform((val, ctx) => {
    const key = Buffer.from(val, 'base64')
    if (key.length < 32) {
      ctx.issues.push({
        code: 'invalid_format',
        format: 'base64',
        message: 'Key must be at least 32 bytes',
        input: val,
      })

      return z.NEVER
    }

    return key
  })

export const TokenConfig = z.object({
  // used as the "iss" claim in the tokens
  issuer: z.string().nonempty().default('urn:mcp-gateway:tokens'),

  // encryption key for the JWE tokens. Supports a single encryption key,
  // or a list of keys with ids and values. Keys should be base64-encoded and
  // at least 32 bytes. If a list is provided, the first entry will be used for
  // encryption, and all keys will be considered for decryption (to allow for key rotation).
  encryption_key: z.union([
    keySecret.transform(k => [{ id: 'default', key: k }]),
    z.object({ id: z.string().nonempty(), key: keySecret }).array().nonempty(),
  ]),

  // how long state parameters should be valid for. Should be long enough to allow
  // the user to complete the authorization process, but short enough to limit
  // the window for abuse if a state parameter is leaked.
  state_ttl: duration.prefault('15m'),

  // How long authorization codes should be valid for. Should be long enough to allow the user to complete the authorization process,
  // but short enough to limit the window for abuse if an auth code is leaked. 5 minutes is a common choice.
  auth_code_ttl: duration.prefault('5m'),

  // default TTL for access tokens if not passed in
  access_token_ttl: duration.prefault('1h'),
})

export type TokenConfig = z.infer<typeof TokenConfig>

const gatewayTokenTyp = 'mcp-gateway+jwe'
// default jti use tracking is 1 day
const defaultJtiExp = ms('1d')

function audience(namespace: string, type: string) {
  return `urn:mcp-gateway:${namespace}:${type}`
}

const BasePayload = z.object({
  provider: z.string().nonempty(),
  client_id: z.string().nonempty(),
  scope_hash: z.string().nonempty().optional(),
})

export type BasePayload = z.infer<typeof BasePayload>

export const StatePayload = BasePayload.extend({
  // because the state payload is handled by the generic oauth callback endpoint
  // (which doesn't have a built-in routing namespace) we need to pass the namespace
  // into the state value directly
  namespace: z.string().nonempty(),
  client_state: z.string().optional(),
  redirect_uri: z.string().nonempty(),
  nonce: z.string().nonempty(),
})

export type StatePayload = z.infer<typeof StatePayload>

export const AuthCodePayload = BasePayload.extend({
  code: z.string().nonempty(),
  // if the auth server returns the issuer in the auth redirect, we need
  // to pass that along
  auth_iss: z.string().optional(),
})

export type AuthCodePayload = z.infer<typeof AuthCodePayload>

export const AccessTokenPayload = BasePayload.extend({
  access_token: z.string().nonempty(),
  user_id: z.string().nullable(),
  // optional OIDC id_token, forwarded upstream when a server sets forward_id_token
  id_token: z.string().nonempty().optional(),
})

export type AccessTokenPayload = z.infer<typeof AccessTokenPayload>

export const RefreshTokenPayload = BasePayload.extend({
  refresh_token: z.string().nonempty(),
})

export type RefreshTokenPayload = z.infer<typeof RefreshTokenPayload>

const logger = baseLogger.child({ module: 'TokenService' })

/**
 * Class that handles token encryption/decryption operations for the various types of
 * tokens/codes (access tokens, refresh tokens, etc). Uses JWE encryption via the `jose` library.
 */
export class TokenService {
  #redis: Redis
  #config: TokenConfig

  constructor(redis: Redis, config: TokenConfig) {
    this.#redis = redis
    this.#config = config
  }

  #encrypt(jwt: EncryptJWT) {
    const [{ id, key }] = this.#config.encryption_key

    return jwt
      .setProtectedHeader({
        alg: 'dir',
        enc: 'A256GCM',
        kid: id,
        typ: gatewayTokenTyp,
      })
      .setIssuer(this.#config.issuer)
      .setIssuedAt()
      .setJti(randomUUID())
      .encrypt(key)
  }

  #decrypt(token: string, opts?: JWTDecryptOptions) {
    return jwtDecrypt(
      token,
      hdr => {
        if (hdr.typ !== gatewayTokenTyp) {
          throw new Error('Invalid token type')
        }

        const keyEntry = this.#config.encryption_key.find(k => k.id === hdr.kid)
        if (!keyEntry) {
          throw new Error('No matching key found for token')
        }

        return keyEntry.key
      },
      { issuer: this.#config.issuer, typ: gatewayTokenTyp, ...opts }
    )
  }

  async #checkJtiReplay(payload: JWTPayload) {
    const jti = payload.jti
    if (!jti) {
      throw new TokenError('missing jti claim', 'invalid_grant')
    }

    const key = `jti:${jti}`
    const exists = await this.#redis.exists(key)
    if (exists) {
      throw new TokenError('token has already been used', 'invalid_grant')
    }

    if (payload.exp) {
      await this.#redis.set(key, 'used', 'EXAT', payload.exp)
    } else {
      await this.#redis.set(key, 'used', 'PX', defaultJtiExp)
    }
  }

  wrapState(payload: StatePayload) {
    const expDate = new Date(Date.now() + this.#config.state_ttl)
    const jwt = new EncryptJWT(payload).setExpirationTime(expDate)

    return this.#encrypt(jwt)
  }

  async unwrapState(state: string) {
    try {
      const { payload } = await this.#decrypt(state, {
        requiredClaims: [
          'provider',
          'client_id',
          'namespace',
          'redirect_uri',
          'nonce',
        ],
      })

      return StatePayload.parse(payload)
    } catch (error) {
      logger.error({ error }, 'error decrypting state token')
      throw new OauthError('invalid state data', 'invalid_state')
    }
  }

  /**
   * Wraps a destination auth code in an encrypted gateway jwt.
   */
  wrapAuthCode(namespace: string, payload: AuthCodePayload) {
    const expDate = new Date(Date.now() + this.#config.auth_code_ttl)
    const jwt = new EncryptJWT(payload)
      .setAudience(audience(namespace, 'auth_code'))
      .setExpirationTime(expDate)

    return this.#encrypt(jwt)
  }

  /**
   * Decrypts and validates a gateway JWT, returning the contained auth code and destination provider if valid.
   */
  async unwrapAuthCode(namespace: string, code: string) {
    try {
      const { payload } = await this.#decrypt(code, {
        audience: audience(namespace, 'auth_code'),
        requiredClaims: ['jti', 'provider', 'client_id', 'code'],
      })

      await this.#checkJtiReplay(payload)

      return AuthCodePayload.parse(payload)
    } catch (error) {
      if (error instanceof TokenError) {
        throw error
      }

      logger.error({ error }, 'error decrypting auth code token')
      throw new OauthError('invalid authorization code', 'invalid_grant')
    }
  }

  /**
   * Wraps a destination token response in encrypted gateway JWTs for the access
   * and refresh tokens (if present).
   */
  async wrapTokenResponse(
    namespace: string,
    basePayload: BasePayload,
    tokenResponse: TokenResponse,
    userId: string | null
  ) {
    const expDate = tokenResponse.expires_in
      ? new Date(Date.now() + tokenResponse.expires_in * 1000)
      : new Date(Date.now() + this.#config.access_token_ttl)

    const expires_in =
      tokenResponse.expires_in ??
      Math.floor((expDate.getTime() - Date.now()) / 1000)

    const accessPayload: AccessTokenPayload = {
      ...basePayload,
      access_token: tokenResponse.access_token,
      user_id: userId,
      id_token: tokenResponse.id_token,
    }
    const accessJwt = new EncryptJWT(accessPayload)
      .setAudience(audience(namespace, 'access_token'))
      .setExpirationTime(expDate)

    const refreshPayload: RefreshTokenPayload | null =
      tokenResponse.refresh_token
        ? {
            ...basePayload,
            refresh_token: tokenResponse.refresh_token,
          }
        : null
    const refreshJwt = refreshPayload
      ? new EncryptJWT(refreshPayload).setAudience(
          audience(namespace, 'refresh_token')
        )
      : null

    const [accessToken, refreshToken] = await Promise.all([
      this.#encrypt(accessJwt),
      refreshJwt && this.#encrypt(refreshJwt),
    ])

    return {
      access_token: accessToken,
      refresh_token: refreshToken ?? undefined,
      token_type: 'Bearer',
      expires_in,
    }
  }

  #processAccessTokenIntrospection(
    payload: JWTPayload,
    expired = false
  ): [AccessTokenPayload, TokenIntrospectionResponse] {
    const parsed = AccessTokenPayload.safeParse(payload)
    if (!parsed.success) {
      throw new OauthError('invalid token', 'invalid_request')
    }

    const claims = pick(payload, ['iat', 'exp', 'aud', 'iss', 'jti'])

    return [
      parsed.data,
      {
        active: !expired,
        client_id: parsed.data.client_id,
        username: parsed.data.user_id ?? undefined,
        ...claims,
      },
    ]
  }

  #processRefreshTokenIntrospection(
    payload: JWTPayload,
    expired = false
  ): [RefreshTokenPayload, TokenIntrospectionResponse] {
    const parsed = RefreshTokenPayload.safeParse(payload)
    if (!parsed.success) {
      throw new OauthError('invalid token', 'invalid_request')
    }

    const claims = pick(payload, ['iat', 'exp', 'aud', 'iss', 'jti'])

    return [
      parsed.data,
      {
        active: !expired,
        client_id: parsed.data.client_id,
        ...claims,
      },
    ]
  }

  async introspectToken(namespace: string, token: string) {
    const accessTokenAud = audience(namespace, 'access_token')
    const refreshTokenAud = audience(namespace, 'refresh_token')

    try {
      const { payload } = await this.#decrypt(token, {
        // allow either audience for introspection
        audience: [accessTokenAud, refreshTokenAud],
        requiredClaims: ['jti', 'provider', 'client_id'],
      })

      return payload.aud === accessTokenAud
        ? this.#processAccessTokenIntrospection(payload)
        : this.#processRefreshTokenIntrospection(payload)
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        // if the token is expired, we can still return an introspection response
        // with active: false
        return error.payload.aud === accessTokenAud
          ? this.#processAccessTokenIntrospection(error.payload, true)
          : this.#processRefreshTokenIntrospection(error.payload, true)
      }

      logger.error({ error }, 'error decrypting token for introspection')
      throw new OauthError('invalid token', 'invalid_request')
    }
  }

  /**
   * Decrypts and validates a gateway JWT, returning the contained access token
   * and destination provider if valid.
   */
  async unwrapAccessToken(namespace: string, token: string) {
    try {
      const { payload } = await this.#decrypt(token, {
        audience: audience(namespace, 'access_token'),
        requiredClaims: ['jti', 'provider', 'client_id', 'access_token'],
      })

      return AccessTokenPayload.parse(payload)
    } catch (error) {
      logger.error({ error }, 'error decrypting access token')
      throw new OauthError('invalid access token', 'invalid_grant')
    }
  }

  /**
   * Decrypts and validates a gateway JWT, returning the contained refresh token
   * and destination provider if valid.
   */
  async unwrapRefreshToken(namespace: string, token: string) {
    try {
      const { payload } = await this.#decrypt(token, {
        audience: audience(namespace, 'refresh_token'),
        requiredClaims: ['jti', 'provider', 'client_id', 'refresh_token'],
      })

      await this.#checkJtiReplay(payload)

      return RefreshTokenPayload.parse(payload)
    } catch (error) {
      if (error instanceof TokenError) {
        throw error
      }

      logger.error({ error }, 'error decrypting refresh token')
      throw new OauthError('invalid refresh token', 'invalid_grant')
    }
  }
}
