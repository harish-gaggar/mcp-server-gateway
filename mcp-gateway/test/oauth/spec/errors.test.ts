import { describe, it, expect, vi } from 'vitest'
import {
  OauthError,
  AuthorizationError,
  TokenError,
  RegistrationError,
} from '~/oauth/spec/errors'

// Minimal mock for express Response
function mockRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    redirect: vi.fn(),
    headersSent: false,
  }
  res.status.mockReturnValue(res)
  return res
}

describe('OauthError', () => {
  it('sets message, code, and default status 400', () => {
    const err = new OauthError('oops', 'invalid_request')
    expect(err.message).toBe('oops')
    expect(err.code).toBe('invalid_request')
    expect(err.status).toBe(400)
    expect(err).toBeInstanceOf(Error)
  })

  it('accepts a custom status', () => {
    const err = new OauthError('nope', 'invalid_request', 403)
    expect(err.status).toBe(403)
  })

  it('toJSON returns { error, error_description }', () => {
    const err = new OauthError('bad', 'invalid_scope')
    expect(err.toJSON()).toEqual({
      error: 'invalid_scope',
      error_description: 'bad',
    })
  })

  it('handleResponse sends status + JSON', () => {
    const res = mockRes() as unknown as import('express').Response
    const err = new OauthError('msg', 'invalid_request', 400)
    err.handleResponse(res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(err.toJSON())
  })
})

describe('AuthorizationError', () => {
  it('has name AuthorizationError', () => {
    const err = new AuthorizationError('denied', 'access_denied')
    expect(err.name).toBe('AuthorizationError')
  })

  it('handleResponse sends JSON when redirectUri is null', () => {
    const res = mockRes() as unknown as import('express').Response
    const err = new AuthorizationError('denied', 'access_denied', null)
    err.handleResponse(res)
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalled()
  })

  it('handleResponse redirects with error params when redirectUri is set', () => {
    const res = mockRes() as unknown as import('express').Response
    const err = new AuthorizationError(
      'bad request',
      'invalid_request',
      'https://client.example.com/callback'
    )
    err.handleResponse(res)
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('error=invalid_request')
    )
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      expect.stringContaining('error_description=bad+request')
    )
  })
})

describe('TokenError', () => {
  it('has name TokenError', () => {
    const err = new TokenError('invalid', 'invalid_grant')
    expect(err.name).toBe('TokenError')
  })

  it('sets status 400 for non-server_error codes', () => {
    const codes = [
      'invalid_request',
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'unsupported_grant_type',
      'invalid_scope',
    ] as const
    for (const code of codes) {
      expect(new TokenError('x', code).status).toBe(400)
    }
  })

  it('sets status 500 for server_error', () => {
    expect(new TokenError('boom', 'server_error').status).toBe(500)
  })
})

describe('RegistrationError', () => {
  it('has name RegistrationError', () => {
    const err = new RegistrationError('bad uri', 'invalid_redirect_uri')
    expect(err.name).toBe('RegistrationError')
  })

  it('sets status 400 for non-server_error codes', () => {
    const codes = [
      'invalid_redirect_uri',
      'invalid_client_metadata',
      'invalid_software_statement',
      'unapproved_software_statement',
    ] as const
    for (const code of codes) {
      expect(new RegistrationError('x', code).status).toBe(400)
    }
  })

  it('sets status 500 for server_error', () => {
    expect(new RegistrationError('boom', 'server_error').status).toBe(500)
  })
})
