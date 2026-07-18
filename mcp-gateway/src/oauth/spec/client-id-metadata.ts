/**
 * Schemas for OAuth Client ID Metadata Documents
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 *
 * Reuses RFC 7591 client metadata fields. Explicitly forbids client_secret and
 * client_secret_expires_at. token_endpoint_auth_method is restricted to "none"
 * or "private_key_jwt" (no shared-secret methods).
 */
import { z } from 'zod/v4'
import { ClientRegistrationRequest } from './rfc7591'

export const ClientIdMetadataDocument = ClientRegistrationRequest.extend({
  client_id: z.string(),
  token_endpoint_auth_method: z.enum(['none', 'private_key_jwt']).optional(),
})

export type ClientIdMetadataDocument = z.infer<typeof ClientIdMetadataDocument>
