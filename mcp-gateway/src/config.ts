import { z } from 'zod'

import {
  ClientIdMetaDocConfig,
  DynamicClientConfig,
  GoogleIdTokenConfig,
} from './client-handlers'
import { fileOrSchema } from './config-loader'
import { McpServerConfig } from './mcp'
import { OauthConfig } from './oauth/provider'
import { TokenConfig } from './oauth/token'
import { RedisConfig } from './redis'
import { GatewayRateLimitConfig } from './rate-limiting'
import { httpUrl, regexPatternList, withEnabled } from './zod-utils'

const restrictedPrefixes = ['.well-known', 'client-metadata']

// ensure mcp servers or oauth providers can't name-conflict with reserved
// routes
const restrictedKey = z
  .string()
  .refine(
    key => !restrictedPrefixes.some(prefix => key.startsWith(prefix)),
    'keys cannot overlap with existing defined routes'
  )

const logLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

export const GatewayConfig = z.object({
  port: z.int().default(3000),
  host: z.string().default('localhost'),
  base_url: httpUrl.transform(val => new URL(val)),
  environment: z.string().default('local'),
  trust_proxy: z.boolean().default(process.env.NODE_ENV === 'production'),
  allow_subdomains: z.boolean().default(true),

  cors: withEnabled(
    z.object({ allowed_origins: z.literal('*').or(regexPatternList(true)) })
  ).optional(),

  log_level: logLevel.default('info'),
  http_log_level: logLevel.or(z.literal('off')).default('off'),

  redis: RedisConfig,
  token: TokenConfig,
  dcr: withEnabled(DynamicClientConfig).optional(),
  cimd: withEnabled(ClientIdMetaDocConfig).optional(),
  google_token_clients: withEnabled(GoogleIdTokenConfig).optional(),

  rate_limiting: GatewayRateLimitConfig.optional(),

  oauth_providers: fileOrSchema(z.record(restrictedKey, OauthConfig)),
  mcp_servers: fileOrSchema(z.record(restrictedKey, McpServerConfig)),
})

export type GatewayConfig = z.infer<typeof GatewayConfig>
