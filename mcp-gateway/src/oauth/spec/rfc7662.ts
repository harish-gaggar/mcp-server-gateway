/**
 * Schemas for OAuth 2.0 Token Introspection
 * @see https://datatracker.ietf.org/doc/html/rfc7662
 */
import { z } from 'zod/v4'
import { OAuthErrorResponseBase } from './shared'

export const TokenIntrospectionRequest = z.object({
  token: z.string(),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
})

export type TokenIntrospectionRequest = z.infer<
  typeof TokenIntrospectionRequest
>

export const TokenIntrospectionResponse = z.object({
  active: z.boolean(),
  scope: z.string().optional(),
  client_id: z.string().optional(),
  username: z.string().optional(),
  token_type: z.string().optional(),
  exp: z.number().int().optional(),
  iat: z.number().int().optional(),
  nbf: z.number().int().optional(),
  sub: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iss: z.string().optional(),
  jti: z.string().optional(),
})

export type TokenIntrospectionResponse = z.infer<
  typeof TokenIntrospectionResponse
>

export const TokenIntrospectionErrorResponse = OAuthErrorResponseBase.extend({
  error: z.enum([
    'invalid_request',
    'invalid_client',
    'insufficient_scope',
    'server_error', // not in spec but included for 5xx errors
  ]),
})

export type TokenIntrospectionErrorResponse = z.infer<
  typeof TokenIntrospectionErrorResponse
>
