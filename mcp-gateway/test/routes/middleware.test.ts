import { describe, it, expect, vi } from 'vitest'
import {
  parseBasicAuth,
  clientAuth,
  rewriteSubdomainsMw,
} from '~/routes/middleware'
import type { Request, Response } from 'express'

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    get: vi.fn(),
    body: {},
    hostname: 'example.com',
    url: '/path',
    clientAuth: undefined,
    ...overrides,
  } as unknown as Request
}

function mockRes(): Response {
  const res = {
    sendStatus: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  }
  res.status.mockReturnValue(res)
  return res as unknown as Response
}

function encode(username: string, password: string) {
  return Buffer.from(`${username}:${password}`).toString('base64')
}

describe('parseBasicAuth', () => {
  it('returns username and password for a valid Basic auth header', () => {
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(
      `Basic ${encode('myclient', 'mysecret')}`
    )
    expect(parseBasicAuth(req)).toEqual({
      username: 'myclient',
      password: 'mysecret',
    })
  })

  it('is case-insensitive for the "Basic" prefix', () => {
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(
      `basic ${encode('client', 'secret')}`
    )
    expect(parseBasicAuth(req)).toEqual({
      username: 'client',
      password: 'secret',
    })
  })

  it('returns null when the Authorization header is missing', () => {
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    expect(parseBasicAuth(req)).toBeNull()
  })

  it('returns null for a Bearer token header', () => {
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue('Bearer sometoken')
    expect(parseBasicAuth(req)).toBeNull()
  })

  it('returns null for a malformed Basic header', () => {
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue('Basic !!invalid!!')
    // The regex should not match
    expect(parseBasicAuth(req)).toBeNull()
  })
})

describe('clientAuth middleware', () => {
  it('sets req.clientAuth from Basic auth header and calls next', () => {
    const mw = clientAuth()
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(
      `Basic ${encode('cl', 'sec')}`
    )
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect((req as unknown as Record<string, unknown>).clientAuth).toEqual({
      clientId: 'cl',
      clientSecret: 'sec',
    })
    expect(next).toHaveBeenCalled()
  })

  it('sets req.clientAuth from request body when Basic auth is absent', () => {
    const mw = clientAuth()
    const req = mockReq({
      body: { client_id: 'body-client', client_secret: 'body-secret' },
    })
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect((req as unknown as Record<string, unknown>).clientAuth).toEqual({
      clientId: 'body-client',
      clientSecret: 'body-secret',
    })
    expect(next).toHaveBeenCalled()
  })

  it('leaves clientSecret as empty string when not in body', () => {
    const mw = clientAuth()
    const req = mockReq({ body: { client_id: 'public-client' } })
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect((req as unknown as Record<string, unknown>).clientAuth).toEqual({
      clientId: 'public-client',
      clientSecret: '',
    })
  })

  it('does not set clientAuth when checkBody=false and no Basic auth', () => {
    const mw = clientAuth(false)
    const req = mockReq({ body: { client_id: 'ignored' } })
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect(
      (req as unknown as Record<string, unknown>).clientAuth
    ).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it('calls next when neither Basic auth nor body credentials exist', () => {
    const mw = clientAuth()
    const req = mockReq()
    ;(req.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect(next).toHaveBeenCalled()
  })
})

describe('rewriteSubdomainsMw', () => {
  const baseUrl = new URL('https://gateway.example.com')
  const allowed = new Set(['myapp', 'otherapp'])

  it('calls next without modifying URL for the base domain', () => {
    const mw = rewriteSubdomainsMw(baseUrl, allowed)
    const req = mockReq({ hostname: 'gateway.example.com', url: '/some/path' })
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect(next).toHaveBeenCalled()
    expect(req.url).toBe('/some/path')
  })

  it('returns 404 if allowed subdomains is null', () => {
    const mw = rewriteSubdomainsMw(baseUrl, null)
    const req = mockReq({
      hostname: 'myapp.gateway.example.com',
      url: '/oauth/token',
    })
    const res = mockRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 404 if hostname does not end with base domain', () => {
    const mw = rewriteSubdomainsMw(baseUrl, allowed)
    const req = mockReq({
      hostname: 'malicious.com',
      url: '/oauth/token',
    })
    const res = mockRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('rewrites URL to include the subdomain for an allowed subdomain', () => {
    const mw = rewriteSubdomainsMw(baseUrl, allowed)
    const req = mockReq({
      hostname: 'myapp.gateway.example.com',
      url: '/oauth/token',
    })
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect(next).toHaveBeenCalled()
    expect(req.url).toBe('/myapp/oauth/token')
  })

  it('handles root well-known routes', () => {
    const mw = rewriteSubdomainsMw(baseUrl, allowed)
    const req = mockReq({
      hostname: 'myapp.gateway.example.com',
      url: '/.well-known/openid-configuration',
    })
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect(next).toHaveBeenCalled()
    expect(req.url).toBe('/.well-known/openid-configuration/myapp')
  })

  it('handles standard well-known route', () => {
    const mw = rewriteSubdomainsMw(baseUrl, allowed)
    const req = mockReq({
      hostname: 'myapp.gateway.example.com',
      url: '/.well-known/oauth-protected-resource/mcp',
    })
    const next = vi.fn()
    mw(req, mockRes(), next)
    expect(next).toHaveBeenCalled()
    expect(req.url).toBe('/.well-known/oauth-protected-resource/myapp/mcp')
  })

  it('returns 404 for an unknown subdomain', () => {
    const mw = rewriteSubdomainsMw(baseUrl, allowed)
    const req = mockReq({
      hostname: 'unknown.gateway.example.com',
      url: '/path',
    })
    const res = mockRes()
    const next = vi.fn()
    mw(req, res, next)
    expect(res.sendStatus).toHaveBeenCalledWith(404)
    expect(next).not.toHaveBeenCalled()
  })
})
