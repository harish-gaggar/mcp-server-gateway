import type { AccessTokenPayload } from '~/oauth/token'

declare global {
  namespace Express {
    interface Request {
      // if enable_subdomains in on, this will contain the subdomain of the route, if any set
      subdomain?: string

      clientAuth?: {
        clientId: string
        clientSecret: string
      }

      // parsed access token when middleware is in use
      bearerToken?: AccessTokenPayload
    }
  }
}
