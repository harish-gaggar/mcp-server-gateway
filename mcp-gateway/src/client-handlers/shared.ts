import type {
  ClientApplicationType,
  ClientRegistrationRequest,
} from '~/oauth/spec'

export type ClientMetadata = ClientRegistrationRequest & { client_id: string }

export interface ClientMetadataHandler {
  canHandle(clientId: string): boolean
  loadClientMetadata(
    namespace: string,
    clientId: string,
    redirectUri?: string
  ): Promise<ClientMetadata>
  validateClientAuth(
    namespace: string,
    clientId: string,
    clientSecret: string
  ): Promise<ClientMetadata>
}

const loopbackUris = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopback(uri: URL) {
  return loopbackUris.has(uri.hostname)
}

export function validUrl(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

/**
 * Validates a redirect URI against allowed patterns and application type.
 * - If the URI is HTTP, it must be a loopback address.
 * - Custom schemes are only allowed for native applications.
 */
export function validateRedirectUri(
  uri: string,
  _: ClientApplicationType,
  allowedRegex?: RegExp
) {
  // check against initial allowed regex first if present
  const isAllowed = allowedRegex?.test(uri) ?? true
  if (!isAllowed) return false

  const parsed = validUrl(uri)
  if (!parsed) return false

  // if an http url, only allow loopback addresses
  if (parsed.protocol === 'http:') return isLoopback(parsed)

  // NOTE: according to the spec, non-https protocols are reserved for native apps.
  // But SOME mcp clients (cough cough Cursor) use custom schemes for web apps,
  // so we'll allow non-https urls for all app types for now.
  return true
}

/**
 * Validates a redirect uri against a list of defined redirect uris in client meta
 */
export function validateRedirectAllowedByClient(
  redirectUri: string,
  metadata: ClientRegistrationRequest
) {
  const parsed = validUrl(redirectUri)
  if (!parsed) return false

  const isParsedLoopback = isLoopback(parsed)

  return metadata.redirect_uris.some(uri => {
    // exact match is always allowed
    if (uri === redirectUri) return true

    const allowed = validUrl(uri)
    if (!allowed) return false

    if (isLoopback(allowed) && isParsedLoopback) {
      // if both the allowed and provided uris are loopback, just validate that
      // the hostnames and protocol match
      //
      // NOTE: *technically* dynamic ports are only supported for "native" application
      // types but there's a bit of confusion w.r.t the OAuth specification, see
      // https://github.com/anthropics/claude-code/issues/18251#issuecomment-4194769590
      // Until said confusion is resolved, we'll allow dynamic ports regardless of
      // application type as long as the hostname, protocol, and path all match
      return (
        allowed.protocol === parsed.protocol &&
        allowed.hostname === parsed.hostname &&
        allowed.pathname === parsed.pathname
      )
    }

    return false
  })
}
