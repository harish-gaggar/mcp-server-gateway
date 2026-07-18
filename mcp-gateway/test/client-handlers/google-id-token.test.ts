import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuthorizationError, TokenError } from '~/oauth/spec'
import { TOKEN_EXCHANGE_GRANT } from '~/constants'

// Mock jose before importing the handler so createRemoteJWKSet never hits the network
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
  jwtVerify: vi.fn(),
}))

import { jwtVerify } from 'jose'
import {
  GoogleIdTokenClientHandler,
  GoogleIdTokenConfig,
  GOOGLE_ID_TOKEN_CLIENT_ID,
} from '~/client-handlers/google-id-token'
import type { ClientMetadataHandler } from '~/client-handlers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = new URL('https://gateway.example.com')

function makeConfig(
  overrides: Record<string, unknown> = {}
): GoogleIdTokenConfig {
  return GoogleIdTokenConfig.parse(overrides)
}

function makeHandler(
  overrides: Record<string, unknown> = {},
  baseUrl = BASE_URL
) {
  return new GoogleIdTokenClientHandler(makeConfig(overrides), baseUrl)
}

/** Simulate a successful jwtVerify with the given payload fields */
function mockToken(payload: Record<string, unknown>) {
  vi.mocked(jwtVerify).mockResolvedValueOnce({ payload } as never)
}

/** Simulate a jwtVerify failure */
function mockTokenError() {
  vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('bad token'))
}

