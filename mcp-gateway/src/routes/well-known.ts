import { Router, type Application, type RequestHandler } from 'express'

import baseLogger from '~/logger'
import { TOKEN_EXCHANGE_GRANT, WELL_KNOWN_PREFIX } from '~/constants'
import type { McpServer } from '~/mcp'
import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from '~/oauth/spec'

import { parseNamespace, getOAuthErrorHandler } from './helpers'

const logger = baseLogger.child({ component: 'well-known-router' })

export type WellKnownRouterOptions = {
  baseUrl: URL
  dcr: boolean

  servers: Map<string, McpServer>
}

export function addWellKnownRoutes(
  app: Application,
  { baseUrl, dcr, servers }: WellKnownRouterOptions
) {
  const router = Router()

  function toUrl(path: string, subdomain?: string) {
    const clone = new URL(baseUrl)
    if (subdomain) {
      clone.hostname = `${subdomain}.${clone.hostname}`
    }

    return new URL(path, clone).toString()
  }

  const metadataHandler: RequestHandler = (req, res) => {
    const { namespace, provider } = parseNamespace(servers, req, res)

    const grant_types_supported = ['authorization_code']
    if (provider!.canRefresh) {
      grant_types_supported.push('refresh_token')
    }
    if (provider!.canExchange) {
      grant_types_supported.push(TOKEN_EXCHANGE_GRANT)
    }

    const issuer = req.subdomain ? '' : `/${namespace}`

    const metadata: AuthorizationServerMetadata = {
      issuer: toUrl(issuer, req.subdomain),
      authorization_endpoint: toUrl(`${issuer}/oauth/authorize`, req.subdomain),
      token_endpoint: toUrl(`${issuer}/oauth/token`, req.subdomain),
      jwks_uri: toUrl(`${issuer}/oauth/jwks`, req.subdomain),
      registration_endpoint: dcr
        ? toUrl(`${issuer}/oauth/register`, req.subdomain)
        : undefined,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported,
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
      ],
      code_challenge_methods_supported: ['S256', 'plain'],
      introspection_endpoint: toUrl(
        `${issuer}/oauth/introspect`,
        req.subdomain
      ),
      introspection_endpoint_auth_methods_supported: ['client_secret_basic'],

      // extra bits to make this valid against the oidc spec (Cursor checks)
      id_token_signing_alg_values_supported: ['none'],
      subject_types_supported: [],
    }

    return res.json(metadata)
  }

  router.get('/oauth-authorization-server/:namespace', metadataHandler)
  // support oidc endpoint as well for max compatability
  router.get('/openid-configuration/:namespace', metadataHandler)

  router.get('/oauth-protected-resource/:namespace/mcp', (req, res) => {
    const { namespace, mcpServer } = parseNamespace(servers, req, res)

    const issuer = req.subdomain ? '' : `/${namespace}`

    const metadata: ProtectedResourceMetadata = {
      resource: toUrl(
        req.subdomain ? '/mcp' : `/${namespace}/mcp`,
        req.subdomain
      ),
      authorization_servers: [toUrl(issuer, req.subdomain)],
      bearer_methods_supported: ['header'],
      resource_name: mcpServer!.config.name,
    }

    return res.json(metadata)
  })

  const errHandler = getOAuthErrorHandler(logger)
  router.use(errHandler)

  app.use(WELL_KNOWN_PREFIX, router)

  const fallbackRouter = Router({ mergeParams: true })
  fallbackRouter.get('/oauth-authorization-server', metadataHandler)
  fallbackRouter.get('/openid-configuration', metadataHandler)
  fallbackRouter.use(errHandler)

  app.use(`/:namespace${WELL_KNOWN_PREFIX}`, fallbackRouter)
}
