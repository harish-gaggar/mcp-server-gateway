import { z } from 'zod/v4'
import { createHash } from 'node:crypto'

import { getMetadataForUrl } from '~/hosted-metadata'
import { regexPatternList, duration } from '~/zod-utils'
import type { TypedStorage } from '~/storage/types'

import {
  validateRedirectUri,
  validUrl,
  isLoopback,
  type ClientMetadataHandler,
  validateRedirectAllowedByClient,
} from './shared'
import {
  AuthorizationError,
  ClientIdMetadataDocument,
  type ClientRegistrationRequest,
} from '~/oauth/spec'

export const ClientIdMetaDocConfig = z.object({
  // list of regex patterns that client redirect URIs must match, for security
  allowed_redirect_uris: regexPatternList(true).optional(),
  // list of regex patterns that the metadata document URIs must match
  allowed_metadata_uris: regexPatternList(false).optional(),
  // maximum duration the metadata document should be cached for. If the cache
  // headers of the metadata document return a value lower than this, the lower value
  // will be used instead
  max_cache_ttl: duration.prefault('1d'), // use prefault so the `ms` transformation will still occur
  // if true, the redirect_uris in the metadata document must be the same origin as the document itself,
  // or localhost
  enforce_same_origin_uri: z.boolean().default(true),
})

export type ClientIdMetaDocConfig = z.infer<typeof ClientIdMetaDocConfig>

// per spec, metadata document responses must not exceed 5KB to prevent DoS
const MAX_RESPONSE_BYTES = 5 * 1024

// private IP ranges that must be blocked to prevent SSRF
const PRIVATE_IP_PATTERNS = [
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^127\.\d+\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^ff[0-9a-f]{2}:/i,
  /^0\.0\.0\.0$/,
]

function isSsrfRisk(hostname: string): boolean {
  return PRIVATE_IP_PATTERNS.some(re => re.test(hostname))
}

/**
 * Parses max-age from a Cache-Control header value.
 * Returns the value in milliseconds, or null if not present.
 */
function parseCacheControlMaxAge(header: string | null): number | null {
  if (!header) return null
  const match = header.match(/\bmax-age\s*=\s*(\d+)/)
  if (!match) return null
  return parseInt(match[1], 10) * 1000
}

function cacheKey(clientId: string) {
  const hash = createHash('sha256').update(clientId).digest('hex')
  return `metadata:${hash}`
}

/**
 * Handles loading and validating OAuth authorize and token requests using
 * client information provided through the Client ID Metadata Document specification.
 *
 * @see https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
 */
export class ClientIdMetadataDocumentHandler implements ClientMetadataHandler {
  #store: TypedStorage<typeof ClientIdMetadataDocument>
  #config: ClientIdMetaDocConfig
  #baseUrl: URL

  constructor(
    cimdConfig: ClientIdMetaDocConfig,
    storage: TypedStorage,
    baseUrl: URL
  ) {
    this.#config = cimdConfig
    this.#store = storage.withSchema(ClientIdMetadataDocument)
    this.#baseUrl = baseUrl
  }

  /**
   * Validates that the client_id URL is safe to fetch (HTTPS, not SSRF risk,
   * valid path, matches allowed patterns).
   */
  #validateClientIdUrl(clientId: string) {
    const parsed = validUrl(clientId)
    if (!parsed) {
      throw new AuthorizationError(
        'client_id must be a valid URL',
        'invalid_request'
      )
    }

    // if it's a URL on the same origin as the server itself, it's always allowed
    if (parsed.origin === this.#baseUrl.origin) {
      return parsed
    }

    if (parsed.protocol !== 'https:') {
      throw new AuthorizationError(
        'client_id must use the HTTPS scheme',
        'invalid_request'
      )
    }

    // per spec, the URL must have a path component beyond just "/"
    if (!parsed.pathname || parsed.pathname === '/') {
      throw new AuthorizationError(
        'client_id URL must contain a path component',
        'invalid_request'
      )
    }

    // SSRF protection: block private/loopback/special-use addresses
    if (isSsrfRisk(parsed.hostname)) {
      throw new AuthorizationError(
        'client_id URL must not resolve to a private or loopback address',
        'invalid_request'
      )
    }

    if (
      this.#config.allowed_metadata_uris &&
      !this.#config.allowed_metadata_uris.test(clientId)
    ) {
      throw new AuthorizationError(
        'client_id URL does not match allowed metadata URI patterns',
        'invalid_request'
      )
    }

