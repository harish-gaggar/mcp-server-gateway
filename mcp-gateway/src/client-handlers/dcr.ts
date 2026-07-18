import { z } from 'zod/v4'
import dayjs from 'dayjs'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { omit } from 'es-toolkit'

import { regexPatternList, duration } from '~/zod-utils'
import {
  ClientRegistrationRequest,
  type ClientRegistrationResponse,
  AuthorizationError,
  RegistrationError,
  TokenError,
} from '~/oauth/spec'
import type { TypedStorage } from '~/storage'

import {
  validateRedirectAllowedByClient,
  validateRedirectUri,
  type ClientMetadataHandler,
} from './shared'

export const DynamicClientConfig = z.object({
  // list of regex patterns that client redirect URIs must match, for security
  allowed_redirect_uris: regexPatternList(true).optional(),
  // how long the client registration is valid for
  // defaults to 1 week
  client_ttl: duration.prefault('1w'), // use prefault so the `ms` transformation will still occur
  // whether or not to refresh the client TTL on each use (i.e. sliding expiration)
  // if false, clients will expire after client_ttl regardless of usage
  refresh_ttl_on_use: z.boolean().default(true),
})

export type DynamicClientConfig = z.infer<typeof DynamicClientConfig>

const StoredClientMetadata = ClientRegistrationRequest.extend({
  client_id: z.string(),
  client_secret_hash: z.string(),
})

type StoredClientMetadata = z.infer<typeof StoredClientMetadata>

function clientKey(namespace: string, clientId: string) {
  return `client:${namespace}:${clientId}`
}

/**
 * Handles dynamic client registration and validation.
 */
export class DynamicClientHandler implements ClientMetadataHandler {
  #store: TypedStorage<typeof StoredClientMetadata>
  #config: DynamicClientConfig

  constructor(dcrConfig: DynamicClientConfig, storage: TypedStorage) {
    this.#config = dcrConfig
    this.#store = storage.withSchema(StoredClientMetadata)
  }

  #validateClientMetadata(request: ClientRegistrationRequest) {
    // we only need to ensure at least one uri in the list is initially valid,
    // since we'll repeat the check during the authorize call against whichever
    // uri is used then
    const hasValidUri = request.redirect_uris.some(uri =>
      validateRedirectUri(
        uri,
        request.application_type,
        this.#config.allowed_redirect_uris
      )
    )

    if (!hasValidUri) {
      throw new RegistrationError(
        'At least one redirect_uri must be valid and match allowed patterns',
        'invalid_redirect_uri'
      )
    }

    // ensure the response type includes 'code', since we don't support implicit
    if (
      request.response_types?.length &&
      !request.response_types.includes('code')
    ) {
      throw new RegistrationError(
        'response_types must include "code" since implicit flow is not supported',
        'invalid_client_metadata'
      )
    }

    if (
      request.grant_types?.length &&
      !request.grant_types.includes('authorization_code')
    ) {
      throw new RegistrationError(
        'grant_types must include "authorization_code" since other flows are not supported',
        'invalid_client_metadata'
      )
    }
  }

  /**
   * Registers a new client based on the provided registration request.
   */
  async register(namespace: string, request: ClientRegistrationRequest) {
    this.#validateClientMetadata(request)

    const client_id = randomBytes(16).toString('hex')
    const client_secret = randomBytes(32).toString('hex')
    const client_secret_hash = await bcrypt.hash(client_secret, 10)
    const expiresAt = dayjs().add(this.#config.client_ttl, 'ms').unix()

    const stored = {
      ...request,
      client_id,
      client_secret_hash,
    } satisfies StoredClientMetadata

    await this.#store.set(
      clientKey(namespace, client_id),
      stored,
      this.#config.client_ttl
    )

    return {
      ...request,
      client_id,
      client_secret,
      client_secret_expires_at: expiresAt,
    } satisfies ClientRegistrationResponse
  }

  #fetchStoredMetadata(namespace: string, clientId: string) {
    const key = clientKey(namespace, clientId)
    return this.#store.get(key)
  }

  /**
   * Whether this handler can potentially handle the given client ID.
   */
  canHandle(clientId: string): boolean {
    // we can only validate the format of the client ID, not its existence
    // (which is checked in load/validation)
    return /^[a-f0-9]{32}$/.test(clientId)
  }

  /**
   * Loads stored client metadata for a given client ID, excluding the secret hash.
   * If redirect_uri is specified, validates that the redirect_uri is allowed by
   * the metadata and config rules.
   */
  async loadClientMetadata(
    namespace: string,
    clientId: string,
    redirectUri?: string
  ) {
    const metadata = await this.#fetchStoredMetadata(namespace, clientId)
    if (!metadata || metadata.client_id !== clientId) {
      throw new AuthorizationError('Client not found', 'unauthorized_client')
    }

    if (redirectUri) {
      const isValid =
        validateRedirectUri(
          redirectUri,
          metadata.application_type,
          this.#config.allowed_redirect_uris
        ) && validateRedirectAllowedByClient(redirectUri, metadata)

      if (!isValid) {
        throw new AuthorizationError(
          'Provided redirect_uri is invalid for this client',
          'invalid_request'
        )
      }
    }

    return omit(metadata, ['client_secret_hash'])
  }

  /**
   * Validates a token request against stored client metadata and client credentials.
   */
  async validateClientAuth(
    namespace: string,
    clientId: string,
    clientSecret: string
  ) {
    const metadata = await this.#fetchStoredMetadata(namespace, clientId)
    if (!metadata || metadata.client_id !== clientId) {
      throw new TokenError('Client not found', 'invalid_client')
    }

    const isValid = await bcrypt.compare(
      clientSecret,
      metadata.client_secret_hash
    )
    if (!isValid) {
      throw new TokenError('Invalid client credentials', 'invalid_client')
    }

    if (this.#config.refresh_ttl_on_use) {
      await this.#store.refresh(
        clientKey(namespace, clientId),
        this.#config.client_ttl
      )
    }

    return omit(metadata, ['client_secret_hash'])
  }
}
