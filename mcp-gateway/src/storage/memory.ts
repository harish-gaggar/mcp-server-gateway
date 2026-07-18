import { z } from 'zod/v4'

import type { TypedStorage } from './types'

/**
 * An in-memory implementation of TypedStorage, primarily for testing purposes.
 *
 * NOTE: this stores things using an in-memory Map, which can grow unbounded,
 * so it should not be used in production.
 * It also does not implement TTL-based expiration, so entries will persist until explicitly deleted.
 */
export class MemoryStorage<
  Schema extends z.ZodType,
> implements TypedStorage<Schema> {
  #store = new Map<string, z.infer<Schema>>()
  #schema: Schema

  constructor(schema: Schema) {
    // warn on usage when NODE_ENV is production, to gate against use in deployed environments
    if (process.env.NODE_ENV === 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        'Warning: MemoryStorage is not intended for production use and may lead to memory leaks. Please use a persistent storage solution like RedisStorage in production environments.'
      )
    }

    this.#schema = schema
  }

  withSchema<NewSchema extends z.ZodType>(schema: NewSchema) {
    return new MemoryStorage<NewSchema>(schema)
  }

  async has(key: string) {
    return this.#store.has(key)
  }

  async get(key: string) {
    const value = this.#store.get(key)
    if (!value) return null

    try {
      return this.#schema.parse(value)
    } catch {
      this.#store.delete(key)
      return null
    }
  }

  async set(key: string, val: z.infer<Schema>) {
    this.#store.set(key, val)
  }

  // no-op since we don't implement ttl expiration
  async refresh() {}

  async delete(key: string) {
    this.#store.delete(key)
  }

  static create() {
    return new MemoryStorage(z.unknown())
  }
}
