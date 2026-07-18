import type { Application } from 'express'
import type { McpServer } from '~/mcp/server'

function getJsonServerList(servers: Map<string, McpServer>, baseUrl: URL) {
  return Array.from(servers.entries()).map(([namespace, server]) => {
    const mcpUrl = new URL(`${namespace}/mcp`, baseUrl).toString()

    return {
      name: server.config.name,
      description: server.config.description,
      url: mcpUrl,
      requires_auth: server.requiresAuth,
    }
  })
}

function getServerListForTemplate(
  servers: Map<string, McpServer>,
  baseUrl: URL
) {
  return Array.from(servers.entries()).map(([namespace, server]) => {
    const provider = server.authProvider
    const mcpUrl = new URL(`${namespace}/mcp`, baseUrl).toString()

    const cursorConfig = Buffer.from(
      JSON.stringify({ type: 'http', url: mcpUrl })
    ).toString('base64')
    const cursorDeeplink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(namespace)}&config=${cursorConfig}`
    const vscodeCommand = `code --add-mcp '${JSON.stringify({ name: namespace, type: 'http', url: mcpUrl })}'`

    return {
      namespace,
      name: server.config.name,
      description: server.config.description,
      authProvider: provider ? provider.name : null,
      canExchange: provider ? provider.canExchange : false,
      canRefresh: provider ? provider.canRefresh : false,
      mcpUrl,
      claudeCommand: `claude mcp add --transport http ${namespace} ${mcpUrl}`,
      cursorDeeplink,
      vscodeCommand,
    }
  })
}

export function addHomepageRoute(
  app: Application,
  baseUrl: URL,
  servers: Map<string, McpServer>,
  environment: string
) {
  app.get('/', (req, res) => {
    if (req.header('accept')?.includes('application/json')) {
      const serverList = getJsonServerList(servers, baseUrl)
      return res.json(serverList)
    }

    const serverList = getServerListForTemplate(servers, baseUrl)
    res.render('homepage', {
      pageTitle: 'Available MCP Servers',
      environment,
      servers: serverList,
    })
  })
}
