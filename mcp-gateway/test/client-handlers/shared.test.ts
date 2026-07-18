import { describe, it, expect } from 'vitest'
import {
  isLoopback,
  validUrl,
  validateRedirectUri,
  validateRedirectAllowedByClient,
} from '~/client-handlers/shared'
import type { ClientRegistrationRequest } from '~/oauth/spec'

function makeMetadata(redirectUris: string[]): ClientRegistrationRequest {
  return { redirect_uris: redirectUris } as unknown as ClientRegistrationRequest
}

describe('isLoopback', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['example.com', false],
    ['192.168.1.1', false],
    ['10.0.0.1', false],
  ])('isLoopback(%s) === %s', (hostname, expected) => {
    expect(isLoopback(new URL(`http://${hostname}/`))).toBe(expected)
  })
})

describe('validUrl', () => {
  it('returns a URL for a valid string', () => {
    const result = validUrl('https://example.com/path')
    expect(result).toBeInstanceOf(URL)
    expect(result?.hostname).toBe('example.com')
  })

  it('returns null for an invalid string', () => {
    expect(validUrl('not a url')).toBeNull()
    expect(validUrl('')).toBeNull()
    expect(validUrl('://broken')).toBeNull()
  })
})

describe('validateRedirectUri', () => {
  describe('allowedRegex filtering', () => {
    it('returns false when the URI does not match the allowedRegex', () => {
      const regex = /^https:\/\/allowed\.com/
      expect(validateRedirectUri('https://other.com/cb', 'web', regex)).toBe(
        false
      )
    })

    it('proceeds when the URI matches the allowedRegex', () => {
      const regex = /^https:\/\/allowed\.com/
      expect(validateRedirectUri('https://allowed.com/cb', 'web', regex)).toBe(
        true
      )
    })
  })

  describe('http URIs', () => {
    it('allows http loopback addresses', () => {
      expect(validateRedirectUri('http://localhost/cb', 'web')).toBe(true)
      expect(validateRedirectUri('http://127.0.0.1/cb', 'web')).toBe(true)
    })

    it('rejects http non-loopback addresses', () => {
      expect(validateRedirectUri('http://example.com/cb', 'web')).toBe(false)
      expect(validateRedirectUri('http://192.168.1.1/cb', 'native')).toBe(false)
    })
  })

  describe('https URIs', () => {
    it('allows https for web apps', () => {
      expect(validateRedirectUri('https://example.com/cb', 'web')).toBe(true)
    })

    it('allows https for native apps', () => {
      expect(validateRedirectUri('https://example.com/cb', 'native')).toBe(true)
    })
  })

  describe('custom scheme URIs', () => {
    it('allows custom schemes for native apps', () => {
      expect(validateRedirectUri('myapp://callback', 'native')).toBe(true)
    })

    it('allows custom schemes for web apps', () => {
      expect(validateRedirectUri('myapp://callback', 'web')).toBe(true)
    })
  })

  it('returns false for an unparseable URI', () => {
    expect(validateRedirectUri('not a url', 'web')).toBe(false)
  })
})

describe('validateRedirectAllowedByClient', () => {
  it('returns false for an unparseable redirect URI', () => {
    const meta = makeMetadata(['https://example.com/cb'])
    expect(validateRedirectAllowedByClient('not a url', meta)).toBe(false)
  })

  it('allows an exact match', () => {
    const meta = makeMetadata(['https://example.com/cb'])
    expect(
      validateRedirectAllowedByClient('https://example.com/cb', meta)
    ).toBe(true)
  })

  it('rejects a URI not in the allowed list', () => {
    const meta = makeMetadata(['https://example.com/cb'])
    expect(validateRedirectAllowedByClient('https://other.com/cb', meta)).toBe(
      false
    )
  })

  describe('loopback dynamic port matching', () => {
    it.each([
      ['http://localhost/cb', 'http://localhost:3000/cb'],
      ['http://127.0.0.1/cb', 'http://127.0.0.1:8080/cb'],
      ['http://[::1]/cb', 'http://[::1]:9000/cb'],
    ])('allows %s to match %s (dynamic port)', (allowed, provided) => {
      const meta = makeMetadata([allowed])
      expect(validateRedirectAllowedByClient(provided, meta)).toBe(true)
    })

    it('rejects loopback URI when protocol differs', () => {
      const meta = makeMetadata(['http://localhost/cb'])
      expect(
        validateRedirectAllowedByClient('https://localhost/cb', meta)
      ).toBe(false)
    })

    it('rejects loopback URI when hostname differs', () => {
      const meta = makeMetadata(['http://localhost/cb'])
      expect(validateRedirectAllowedByClient('http://127.0.0.1/cb', meta)).toBe(
        false
      )
    })

    it('rejects loopback URI when path differs', () => {
      const meta = makeMetadata(['http://localhost:2345/cb'])
      expect(
        validateRedirectAllowedByClient('http://localhost:1234/other', meta)
      ).toBe(false)
    })

    it('rejects when allowed is loopback but provided is not', () => {
      const meta = makeMetadata(['http://localhost/cb'])
      expect(
        validateRedirectAllowedByClient('http://example.com/cb', meta)
      ).toBe(false)
    })

    it('rejects when provided is loopback but allowed is not', () => {
      const meta = makeMetadata(['https://example.com/cb'])
      expect(validateRedirectAllowedByClient('http://localhost/cb', meta)).toBe(
        false
      )
    })
  })

  it('returns true when one of multiple allowed URIs matches', () => {
    const meta = makeMetadata([
      'https://example.com/cb',
      'https://other.com/cb',
    ])
    expect(validateRedirectAllowedByClient('https://other.com/cb', meta)).toBe(
      true
    )
  })

  it('skips unparseable entries in allowed list without throwing', () => {
    const meta = makeMetadata(['not a url', 'https://example.com/cb'])
    expect(
      validateRedirectAllowedByClient('https://example.com/cb', meta)
    ).toBe(true)
  })
})
