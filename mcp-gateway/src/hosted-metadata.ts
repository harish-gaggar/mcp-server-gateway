import { Router, type Application } from 'express'

import { CLIENT_METADATA_PREFIX, TOKEN_EXCHANGE_GRANT } from '~/constants'
import { ClientRegistrationRequest } from '~/oauth/spec'

/* Configuration for Client ID Metadata Documents hosted by the MCP Gateway server */
const hostedClientMetadata: Record<string, ClientRegistrationRequest> = {
  'virtual-mcp-server': {
    // vmcp client is "native" since it runs on localhost
    application_type: 'native',
    redirect_uris: [
      // port doesn't matter since the gateway allowed dynamic ports for native clients
      'http://localhost:12345/callback',
      'http://127.0.0.1:12345/callback',
      'http://[::1]:12345/callback',
    ],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'Virtual MCP Server',
    client_uri:
      'https://code.corp.creditkarma.com/ck-private/de_virtual-mcp-server/',
  },
  'remote-mcp-proxy': {
    application_type: 'native',
    redirect_uris: [
      // port doesn't matter since the gateway allowed dynamic ports for native clients
      'http://localhost:12345/callback',
      'http://127.0.0.1:12345/callback',
      'http://[::1]:12345/callback',
    ],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_name: 'CK Remote MCP Proxy',
    client_uri:
      'https://code.corp.creditkarma.com/ck-private/de_remote-mcp-proxy/',
  },
  // client metadata used when running mcp auth locally that normally uses the
  // google-id-token exchange flow in production. This allows consumers to test
  // the token exchange flow locally without needing to obtain real Google ID tokens
  'local-token-exchange': {
    application_type: 'web',
    redirect_uris: ['http://localhost:12345/callback'],
    grant_types: [TOKEN_EXCHANGE_GRANT, 'authorization_code'],
    response_types: ['code'],
  },
}

export function getMetadataForUrl(url: URL) {
  const path = url.pathname
  if (!path.startsWith(CLIENT_METADATA_PREFIX)) {
    return null
  }

  const clientId = path
    .slice(CLIENT_METADATA_PREFIX.length + 1) // +1 to remove the trailing slash
    .replace('.json', '')

  const metadata = hostedClientMetadata[clientId]
  if (!metadata) return null

  return { ...metadata, client_id: url.toString() }
}

export default function addClientMetadataRoutes(
  app: Application,
  baseUrl: URL
) {
  const router = Router()

  // eslint-disable-next-line no-useless-escape
  router.get('/:client_id\.json', (req, res) => {
    const { client_id } = req.params
    const metadata = hostedClientMetadata[client_id]
    if (!metadata) {
      return res.status(404).json({ error: 'Client metadata not found' })
    }

    const clientIdUrl = new URL(req.originalUrl, baseUrl).toString()

    // include the full URL to the metadata document in the response
    res.json({
      ...metadata,
      client_id: clientIdUrl,
    })
  })

  app.use(CLIENT_METADATA_PREFIX, router)
}
