import type { Request, Response, NextFunction, RequestHandler } from 'express'

import { WELL_KNOWN_PREFIX } from '~/constants'

const basicAuthHeaderRegex = /^(?:B|b)asic\s+([A-Za-z0-9+/=]+)$/

export function parseBasicAuth(req: Request) {
  const authHeader = req.get('authorization')

  const match = authHeader?.match(basicAuthHeaderRegex)
  if (!match) return null

  const credentials = Buffer.from(match[1], 'base64').toString('utf-8')
  const [username, password] = credentials.split(':', 2)
  return { username, password }
}

export function clientAuth(checkBody = true): RequestHandler {
  return (req: Request, _: Response, next: NextFunction) => {
    const basicAuth = parseBasicAuth(req)
    if (basicAuth) {
      req.clientAuth = {
        clientId: basicAuth.username,
        clientSecret: basicAuth.password,
      }
      return next()
    }

    if (checkBody) {
      const { client_id, client_secret } = req.body ?? {}
      if (client_id && typeof client_id === 'string') {
        req.clientAuth = {
          clientId: client_id,
          clientSecret:
            client_secret && typeof client_secret === 'string'
              ? client_secret
              : '',
        }
      }
    }

    return next()
  }
}

const oasMetadataRoute = `${WELL_KNOWN_PREFIX}/oauth-authorization-server`
const oidcMetadataRoute = `${WELL_KNOWN_PREFIX}/openid-configuration`

function addSubdomainToRoute(url: string, subdomain: string) {
  if (url === oasMetadataRoute || url === oidcMetadataRoute) {
    // for root-level metadata routes (i.e. no `/oauth` bit at the end), add the
    // missing route segment as well as the namespace
    return `${url}/${subdomain}`
  }

  // handle protected resource route, namespace needs to go before /mcp
  if (url.startsWith(WELL_KNOWN_PREFIX) && url.endsWith('/mcp')) {
    return url.replace(/\/mcp$/, `/${subdomain}/mcp`)
  }

  // for any other url just prepend the subdomain as a namespace
  return `/${subdomain}${url}`
}

/**
 * Middleware to handle subdomain rewriting for namespaced routes
 */
export function rewriteSubdomainsMw(
  baseUrl: URL,
  allowedSubdomains?: Set<string> | null // unset to disable subdomain rewrites
): RequestHandler {
  const baseDomain = baseUrl.hostname

  return (req, res, next) => {
    if (req.hostname === baseDomain) {
      // no subdomain, proceed as normal
      return next()
    }

    if (!allowedSubdomains || !req.hostname.endsWith(baseDomain)) {
      // if subdomain rewrites are disabled, return 404 for any non-base domain requests
      return res.sendStatus(404)
    }

    const subdomain = req.hostname.replace(`.${baseDomain}`, '')
    if (!allowedSubdomains.has(subdomain)) return res.sendStatus(404)

    // add subdomain to req object
    req.subdomain = subdomain
    // rewrite the url to include the subdomain as a namespace parameter
    req.url = addSubdomainToRoute(req.url, subdomain)
    return next()
  }
}