    return parsed
  }

  #validateRedirectUri(
    uri: string,
    documentUrl: URL,
    metadata: ClientRegistrationRequest
  ): boolean {
    // validate that the uri is in the list of allowed redirect URIs defined in
    // the metadata document, to prevent open redirect vulnerabilities
    if (!validateRedirectAllowedByClient(uri, metadata)) return false

    if (
      this.#config.enforce_same_origin_uri &&
      !isSameOriginOrLocalhost(uri, documentUrl)
    ) {
      return false
    }

    return validateRedirectUri(
      uri,
      metadata.application_type,
      this.#config.allowed_redirect_uris
    )
  }

  /**
   * Validates the metadata against config rules: redirect URIs, response/grant types,
   * and optional same-origin enforcement.
   */
  #validateMetadata(
    metadata: ClientIdMetadataDocument,
    documentUrl: URL,
    redirectUri?: string
  ) {
    const hasValidUri = metadata.redirect_uris.some(uri =>
      this.#validateRedirectUri(uri, documentUrl, metadata)
    )

    if (!hasValidUri) {
      throw new AuthorizationError(
        'At least one redirect URI must be valid, match allowed patterns, and satisfy same-origin requirements',
        'invalid_request'
      )
    }

    // ensure the response type includes 'code', since we don't support implicit
    if (
      metadata.response_types?.length &&
      !metadata.response_types.includes('code')
    ) {
      throw new AuthorizationError(
        'response_types must include "code" since implicit flow is not supported',
        'invalid_request'
      )
    }

    if (
      metadata.grant_types?.length &&
      !metadata.grant_types.includes('authorization_code')
    ) {
      throw new AuthorizationError(
        'grant_types must include "authorization_code" since other flows are not supported',
        'invalid_request'
      )
    }

    if (
      redirectUri &&
      !this.#validateRedirectUri(redirectUri, documentUrl, metadata)
    ) {
      throw new AuthorizationError(
        'Provided redirect_uri is not valid for the client application type',
        'invalid_request'
      )
    }
  }

  /**
   * Fetches the metadata document from the given URL, respecting size limits.
   * Returns the response text and cache TTL in milliseconds.
   */
  async #fetchDocument(url: URL) {
    if (url.origin === this.#baseUrl.origin) {
      // internal metadata request, load from static config
      const metadata = getMetadataForUrl(url)
      if (!metadata) {
        throw new AuthorizationError(
          'Client metadata document not found',
          'invalid_request'
        )
      }

      const body = JSON.stringify(metadata)
      // use a ttl since it's a direct lookup, and so we don't have to worry
      // about cached responses if the hosted metadata changes
      return { body, ttlMs: 0 }
    }

    let response: Response
    try {
      response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        // redirect: 'error' prevents open-redirect SSRF via metadata host redirects
        redirect: 'error',
      })
    } catch {
      throw new AuthorizationError(
        'Failed to fetch client metadata document',
        'invalid_request'
      )
    }

    if (response.status !== 200) {
      throw new AuthorizationError(
        `Client metadata document returned HTTP ${response.status}`,
        'invalid_request'
      )
    }

    // enforce max response size to prevent DoS
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new AuthorizationError(
        'Client metadata document exceeds maximum allowed size',
        'invalid_request'
      )
    }

    const body = await response.text()
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new AuthorizationError(
        'Client metadata document exceeds maximum allowed size',
        'invalid_request'
      )
    }

    // determine TTL: min of max_cache_ttl and Cache-Control max-age
    const cacheControlAge = parseCacheControlMaxAge(
      response.headers.get('cache-control')
    )
    const ttlMs =
      cacheControlAge !== null
        ? Math.min(cacheControlAge, this.#config.max_cache_ttl)
        : this.#config.max_cache_ttl

    return { body, ttlMs }
  }

  /**
   * Loads and parses the metadata document for a given client_id URL,
   * using the Redis cache when available.
   */
  async #loadMetadata(clientId: string, documentUrl: URL) {
    const key = cacheKey(clientId)

    const cached = await this.#store.get(key)
    if (cached) return cached

    const { body, ttlMs } = await this.#fetchDocument(documentUrl)

    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new AuthorizationError(
        'Client metadata document is not valid JSON',
        'invalid_request'
      )
    }

    let metadata: ClientIdMetadataDocument
    try {
      metadata = ClientIdMetadataDocument.parse(parsed)
    } catch {
      throw new AuthorizationError(
        'Client metadata document does not conform to expected schema',
        'invalid_request'
      )
    }

    if (ttlMs > 0) {
      await this.#store.set(key, metadata, ttlMs)
    }

    return metadata
  }

  /**
   * Determines if this handler can potentially handle the given client ID.
   */
  canHandle(clientId: string): boolean {
    return validUrl(clientId) !== null
  }

  /**
   * Loads and validates client metadata for an authorize request.
   * Returns the metadata if the client_id and its document are valid.
   * If redirect_uri is specified, validates that the redirect_uri is allowed by
   * the metadata and config rules.
   */
  async loadClientMetadata(_: string, clientId: string, redirectUri?: string) {
    const documentUrl = this.#validateClientIdUrl(clientId)
    const metadata = await this.#loadMetadata(clientId, documentUrl)

    this.#validateMetadata(metadata, documentUrl, redirectUri)
    return metadata
  }

  /**
   * Validates a token request for a given client_id.
   * Since CIMD clients are public clients (no client secret), this only verifies
   * that the client_id is a known, valid metadata document URL.
   */
  validateClientAuth(_: string, clientId: string) {
    return this.loadClientMetadata('', clientId)
  }
}

/**
 * Returns true if the redirect URI is same-origin as the metadata document URL,
 * or if the redirect URI host is localhost/loopback.
 */
function isSameOriginOrLocalhost(
  redirectUri: string,
  documentUrl: URL
): boolean {
  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  } catch {
    return false
  }

  if (isLoopback(parsed)) return true
  return parsed.origin === documentUrl.origin
}
