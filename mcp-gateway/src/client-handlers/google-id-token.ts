import { z } from 'zod/v4'
import { createRemoteJWKSet, jwtVerify } from 'jose'

import {
  GOOGLE_ISSUER,
  GOOGLE_JWKS_ENDPOINT,
  TOKEN_EXCHANGE_GRANT,
} from '~/constants'
import { AuthorizationError, TokenError } from '~/oauth/spec'
import type { ClientMetadata, ClientMetadataHandler } from './shared'

export const GoogleIdTokenConfig = z.object({
  // hosted domains to allow for user tokens (e.g. "example.com")
  allowed_hd: z.array(z.string().nonempty()).nonempty().optional(),
  // allowlist of service account emails
  allowed_service_accounts: z.array(z.string().email()).nonempty().optional(),
  // if true, service account tokens must include an audience matching the gateway base URL
  require_audience: z.boolean().default(false),
})

export type GoogleIdTokenConfig = z.infer<typeof GoogleIdTokenConfig>

export const GOOGLE_ID_TOKEN_CLIENT_ID = 'google-id-token'

const SERVICE_ACCOUNT_DOMAIN = '.iam.gserviceaccount.com'

const googleJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_ENDPOINT))

function isServiceAccount(email: string): boolean {
  return email.endsWith(SERVICE_ACCOUNT_DOMAIN)
}

/**
 * Client handler that authenticates callers using a Google ID token as the
 * client secret. Intended exclusively for token exchange flows; the authorize
 * endpoint is not supported.
 */
export class GoogleIdTokenClientHandler implements ClientMetadataHandler {
  #config: GoogleIdTokenConfig
  #baseUrl: URL

  constructor(config: GoogleIdTokenConfig, baseUrl: URL) {
    this.#config = config
    this.#baseUrl = baseUrl
  }

  canHandle(clientId: string): boolean {
    return clientId === GOOGLE_ID_TOKEN_CLIENT_ID
  }

  // This handler is only for token exchange; the authorize endpoint is not supported.
  loadClientMetadata(): Promise<ClientMetadata> {
    throw new AuthorizationError(
      'The google-id-token client does not support the authorization endpoint',
      'unauthorized_client'
    )
  }

  async validateClientAuth(
    _namespace: string,
    clientId: string,
    clientSecret: string
  ): Promise<ClientMetadata> {
    if (clientId !== GOOGLE_ID_TOKEN_CLIENT_ID) {
      throw new TokenError('Invalid client_id', 'invalid_client')
    }

    let payload: { email?: string; hd?: string; aud?: string | string[] }
    try {
      const { payload: p } = await jwtVerify(clientSecret, googleJwks, {
        issuer: GOOGLE_ISSUER,
      })
      payload = p as typeof payload
    } catch {
      throw new TokenError(
        'Invalid or expired Google ID token',
        'invalid_client'
      )
    }

    const email = payload.email
    if (!email) {
      throw new TokenError(
        'Google ID token missing email claim',
        'invalid_client'
      )
    }

    if (isServiceAccount(email)) {
      this.#validateServiceAccount(email, payload.aud)
    } else {
      this.#validateUserToken(payload.hd)
    }

    return {
      client_id: email,
      application_type: 'web' as const,
      grant_types: [TOKEN_EXCHANGE_GRANT],
      redirect_uris: [],
    }
  }

  #validateServiceAccount(email: string, aud: string | string[] | undefined) {
    if (
      this.#config.allowed_service_accounts &&
      !this.#config.allowed_service_accounts.includes(email)
    ) {
      throw new TokenError(
        `Service account ${email} is not in the allowed list`,
        'unauthorized_client'
      )
    }

    if (this.#config.require_audience) {
      const baseOrigin = this.#baseUrl.origin
      const audiences = Array.isArray(aud) ? aud : aud ? [aud] : []
      if (!audiences.includes(baseOrigin)) {
        throw new TokenError(
          `Service account token must include audience "${baseOrigin}"`,
          'invalid_client'
        )
      }
    }
  }

  #validateUserToken(hd: string | undefined) {
    if (!this.#config.allowed_hd) return

    if (!hd || !this.#config.allowed_hd.includes(hd)) {
      throw new TokenError(
        hd
          ? `Hosted domain "${hd}" is not in the allowed list`
          : 'Google ID token missing hd (hosted domain) claim',
        'unauthorized_client'
      )
    }
  }
}
