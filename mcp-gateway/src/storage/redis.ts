import { z } from 'zod/v4'
import type { Redis } from 'ioredis'

import baseLogger from '~/logger'
import type { TypedStorage } from './types'

/**
 * A Redis-based implementation of TypedStorage.
 */
export class RedisStorage<
  Schema extends z.ZodType,
> implements TypedStorage<Schema> {
  #redis: Redis
  #schema: Schema
  #logger = baseLogger.child({ module: 'RedisStorage' })

  constructor(redis: Redis, schema: Schema) {
    this.#schema = schema
    this.#redis = redis
  }

  withSchema<NewSchema extends z.ZodType>(schema: NewSchema) {
    return new RedisStorage<NewSchema>(this.#redis, schema)
  }

  async has(key: string) {
    const exists = await this.#redis.exists(key)
    return exists === 1
  }

  async get(key: string) {
    const value = await this.#redis.get(key)
    if (!value) return null

    try {
      const parsed = JSON.parse(value)
      return this.#schema.parse(parsed)
    } catch (error) {
      this.#logger.error({ error, key }, 'invalid entry, deleting')
      await this.#redis.del(key)
      return null
    }
  }

  async set(key: string, val: z.infer<Schema>, ttlMs: number) {
    const value = JSON.stringify(val)
    await this.#redis.set(key, value, 'PX', ttlMs)
  }

  async refresh(key: string, ttlMs: number) {
    await this.#redis.pexpire(key, ttlMs)
  }

  async delete(key: string) {
    await this.#redis.del(key)
  }

  static create(redis: Redis) {
    return new RedisStorage(redis, z.unknown())
  }
}
