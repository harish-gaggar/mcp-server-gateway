import { z } from 'zod/v4'
import {
  rateLimit as rateLimitMiddleware,
  type AugmentedRequest,
  type Options,
  type RateLimitInfo,
} from 'express-rate-limit'
import { RedisStore, type RedisReply } from 'rate-limit-redis'
import type { Redis } from 'ioredis'

import baseLogger from './logger'
import { createRedisClient, type RedisConfig } from './redis'
import { duration, withEnabled } from './zod-utils'

export const RateLimitConfig = z.object({
  report_only: z.boolean().default(false),
  window: duration,
  limit: z.number().int().positive(),
})

export type RateLimitConfig = z.infer<typeof RateLimitConfig>

export const McpServerRateLimitConfig = z.object({
  all: RateLimitConfig.optional(),
  tools: z.record(z.string().nonempty(), RateLimitConfig).optional(),
})

export type McpServerRateLimitConfig = z.infer<typeof McpServerRateLimitConfig>

export const GatewayRateLimitConfig = withEnabled(
  z.object({
    oauth: RateLimitConfig.optional(),
    mcp: RateLimitConfig.optional(),
  })
)

export type GatewayRateLimitConfig = z.infer<typeof GatewayRateLimitConfig>

// CIMD client IDs are URLs — use this to distinguish them from DCR client IDs
export function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

// Builds the rate limit key for MCP requests: user_id+namespace if available,
// otherwise client_id+namespace
export function mcpRateLimitKey(
  clientId: string,
  userId: string | null,
  namespace: string
): string {
  const primary = userId ?? clientId
  return `${primary}:${namespace}`
}

// Per-request rate limiter passed into McpServer.handleRequest
export type McpRateLimiter = {
  // returns true if the server-level limit is exceeded
  checkAll: (key: string) => Promise<boolean>
  // returns true if the per-tool limit is exceeded; false if no limit configured for the tool
  checkTool: (toolName: string, key: string) => Promise<boolean>
}

const logger = baseLogger.child({ module: 'rate-limiting' })

/**
 * A factory class for creating rate limiter functions. Works to create both
 * express middleware (via express-rate-limit) and custom limit check functions that
 * can be used in more flexible contexts.
 */
export class RateLimitFactory {
  #redisClient: Redis

  constructor(config: RedisConfig) {
    this.#redisClient = createRedisClient(config)
  }

  #getStore(id: string, options?: Pick<Options, 'windowMs'>) {
    const store = new RedisStore({
      sendCommand: (command: string, ...args: string[]) =>
        this.#redisClient.call(command, ...args) as Promise<RedisReply>,
      prefix: `rate-limit:${id}:`,
    })

    // if options passed, call init automatically
    // note: redis store only uses windowMs from options, so we can safely cast here
    if (options) store.init(options as Options)

    return store
  }

  /**
   * Creates an express middleware function for rate limiting, using the
   * provided configuration and key generator. If report_only is set to true,
   * the middleware will log when the limit is exceeded but will not actually
   * block requests.
   */
  middleware(
    id: string,
    { limit, window, report_only }: RateLimitConfig,
    keyGenerator: Options['keyGenerator'],
    skip?: Options['skip']
  ) {
    const mwLog = logger.child({ limiter: id })
    const store = this.#getStore(id)

    const options: Partial<Options> = {
      store,
      standardHeaders: 'draft-8',
      identifier: id,
      keyGenerator,
      skip,
      logger: {
        warn: (error, message) => mwLog.warn({ error }, message),
        error: (error, message) => mwLog.error({ error }, message),
      },
      limit,
      windowMs: window,
    }

    // if in report-only mode, override the handler to just log and call next()
    if (report_only) {
      options.handler = (req, _res, next) => {
        const { rateLimit } = req as AugmentedRequest
        mwLog.warn({ rateLimit }, 'rate limit exceeded (set to report only)')
        next()
      }
    }

    return rateLimitMiddleware(options)
  }

  /**
   * Creates a function that can be used to check the rate limit for a given key.
   * The returned function will return an object with the current rate limit status,
   * including whether the limit has been exceeded and how many requests remain.
   */
  createCheckFunction(
    id: string,
    { limit, window, report_only }: RateLimitConfig
  ) {
    const store = this.#getStore(id, { windowMs: window })

    return async (key: string): Promise<[RateLimitInfo, boolean]> => {
      const { totalHits, resetTime } = await store.increment(key)
      const rateLimit: RateLimitInfo = {
        limit,
        used: totalHits,
        remaining: Math.max(limit - totalHits, 0),
        resetTime,
        key,
      }

      const exceeded = totalHits > limit
      if (exceeded && report_only) {
        logger.warn({ rateLimit }, 'rate limit exceeded (set to report only)')
      }

      return [rateLimit, exceeded && !report_only]
    }
  }
}
