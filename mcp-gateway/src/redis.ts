import { z } from 'zod/v4'
import Redis, { type RedisOptions } from 'ioredis'

export const RedisConfig = z.object({
  host: z.string().nonempty(),
  port: z.int().default(6379),
  password: z.string().optional(),
  tls_ca: z.string().optional(),
})

export type RedisConfig = z.infer<typeof RedisConfig>

const instances: Redis[] = []

export function disconnectRedisClients() {
  for (const client of instances) {
    client.disconnect()
  }
}

export function createRedisClient(
  config: RedisConfig,
  extraOpts?: Partial<RedisOptions>
): Redis {
  const opts: RedisOptions = {
    host: config.host,
    port: config.port,
    password: config.password,
    tls: config.tls_ca ? { ca: config.tls_ca } : undefined,

    ...extraOpts,
  }

  const client = new Redis(opts)
  instances.push(client)

  return client
}
