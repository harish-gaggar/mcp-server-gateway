import { describe, it, expect, vi } from 'vitest'
import { CompositeClientMetadataHandler } from '~/client-handlers/composite'
import { AuthorizationError, TokenError } from '~/oauth/spec'
import type { ClientMetadataHandler } from '~/client-handlers/shared'

function makeHandler(
  canHandleResult: boolean,
  overrides: Partial<ClientMetadataHandler> = {}
): ClientMetadataHandler {
  return {
    canHandle: vi.fn().mockReturnValue(canHandleResult),
    loadClientMetadata: vi
      .fn()
      .mockResolvedValue({ redirect_uris: [], application_type: 'web' }),
    validateClientAuth: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('CompositeClientMetadataHandler', () => {
  it('throws when constructed with an empty handler list', () => {
    expect(() => new CompositeClientMetadataHandler([])).toThrow(
      'At least one handler must be provided'
    )
  })

  describe('canHandle', () => {
    it('returns true if any handler can handle the client ID', () => {
      const composite = new CompositeClientMetadataHandler([
        makeHandler(false),
        makeHandler(true),
      ])
      expect(composite.canHandle('some-client')).toBe(true)
    })

    it('returns false if no handler can handle the client ID', () => {
      const composite = new CompositeClientMetadataHandler([
        makeHandler(false),
        makeHandler(false),
      ])
      expect(composite.canHandle('unknown')).toBe(false)
    })
  })

  describe('loadClientMetadata', () => {
    it('delegates to the first matching handler', async () => {
      const h1 = makeHandler(false)
      const h2 = makeHandler(true)
      const composite = new CompositeClientMetadataHandler([h1, h2])
      await composite.loadClientMetadata(
        'ns',
        'client-id',
        'https://cb.example.com'
      )
      expect(h1.loadClientMetadata).not.toHaveBeenCalled()
      expect(h2.loadClientMetadata).toHaveBeenCalledWith(
        'ns',
        'client-id',
        'https://cb.example.com'
      )
    })

    it('throws AuthorizationError when no handler matches', () => {
      const composite = new CompositeClientMetadataHandler([makeHandler(false)])
      expect(() => composite.loadClientMetadata('ns', 'client-id')).toThrow(
        AuthorizationError
      )
    })
  })

  describe('validateClientAuth', () => {
    it('delegates to the first matching handler', async () => {
      const h1 = makeHandler(false)
      const h2 = makeHandler(true)
      const composite = new CompositeClientMetadataHandler([h1, h2])
      await composite.validateClientAuth('ns', 'client-id', 'secret')
      expect(h1.validateClientAuth).not.toHaveBeenCalled()
      expect(h2.validateClientAuth).toHaveBeenCalledWith(
        'ns',
        'client-id',
        'secret'
      )
    })

    it('throws TokenError when no handler matches', () => {
      const composite = new CompositeClientMetadataHandler([makeHandler(false)])
      expect(() =>
        composite.validateClientAuth('ns', 'unknown-client', 'secret')
      ).toThrow(TokenError)
    })
  })
})
