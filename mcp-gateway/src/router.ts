import express, { type RequestHandler } from 'express'
import cookieParser from 'cookie-parser'
import pinoHttp from 'pino-http'
import { randomUUID } from 'node:crypto'
import cors from 'cors'

import logger, { serializers } from './logger'
import {
  ClientIdMetadataDocumentHandler,
  CompositeClientMetadataHandler,
  DynamicClientHandler,
  GoogleIdTokenClientHandler,
  type ClientMetadataHandler,
} from './client-handlers'
import { TOKEN_EXCHANGE_GRANT } from './constants'
import setupHandlebars from './handlebars'
import addClientMetadataRoutes from './hosted-metadata'
import { loadMcpServers } from './mcp'
import { loadProviders } from './oauth/provider'
import { TokenService } from './oauth/token'
import { createRedisClient } from './redis'
import {
  RateLimitFactory,
  isCimdClientId,
  type McpRateLimiter,
} from './rate-limiting'
import {
  addCallbackRoute,
  addHomepageRoute,
  addWellKnownRoutes,
  addOauthRoutes,
  getMcpRouteHandler,
  rewriteSubdomainsMw,
} from './routes'
import { RedisStorage } from './storage'
import type { GatewayConfig } from './config'

export default async function buildMcpRouter(config: GatewayConfig) {
  const clientHandlers: ClientMetadataHandler[] = []
  let dynamicClientSvc: DynamicClientHandler | null = null

  if (config.dcr?.enabled) {
    const redis = createRedisClient(config.redis, { keyPrefix: 'dcr:' })
    dynamicClientSvc = new DynamicClientHandler(
      config.dcr,
      RedisStorage.create(redis)
    )
    clientHandlers.push(dynamicClientSvc)
  }

  if (config.cimd?.enabled) {
    const redis = createRedisClient(config.redis, { keyPrefix: 'cimd:' })
    clientHandlers.push(
      new ClientIdMetadataDocumentHandler(
        config.cimd,
        RedisStorage.create(redis),
        config.base_url
      )
    )
  }

  if (config.google_token_clients?.enabled) {
    clientHandlers.push(
      new GoogleIdTokenClientHandler(
        config.google_token_clients,
        config.base_url
      )
    )
  }

  const clientSvc = new CompositeClientMetadataHandler(clientHandlers)
  const tokenSvc = new TokenService(
    createRedisClient(config.redis, { keyPrefix: 'token-svc:' }),
    config.token
  )
  const providers = await loadProviders(config.oauth_providers, config.base_url)
  const servers = loadMcpServers(config.mcp_servers, providers)

  let oauthTokenLimiter: RequestHandler | null = null
  const mcpRateLimiters = new Map<string, McpRateLimiter>()

  if (config.rate_limiting?.enabled) {
    const rl = config.rate_limiting
    const factory = new RateLimitFactory(config.redis)

    if (rl.oauth) {
      const oauthConfig = rl.oauth
      oauthTokenLimiter = factory.middleware(
        'oauth:token',
        oauthConfig,
        // clientAuth middleware runs before this, so clientId is always set via
        // Basic auth header or request body by this point
        req =>
          `${req.clientAuth?.clientId ?? req.ip ?? 'unknown'}:${req.params.namespace ?? ''}`,
        req => {
          // only rate limit token exchange — other grants have replay protection
          if (req.body?.grant_type !== TOKEN_EXCHANGE_GRANT) return true
          // CIMD clients share a client_id across users — skip limiting them
          const clientId = req.clientAuth?.clientId ?? ''
          return isCimdClientId(clientId)
        }
      )
    }

    for (const [name, server] of servers) {
      const serverRlConfig = server.config.rate_limit
      // per-server config overrides the global default; absent = use global
      const allConfig = serverRlConfig?.all ?? rl.mcp

      if (!server.requiresAuth && (allConfig || serverRlConfig?.tools)) {
        logger.warn(
          { server: name },
          'rate_limit configured on unauthenticated MCP server — skipping'
        )
        continue
      }

      if (!allConfig && !serverRlConfig?.tools) continue

      // pre-create all check functions so RedisStore instances are created once at startup
      const checkAllFn = allConfig
        ? factory.createCheckFunction(`mcp:${name}:all`, allConfig)
        : null

      const toolCheckFns = new Map(
        Object.entries(serverRlConfig?.tools ?? {}).map(
          ([toolName, toolConfig]) => [
            toolName,
            factory.createCheckFunction(
              `mcp:${name}:tool:${toolName}`,
              toolConfig
            ),
          ]
        )
      )

      mcpRateLimiters.set(name, {
        checkAll: async key => {
          if (!checkAllFn) return false
          const [, exceeded] = await checkAllFn(key)
          return exceeded
        },
        checkTool: async (toolName, key) => {
          const fn = toolCheckFns.get(toolName)
          if (!fn) return false
          const [, exceeded] = await fn(key)
          return exceeded
        },
      })
    }
  }

  const app = express()
  app.set('trust proxy', config.trust_proxy)
  // set strict routing for consistent trailing slash behavior
  app.set('strict routing', true)

  // healthcheck endpoint
  app.get('/health', (_, res) => {
    res.status(200).json({ status: 'ok' })
  })

  setupHandlebars(app)
  app.use(cookieParser())

  if (config.cors?.enabled) {
    app.use(
      cors({
        origin: config.cors.allowed_origins,
        // allow the three methods used by the MCP spec, and preflight requests
        methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
      })
    )
  }

  if (config.http_log_level !== 'off') {
    app.use(
      pinoHttp({
        logger: logger.child({ module: 'router' }),
        useLevel: config.http_log_level,
        genReqId: () => randomUUID(),
        serializers,
      })
    )
  }

  const subdomains = config.allow_subdomains ? new Set(servers.keys()) : null
  app.use(rewriteSubdomainsMw(config.base_url, subdomains))

  addHomepageRoute(app, config.base_url, servers, config.environment)
  addWellKnownRoutes(app, {
    baseUrl: config.base_url,
    dcr: config.dcr?.enabled ?? false,
    servers,
  })
  addCallbackRoute(app, { tokenSvc, servers })
  addOauthRoutes(app, {
    servers,
    clientSvc,
    tokenSvc,
    dynamicClientSvc,
    baseUrl: config.base_url,
    oauthTokenLimiter,
  })
  addClientMetadataRoutes(app, config.base_url)

  const mcpHandler = getMcpRouteHandler(
    config.base_url,
    tokenSvc,
    servers,
    mcpRateLimiters
  )
  app.get('/:namespace/mcp', mcpHandler)
  app.post('/:namespace/mcp', mcpHandler)
  app.delete('/:namespace/mcp', mcpHandler)

  // fallback 404
  app.use((_req, res) => {
    res.sendStatus(404)
  })

  return app
}