const USER_EMAIL = 'user@example.com'
const SA_EMAIL = 'my-sa@my-project.iam.gserviceaccount.com'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleIdTokenClientHandler', () => {
  beforeEach(() => {
    vi.mocked(jwtVerify).mockReset()
  })

  // ---- canHandle -----------------------------------------------------------

  describe('canHandle', () => {
    it('returns true for the literal client id', () => {
      const handler = makeHandler()
      expect(handler.canHandle(GOOGLE_ID_TOKEN_CLIENT_ID)).toBe(true)
    })

    it('returns false for any other string', () => {
      const handler = makeHandler()
      expect(handler.canHandle('google-id-token-extra')).toBe(false)
      expect(handler.canHandle('')).toBe(false)
      expect(handler.canHandle('https://example.com')).toBe(false)
    })
  })

  // ---- loadClientMetadata --------------------------------------------------

  describe('loadClientMetadata', () => {
    it('throws AuthorizationError with unauthorized_client code', () => {
      const handler = makeHandler() as ClientMetadataHandler
      expect(() =>
        handler.loadClientMetadata('ns', GOOGLE_ID_TOKEN_CLIENT_ID)
      ).toThrow(AuthorizationError)
      try {
        handler.loadClientMetadata('ns', GOOGLE_ID_TOKEN_CLIENT_ID)
      } catch (e) {
        expect((e as AuthorizationError).code).toBe('unauthorized_client')
      }
    })
  })

  // ---- validateClientAuth --------------------------------------------------

  describe('validateClientAuth', () => {
    describe('token verification', () => {
      it('throws TokenError for a wrong client_id', async () => {
        const handler = makeHandler()
        await expect(
          handler.validateClientAuth('ns', 'wrong-client', 'some-token')
        ).rejects.toThrow(TokenError)
      })

      it('throws TokenError when jwtVerify rejects', async () => {
        mockTokenError()
        const handler = makeHandler()
        await expect(
          handler.validateClientAuth(
            'ns',
            GOOGLE_ID_TOKEN_CLIENT_ID,
            'bad-token'
          )
        ).rejects.toThrow(TokenError)
      })

      it('throws TokenError when the token has no email claim', async () => {
        mockToken({})
        const handler = makeHandler()
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).rejects.toThrow(TokenError)
      })
    })

    describe('user tokens', () => {
      it('returns metadata with the email as client_id on success (no hd restriction)', async () => {
        mockToken({ email: USER_EMAIL })
        const handler = makeHandler()
        const result = await handler.validateClientAuth(
          'ns',
          GOOGLE_ID_TOKEN_CLIENT_ID,
          'token'
        )
        expect(result.client_id).toBe(USER_EMAIL)
        expect(result.grant_types).toEqual([TOKEN_EXCHANGE_GRANT])
        expect(result.redirect_uris).toEqual([])
      })

      it('accepts a user token whose hd is in allowed_hd', async () => {
        mockToken({ email: USER_EMAIL, hd: 'example.com' })
        const handler = makeHandler({ allowed_hd: ['example.com'] })
        const result = await handler.validateClientAuth(
          'ns',
          GOOGLE_ID_TOKEN_CLIENT_ID,
          'token'
        )
        expect(result.client_id).toBe(USER_EMAIL)
      })

      it('throws TokenError when hd is missing and allowed_hd is set', async () => {
        mockToken({ email: USER_EMAIL })
        const handler = makeHandler({ allowed_hd: ['example.com'] })
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).rejects.toThrow(TokenError)
      })

      it('throws TokenError when hd does not match allowed_hd', async () => {
        mockToken({ email: USER_EMAIL, hd: 'other.com' })
        const handler = makeHandler({ allowed_hd: ['example.com'] })
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).rejects.toThrow(TokenError)
      })
    })

    describe('service account tokens', () => {
      it('returns metadata for a service account with no restrictions', async () => {
        mockToken({ email: SA_EMAIL })
        const handler = makeHandler()
        const result = await handler.validateClientAuth(
          'ns',
          GOOGLE_ID_TOKEN_CLIENT_ID,
          'token'
        )
        expect(result.client_id).toBe(SA_EMAIL)
        expect(result.grant_types).toEqual([TOKEN_EXCHANGE_GRANT])
      })

      it('accepts a service account in the allowed list', async () => {
        mockToken({ email: SA_EMAIL })
        const handler = makeHandler({ allowed_service_accounts: [SA_EMAIL] })
        const result = await handler.validateClientAuth(
          'ns',
          GOOGLE_ID_TOKEN_CLIENT_ID,
          'token'
        )
        expect(result.client_id).toBe(SA_EMAIL)
      })

      it('throws TokenError when SA is not in the allowed list', async () => {
        mockToken({ email: SA_EMAIL })
        const handler = makeHandler({
          allowed_service_accounts: ['other-sa@proj.iam.gserviceaccount.com'],
        })
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).rejects.toThrow(TokenError)
      })

      it('accepts a SA token with the correct audience when require_audience is true', async () => {
        mockToken({ email: SA_EMAIL, aud: BASE_URL.origin })
        const handler = makeHandler({ require_audience: true })
        const result = await handler.validateClientAuth(
          'ns',
          GOOGLE_ID_TOKEN_CLIENT_ID,
          'token'
        )
        expect(result.client_id).toBe(SA_EMAIL)
      })

      it('accepts a SA token whose audience array contains the base URL origin', async () => {
        mockToken({
          email: SA_EMAIL,
          aud: [BASE_URL.origin, 'https://other.example.com'],
        })
        const handler = makeHandler({ require_audience: true })
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).resolves.toBeTruthy()
      })

      it('throws TokenError when audience is missing and require_audience is true', async () => {
        mockToken({ email: SA_EMAIL })
        const handler = makeHandler({ require_audience: true })
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).rejects.toThrow(TokenError)
      })

      it('throws TokenError when audience does not match and require_audience is true', async () => {
        mockToken({ email: SA_EMAIL, aud: 'https://wrong.example.com' })
        const handler = makeHandler({ require_audience: true })
        await expect(
          handler.validateClientAuth('ns', GOOGLE_ID_TOKEN_CLIENT_ID, 'token')
        ).rejects.toThrow(TokenError)
      })

      it('does not enforce audience for user tokens even when require_audience is true', async () => {
        mockToken({ email: USER_EMAIL })
        const handler = makeHandler({ require_audience: true })
        const result = await handler.validateClientAuth(
          'ns',
          GOOGLE_ID_TOKEN_CLIENT_ID,
          'token'
        )
        expect(result.client_id).toBe(USER_EMAIL)
      })
    })
  })
})
