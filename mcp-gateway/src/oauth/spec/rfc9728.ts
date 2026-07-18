/**
 * Schemas for OAuth Protected Resource Metadata
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */
import { z } from 'zod/v4'

export const ProtectedResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).optional(),
  jwks_uri: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  bearer_methods_supported: z.array(z.string()).optional(),
  resource_name: z.string().optional(),
  resource_documentation: z.string().optional(),
  resource_policy_uri: z.string().optional(),
  resource_tos_uri: z.string().optional(),
})

export type ProtectedResourceMetadata = z.infer<
  typeof ProtectedResourceMetadata
>
