import { parseArgs } from 'node:util'
import { createServer } from 'node:http'
import Graceful from '@ladjs/graceful'

import logger from '~/logger'
import { GatewayConfig } from './config'
import { loadConfig } from './config-loader'
import buildMcpRouter from './router'
import { disconnectRedisClients } from './redis'

const { values } = parseArgs({
  options: {
    config: {
      type: 'string',
      short: 'c',
    },
  },
})

const configPath =
  values.config || process.env.MCP_GATEWAY_CONFIG_FILE || 'config.yml'

logger.info({ configPath }, 'loading configuration')
const config = await loadConfig(GatewayConfig, configPath)
// set log level from config after loading it
logger.level = config.log_level

logger.info('initializing mcp gateway server')
const app = await buildMcpRouter(config)

const server = createServer(app)

logger.info('starting mcp gateway server')
server.listen(config.port, config.host, () => {
  logger.info(
    { port: config.port, host: config.host },
    'mcp gateway server is listening'
  )
})

const graceful = new Graceful({
  servers: [server],
  customHandlers: [disconnectRedisClients],
})

graceful.listen()
