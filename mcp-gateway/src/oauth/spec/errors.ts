import type { Response } from 'express'

export class OauthError<Codes extends string> extends Error {
  code: Codes
  status: number

  constructor(message: string, code: Codes, status = 400) {
    super(message)

    this.name = this.constructor.name
    this.code = code
    this.status = status

    Error.captureStackTrace(this, this.constructor)
  }

  toJSON() {
    return {
      error: this.code,
      error_description: this.message,
    }
  }

  handleResponse(res: Response) {
    res.status(this.status).json(this.toJSON())
  }
}

export class AuthorizationError extends OauthError<
  | 'invalid_request'
  | 'unauthorized_client'
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
> {
  redirectUri: URL | string | null

  constructor(
    message: string,
    code: AuthorizationError['code'],
    redirectUri: URL | string | null = null
  ) {
    super(message, code)
    this.name = this.constructor.name
    this.redirectUri = redirectUri

    Error.captureStackTrace(this, this.constructor)
  }

  handleResponse(res: Response) {
    if (!this.redirectUri) {
      super.handleResponse(res)
      return
    }

    const url = new URL(this.redirectUri)
    url.searchParams.set('error', this.code)
    url.searchParams.set('error_description', this.message)

    return res.redirect(302, url.toString())
  }
}

export class TokenError extends OauthError<
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target'
  | 'server_error'
> {
  constructor(message: string, code: TokenError['code']) {
    super(message, code, code === 'server_error' ? 500 : 400)
    this.name = this.constructor.name

    Error.captureStackTrace(this, this.constructor)
  }
}

export class RegistrationError extends OauthError<
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'invalid_software_statement'
  | 'unapproved_software_statement'
  | 'server_error'
> {
  constructor(message: string, code: RegistrationError['code']) {
    super(message, code, code === 'server_error' ? 500 : 400)
    this.name = this.constructor.name

    Error.captureStackTrace(this, this.constructor)
  }
}
