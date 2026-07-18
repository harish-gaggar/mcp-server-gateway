import { describe, it, expect, vi } from 'vitest'
import {
  DynamicClientHandler,
  DynamicClientConfig,
} from '~/client-handlers/dcr'
import { MemoryStorage } from '~/storage/memory'
import { AuthorizationError, RegistrationError, TokenError } from '~/oauth/spec'

function makeStorage() {
  return MemoryStorage.create()
}

function makeConfig(
  overrides: Partial<DynamicClientConfig> = {}
): DynamicClientConfig {
  return DynamicClientConfig.parse({
    ...overrides,
  })
}

const baseRequest = {
  redirect_uris: ['https://client.example.com/callback'],
  application_type: 'web' as const,
}

describe('DynamicClientHandler', () => {
  describe('canHandle', () => {
    it('returns true for a 32-char lowercase hex string', () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      expect(handler.canHandle('a'.repeat(32))).toBe(true)
      expect(handler.canHandle('0f'.repeat(16))).toBe(true)
    })

    it('returns false for non-hex or wrong-length strings', () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      expect(handler.canHandle('too-short')).toBe(false)
      expect(handler.canHandle('G'.repeat(32))).toBe(false)
      expect(handler.canHandle('a'.repeat(33))).toBe(false)
      expect(handler.canHandle('https://url.example.com/client')).toBe(false)
    })
  })

  describe('register', () => {
    it('returns client_id, client_secret, and client_secret_expires_at on success', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      const result = await handler.register('ns', baseRequest)
      expect(result.client_id).toMatch(/^[a-f0-9]{32}$/)
      expect(typeof result.client_secret).toBe('string')
      expect(result.client_secret.length).toBeGreaterThan(0)
      expect(typeof result.client_secret_expires_at).toBe('number')
    })

    it('echoes back the registration request fields', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      const req = { ...baseRequest, client_name: 'My App' }
      const result = await handler.register('ns', req)
      expect(result.redirect_uris).toEqual(req.redirect_uris)
      expect(result.client_name).toBe('My App')
    })

    it('throws RegistrationError when no redirect_uri is valid', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      await expect(
        handler.register('ns', {
          redirect_uris: ['http://evil.com/hack'],
          application_type: 'web',
        })
      ).rejects.toThrow(RegistrationError)
    })

    it('throws RegistrationError when response_types excludes "code"', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      await expect(
        handler.register('ns', {
          ...baseRequest,
          response_types: ['token'],
        })
      ).rejects.toThrow(RegistrationError)
    })

    it('throws RegistrationError when grant_types excludes "authorization_code"', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      await expect(
        handler.register('ns', {
          ...baseRequest,
          grant_types: ['client_credentials'],
        })
      ).rejects.toThrow(RegistrationError)
    })

    it('allows allowed_redirect_uris regex to gate registration', async () => {
      // allowed_redirect_uris goes through regexPatternList which expects an array of strings,
      // so we must pass raw config to DynamicClientConfig.parse rather than use makeConfig()
      const config = DynamicClientConfig.parse({
        allowed_redirect_uris: ['^https:\\/\\/allowed\\.com'],
      })
      const handler = new DynamicClientHandler(config, makeStorage())
      await expect(
        handler.register('ns', {
          redirect_uris: ['https://other.com/cb'],
          application_type: 'web',
        })
      ).rejects.toThrow(RegistrationError)
    })
  })

  describe('loadClientMetadata', () => {
    it('returns client metadata (without secret hash) for a registered client', async () => {
      const storage = makeStorage()
      const handler = new DynamicClientHandler(makeConfig(), storage)
      const { client_id } = await handler.register('ns', baseRequest)
      const metadata = await handler.loadClientMetadata('ns', client_id)
      expect(metadata.client_id).toBe(client_id)
      expect(
        (metadata as Record<string, unknown>).client_secret_hash
      ).toBeUndefined()
    })

    it('throws AuthorizationError for an unknown client', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      await expect(
        handler.loadClientMetadata('ns', 'a'.repeat(32))
      ).rejects.toThrow(AuthorizationError)
    })
  })

  describe('validateClientAuth', () => {
    it('resolves without error when credentials are correct', async () => {
      const storage = makeStorage()
      const handler = new DynamicClientHandler(makeConfig(), storage)
      const { client_id, client_secret } = await handler.register(
        'ns',
        baseRequest
      )
      await expect(
        handler.validateClientAuth('ns', client_id, client_secret!)
      ).resolves.toEqual({ ...baseRequest, client_id })
    })

    it('throws TokenError for an unknown client', async () => {
      const handler = new DynamicClientHandler(makeConfig(), makeStorage())
      await expect(
        handler.validateClientAuth('ns', 'a'.repeat(32), 'secret')
      ).rejects.toThrow(TokenError)
    })

    it('throws TokenError for a wrong secret', async () => {
      const storage = makeStorage()
      const handler = new DynamicClientHandler(makeConfig(), storage)
      const { client_id } = await handler.register('ns', baseRequest)
      await expect(
        handler.validateClientAuth('ns', client_id, 'wrong-secret')
      ).rejects.toThrow(TokenError)
    })

    it('calls store.refresh when refresh_ttl_on_use is true', async () => {
      const storage = makeStorage()
      // DynamicClientHandler calls storage.withSchema() internally which creates a new instance.
      // We intercept withSchema to spy on the resulting store's refresh method.
      const innerStore = MemoryStorage.create()
      const refreshSpy = vi.spyOn(innerStore, 'refresh')
      vi.spyOn(storage, 'withSchema').mockReturnValue(
        innerStore as ReturnType<typeof storage.withSchema>
      )
      const handler = new DynamicClientHandler(
        makeConfig({ refresh_ttl_on_use: true }),
        storage
      )
      const { client_id, client_secret } = await handler.register(
        'ns',
        baseRequest
      )
      await handler.validateClientAuth('ns', client_id, client_secret!)
      expect(refreshSpy).toHaveBeenCalled()
    })

    it('does not call store.refresh when refresh_ttl_on_use is false', async () => {
      const storage = makeStorage()
      const refreshSpy = vi.spyOn(storage, 'refresh')
      const handler = new DynamicClientHandler(
        makeConfig({ refresh_ttl_on_use: false }),
        storage
      )
      const { client_id, client_secret } = await handler.register(
        'ns',
        baseRequest
      )
      await handler.validateClientAuth('ns', client_id, client_secret!)
      expect(refreshSpy).not.toHaveBeenCalled()
    })
  })
})
