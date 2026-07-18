/**
 * Schemas for OAuth 2.0 Token Exchange
 * @see https://datatracker.ietf.org/doc/html/rfc8693
 */
import { z } from 'zod/v4'
import { OAuthErrorResponseBase } from './shared'

export const TokenTypeUri = z.enum([
  'urn:ietf:params:oauth:token-type:access_token',
  'urn:ietf:params:oauth:token-type:refresh_token',
  'urn:ietf:params:oauth:token-type:id_token',
  'urn:ietf:params:oauth:token-type:jwt',
])

export type TokenTypeUri = z.infer<typeof TokenTypeUri>

export const TokenExchangeRequest = z.object({
  grant_type: z.literal('urn:ietf:params:oauth:grant-type:token-exchange'),
  subject_token: z.string(),
  subject_token_type: TokenTypeUri,
  actor_token: z.string().optional(),
  actor_token_type: TokenTypeUri.optional(),
  requested_token_type: TokenTypeUri.optional(),
  resource: z.string().optional(),
  audience: z.string().optional(),
  scope: z.string().optional(),
})

export type TokenExchangeRequest = z.infer<typeof TokenExchangeRequest>

export const TokenExchangeResponse = z.object({
  access_token: z.string(),
  issued_token_type: TokenTypeUri,
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
})

export type TokenExchangeResponse = z.infer<typeof TokenExchangeResponse>

export const TokenExchangeErrorResponse = OAuthErrorResponseBase.extend({
  error: z.enum([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'invalid_scope',
    'invalid_target',
    'server_error', // not in spec but included for 5xx errors
  ]),
})

export type TokenExchangeErrorResponse = z.infer<
  typeof TokenExchangeErrorResponse
>
