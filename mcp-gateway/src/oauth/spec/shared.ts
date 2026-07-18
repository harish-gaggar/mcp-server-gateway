import { z } from 'zod/v4'

/**
 * Common error response fields shared across OAuth error responses.
 */
export const OAuthErrorResponseBase = z.object({
  error: z.string(),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
})

export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseBase>
