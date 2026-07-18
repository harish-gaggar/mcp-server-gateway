import type { Provider } from '~/oauth/provider'

import { McpServerConfig, McpServer } from './server'

export { McpServerConfig, McpServer }

export function loadMcpServers(
  rawConfigs: Record<string, McpServerConfig>,
  providers: Map<string, Provider>
) {
  const serverMap = new Map<string, McpServer>()

  for (const [name, config] of Object.entries(rawConfigs)) {
    let provider: Provider | null = null
    if (config.auth_provider) {
      provider = providers.get(config.auth_provider) ?? null

      if (!provider) {
        throw new Error(
          `MCP server ${name} references unknown auth provider ${config.auth_provider}`
        )
      }
    }

    serverMap.set(name, new McpServer(name, config, provider))
  }

  return serverMap
}
