/**
 * Schemas for OAuth Authorization Server Metadata
 * @see https://datatracker.ietf.org/doc/html/rfc8414
 */
import { z } from 'zod/v4'

export const AuthorizationServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string().optional(),
  registration_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()),
  response_modes_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_signing_alg_values_supported: z
    .array(z.string())
    .optional(),
  service_documentation: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  introspection_endpoint: z.string().optional(),
  introspection_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  subject_types_supported: z.array(z.string()).optional(),
})

export type AuthorizationServerMetadata = z.infer<
  typeof AuthorizationServerMetadata
>
