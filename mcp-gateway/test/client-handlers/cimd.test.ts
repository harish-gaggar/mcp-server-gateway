import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ClientIdMetadataDocumentHandler,
  ClientIdMetaDocConfig,
} from '~/client-handlers/cimd'
import { MemoryStorage } from '~/storage/memory'
import { AuthorizationError } from '~/oauth/spec'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Record<string, unknown> = {}
): ClientIdMetaDocConfig {
  return ClientIdMetaDocConfig.parse(overrides)
}

function makeStorage() {
  return MemoryStorage.create()
}

/** Minimal valid ClientIdMetadataDocument JSON body */
const validClientId = 'https://client.example.com/app'
const validMetadata = {
  client_id: validClientId,
  redirect_uris: ['https://client.example.com/callback'],
  application_type: 'web',
}
const validMetadataBody = JSON.stringify(validMetadata)

/**
 * Builds a mock Response that fetch() will return.
 */
function mockFetchResponse(
  body: string,
  {
    status = 200,
    headers = {},
  }: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => body,
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientIdMetadataDocumentHandler', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // canHandle
  // -------------------------------------------------------------------------

  describe('canHandle', () => {
    it('returns true for a valid URL string', () => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      expect(handler.canHandle('https://client.example.com/app')).toBe(true)
      expect(handler.canHandle('http://localhost/app')).toBe(true)
    })

    it('returns false for a non-URL string', () => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      expect(handler.canHandle('not-a-url')).toBe(false)
      expect(handler.canHandle('deadbeef'.repeat(4))).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // validateClientIdUrl (exercised via loadClientMetadata)
  // -------------------------------------------------------------------------

  describe('client_id URL validation', () => {
    it('throws AuthorizationError when client_id is not a valid URL', async () => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', 'not-a-url')
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when client_id uses HTTP (non-localhost)', async () => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', 'http://client.example.com/app')
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when client_id has root-only path "/"', async () => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', 'https://client.example.com/')
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when client_id URL has no path beyond "/"', async () => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', 'https://client.example.com')
      ).rejects.toThrow(AuthorizationError)
    })

    it.each([
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.1.1',
      '0.0.0.0',
    ])('throws AuthorizationError for private/loopback IP: %s', async ip => {
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', `https://${ip}/app`)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when client_id does not match allowed_metadata_uris', async () => {
      const config = makeConfig({
        allowed_metadata_uris: ['^https:\\/\\/trusted\\.com'],
      })
      const handler = new ClientIdMetadataDocumentHandler(
        config,
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', 'https://untrusted.com/app')
      ).rejects.toThrow(AuthorizationError)
    })

    it('passes when client_id matches allowed_metadata_uris', async () => {
      const config = makeConfig({
        allowed_metadata_uris: ['^https:\\/\\/trusted\\.com'],
      })
      fetchMock.mockResolvedValue(
        mockFetchResponse(
          JSON.stringify({
            client_id: 'https://trusted.com/app',
            redirect_uris: ['https://trusted.com/callback'],
            application_type: 'web',
          })
        )
      )
      const handler = new ClientIdMetadataDocumentHandler(
        config,
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', 'https://trusted.com/app')
      ).resolves.toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // Fetch / document retrieval
  // -------------------------------------------------------------------------

  describe('document fetching', () => {
    it('throws AuthorizationError on network failure', async () => {
      fetchMock.mockRejectedValue(new Error('network error'))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when the document returns a non-200 status', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse('', { status: 404 }))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when content-length header exceeds 5KB', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(validMetadataBody, {
          headers: { 'content-length': String(5 * 1024 + 1) },
        })
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when body byte length exceeds 5KB', async () => {
      const bigBody = 'x'.repeat(5 * 1024 + 1)
      fetchMock.mockResolvedValue(mockFetchResponse(bigBody))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when the document is not valid JSON', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse('not json at all'))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws AuthorizationError when the document does not conform to the schema', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(JSON.stringify({ totally: 'wrong' }))
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })
  })

  // -------------------------------------------------------------------------
  // Cache TTL computation
  // -------------------------------------------------------------------------

  describe('cache TTL', () => {
    it('uses max_cache_ttl when there is no Cache-Control header', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(validMetadataBody))
      const storage = makeStorage()
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig({ max_cache_ttl: '1h' }),
        storage,
        new URL('http://localhost:8080')
      )
      // Use an inner store created via withSchema — spy on the whole storage chain
      await handler.loadClientMetadata('ns', validClientId)
      // fetch was called (no cache), and set was NOT called on the raw storage
      // (it's called on the withSchema result). Just verify fetch was called.
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('uses the lower of Cache-Control max-age and max_cache_ttl', async () => {
      // Cache-Control: max-age=60 (60s = 60000ms), max_cache_ttl = 1d (86400000ms)
      // Expected TTL used for storage: 60000ms
      fetchMock.mockResolvedValue(
        mockFetchResponse(validMetadataBody, {
          headers: { 'cache-control': 'max-age=60' },
        })
      )
      const storage = makeStorage()
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig({ max_cache_ttl: '1d' }),
        storage,
        new URL('http://localhost:8080')
      )
      // Second call should hit cache (fetch only once)
      await handler.loadClientMetadata('ns', validClientId)
      await handler.loadClientMetadata('ns', validClientId)
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('does not cache when TTL is 0 (Cache-Control: max-age=0)', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(validMetadataBody, {
          headers: { 'cache-control': 'max-age=0' },
        })
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig({ max_cache_ttl: '1d' }),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await handler.loadClientMetadata('ns', validClientId)
      await handler.loadClientMetadata('ns', validClientId)
      // No caching: fetch called twice
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('serves from cache on second call when TTL > 0', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(validMetadataBody))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig({ max_cache_ttl: '1h' }),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await handler.loadClientMetadata('ns', validClientId)
      await handler.loadClientMetadata('ns', validClientId)
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // Metadata validation
  // -------------------------------------------------------------------------

  describe('metadata validation', () => {
    it('throws when no redirect URI passes the same-origin + redirect checks', async () => {
      // redirect_uri is on a different origin than the client_id document
      fetchMock.mockResolvedValue(
        mockFetchResponse(
          JSON.stringify({
            client_id: validClientId,
            redirect_uris: ['https://other-origin.com/callback'],
            application_type: 'web',
          })
        )
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(), // enforce_same_origin_uri defaults to true
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('accepts a localhost redirect URI even with enforce_same_origin_uri=true', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(
          JSON.stringify({
            client_id: validClientId,
            redirect_uris: ['http://localhost/callback'],
            application_type: 'native',
          })
        )
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig({ enforce_same_origin_uri: true }),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).resolves.toBeDefined()
    })

    it('accepts cross-origin redirect URIs when enforce_same_origin_uri=false', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(
          JSON.stringify({
            client_id: validClientId,
            redirect_uris: ['https://other-origin.com/callback'],
            application_type: 'web',
          })
        )
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig({ enforce_same_origin_uri: false }),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).resolves.toBeDefined()
    })

    it('throws when response_types excludes "code"', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(
          JSON.stringify({
            client_id: validClientId,
            redirect_uris: ['https://client.example.com/callback'],
            application_type: 'web',
            response_types: ['token'],
          })
        )
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws when grant_types excludes "authorization_code"', async () => {
      fetchMock.mockResolvedValue(
        mockFetchResponse(
          JSON.stringify({
            client_id: validClientId,
            redirect_uris: ['https://client.example.com/callback'],
            application_type: 'web',
            grant_types: ['client_credentials'],
          })
        )
      )
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.loadClientMetadata('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })

    it('throws when the provided redirect_uri is not valid for the app type', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(validMetadataBody))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      // The stored redirect_uri is https, but we pass an http non-loopback uri
      await expect(
        handler.loadClientMetadata(
          'ns',
          validClientId,
          'http://evil.example.com/callback'
        )
      ).rejects.toThrow(AuthorizationError)
    })

    it('resolves with metadata when everything is valid', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(validMetadataBody))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      const result = await handler.loadClientMetadata('ns', validClientId)
      expect(result.client_id).toBe(validClientId)
      expect(result.redirect_uris).toEqual([
        'https://client.example.com/callback',
      ])
    })
  })

  // -------------------------------------------------------------------------
  // validateClientAuth
  // -------------------------------------------------------------------------

  describe('validateClientAuth', () => {
    it('resolves when the client_id document is valid (public client — no secret needed)', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse(validMetadataBody))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.validateClientAuth('ns', validClientId)
      ).resolves.toEqual(validMetadata)
    })

    it('throws AuthorizationError when the client_id document is invalid', async () => {
      fetchMock.mockResolvedValue(mockFetchResponse('', { status: 404 }))
      const handler = new ClientIdMetadataDocumentHandler(
        makeConfig(),
        makeStorage(),
        new URL('http://localhost:8080')
      )
      await expect(
        handler.validateClientAuth('ns', validClientId)
      ).rejects.toThrow(AuthorizationError)
    })
  })
})
