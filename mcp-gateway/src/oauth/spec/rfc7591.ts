/**
 * Schemas for OAuth Dynamic Client Registration
 * @see https://datatracker.ietf.org/doc/html/rfc7591
 */
import { z } from 'zod/v4'

import { OAuthErrorResponseBase } from './shared'

export const ClientApplicationType = z.enum(['native', 'web'])

export type ClientApplicationType = z.infer<typeof ClientApplicationType>

export const ClientRegistrationRequest = z.object({
  application_type: ClientApplicationType.default('web'),
  redirect_uris: z.array(z.url()),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  scope: z.string().optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
  jwks_uri: z.string().optional(),
  jwks: z.record(z.string(), z.unknown()).optional(),
})

export type ClientRegistrationRequest = z.infer<
  typeof ClientRegistrationRequest
>

export const ClientRegistrationResponse = ClientRegistrationRequest.extend({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().int().optional(),
  client_secret_expires_at: z.number().int().optional(),
})

export type ClientRegistrationResponse = z.infer<
  typeof ClientRegistrationResponse
>

export const ClientRegistrationErrorResponse = OAuthErrorResponseBase.extend({
  error: z.enum([
    'invalid_redirect_uri',
    'invalid_client_metadata',
    'invalid_software_statement',
    'unapproved_software_statement',
    'server_error', // not in spec but included for 5xx errors
  ]),
})

export type ClientRegistrationErrorResponse = z.infer<
  typeof ClientRegistrationErrorResponse
>
