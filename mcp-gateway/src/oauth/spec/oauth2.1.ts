/**
 * Schemas for OAuth 2.1
 * @see https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13
 */
import { z } from 'zod/v4'
import { OAuthErrorResponseBase } from './shared'

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

export const AuthorizationRequest = z.object({
  response_type: z.literal('code'),
  client_id: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.enum(['S256', 'plain']).optional(),
  redirect_uri: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
})

export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>

export const AuthorizationResponse = z.object({
  code: z.string(),
  state: z.string().optional(),
})

export type AuthorizationResponse = z.infer<typeof AuthorizationResponse>

export const AuthorizationErrorResponse = OAuthErrorResponseBase.extend({
  error: z.enum([
    'invalid_request',
    'unauthorized_client',
    'access_denied',
    'unsupported_response_type',
    'invalid_scope',
    'server_error',
    'temporarily_unavailable',
  ]),
  state: z.string().optional(),
})

export type AuthorizationErrorResponse = z.infer<
  typeof AuthorizationErrorResponse
>

// ---------------------------------------------------------------------------
// Token endpoint — authorization code grant
// ---------------------------------------------------------------------------

export const AuthorizationCodeTokenRequest = z.object({
  grant_type: z.literal('authorization_code'),
  code: z.string(),
  redirect_uri: z.string(),
  code_verifier: z.string(),
  client_id: z.string().optional(),
})

export type AuthorizationCodeTokenRequest = z.infer<
  typeof AuthorizationCodeTokenRequest
>

// ---------------------------------------------------------------------------
// Token endpoint — refresh token grant
// ---------------------------------------------------------------------------

export const RefreshTokenRequest = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string(),
  scope: z.string().optional(),
})

export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequest>

// ---------------------------------------------------------------------------
// Token endpoint — response
// ---------------------------------------------------------------------------

export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().optional(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
  // OIDC id_token (a signed JWT). Captured so it can optionally be forwarded to
  // upstream MCP servers that need to perform their own OIDC token exchange
  // (e.g. exchanging it for a scoped JFrog access token).
  id_token: z.string().optional(),
})

export type TokenResponse = z.infer<typeof TokenResponse>

export const TokenErrorResponse = OAuthErrorResponseBase.extend({
  error: z.enum([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'unauthorized_client',
    'unsupported_grant_type',
    'invalid_scope',
    'server_error', // to handle 5xx errors
  ]),
})

export type TokenErrorResponse = z.infer<typeof TokenErrorResponse>
