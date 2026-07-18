import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod/v4'
import {
  parseBody,
  getConsentKey,
  getNonceKey,
  getOAuthErrorHandler,
  RequestFinishedError,
} from '~/routes/helpers'
import { OauthError } from '~/oauth/spec'
import type { Logger } from '~/logger'

// Minimal mock for express Response
function mockRes(headersSent = false) {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    headersSent,
  }
  res.status.mockReturnValue(res)
  return res
}

function mockLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger
}

describe('parseBody', () => {
  const schema = z.object({ name: z.string() })

  it('returns parsed data for valid input', () => {
    const result = parseBody(schema, { name: 'alice' })
    expect(result).toEqual({ name: 'alice' })
  })

  it('throws OauthError for invalid input', () => {
    expect(() => parseBody(schema, { name: 123 })).toThrow(OauthError)
    expect(() => parseBody(schema, null)).toThrow(OauthError)
    expect(() => parseBody(schema, undefined)).toThrow(OauthError)
  })

  it('thrown OauthError has code invalid_request', () => {
    try {
      parseBody(schema, {})
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(OauthError)
      expect((e as OauthError<string>).code).toBe('invalid_request')
    }
  })
})

describe('getConsentKey', () => {
  it('returns a consistently formatted key', () => {
    const key = getConsentKey('ns', 'github', 'client-123')
    // clientId base64url-encoded: Buffer.from('client-123').toString('base64url')
    const encoded = Buffer.from('client-123').toString('base64url')
    expect(key).toBe(`consent_ns_github_${encoded}`)
  })
})

describe('getNonceKey', () => {
  it('returns a consistently formatted key', () => {
    const key = getNonceKey('ns', 'github', 'client-123')
    const encoded = Buffer.from('client-123').toString('base64url')
    expect(key).toBe(`nonce_ns_github_${encoded}`)
  })
})

describe('getOAuthErrorHandler', () => {
  it('calls error.handleResponse for OauthError instances', () => {
    const logger = mockLogger()
    const handler = getOAuthErrorHandler(logger)
    const err = new OauthError('test error', 'invalid_request')
    const handleResponseSpy = vi
      .spyOn(err, 'handleResponse')
      .mockImplementation(() => {})
    const res = mockRes() as unknown as import('express').Response

    handler(err, {} as import('express').Request, res, vi.fn())

    expect(handleResponseSpy).toHaveBeenCalledWith(res)
  })

  it('ignores RequestFinishedError when headers are already sent', () => {
    const logger = mockLogger()
    const handler = getOAuthErrorHandler(logger)
    const err = new RequestFinishedError()
    const res = mockRes(true) as unknown as import('express').Response

    expect(() =>
      handler(err, {} as import('express').Request, res, vi.fn())
    ).not.toThrow()

    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 500 for unknown errors', () => {
    const logger = mockLogger()
    const handler = getOAuthErrorHandler(logger)
    const err = new Error('something unexpected')
    const res = mockRes() as unknown as import('express').Response

    handler(err, {} as import('express').Request, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    })
  })

  it('logs unknown errors', () => {
    const logger = mockLogger()
    const handler = getOAuthErrorHandler(logger)
    const err = new Error('weird')
    const res = mockRes() as unknown as import('express').Response

    handler(err, {} as import('express').Request, res, vi.fn())

    expect(logger.error).toHaveBeenCalled()
  })
})

describe('RequestFinishedError', () => {
  it('is an instance of Error', () => {
    expect(new RequestFinishedError()).toBeInstanceOf(Error)
  })

  it('has name RequestFinishedError', () => {
    expect(new RequestFinishedError().name).toBe('RequestFinishedError')
  })
})
