import { AuthorizationError, TokenError } from '~/oauth/spec'

import type { ClientMetadataHandler } from './shared'

/**
 * A composite handler that aggregates multiple ClientMetadataHandlers and delegates calls to the appropriate one based on client ID.
 */
export class CompositeClientMetadataHandler implements ClientMetadataHandler {
  #handlers: ClientMetadataHandler[]

  constructor(handlers: ClientMetadataHandler[]) {
    if (!handlers.length) {
      throw new Error('At least one handler must be provided')
    }

    this.#handlers = handlers
  }

  canHandle(clientId: string): boolean {
    return this.#handlers.some(handler => handler.canHandle(clientId))
  }

  loadClientMetadata(
    namespace: string,
    clientId: string,
    redirectUri?: string
  ) {
    const handler = this.#handlers.find(h => h.canHandle(clientId))
    if (!handler) {
      throw new AuthorizationError(
        'No handler found for this client id',
        'unauthorized_client'
      )
    }

    return handler.loadClientMetadata(namespace, clientId, redirectUri)
  }

  validateClientAuth(
    namespace: string,
    clientId: string,
    clientSecret: string
  ) {
    const handler = this.#handlers.find(h => h.canHandle(clientId))
    if (!handler) {
      throw new TokenError(
        'No handler found for this client id',
        'invalid_client'
      )
    }

    return handler.validateClientAuth(namespace, clientId, clientSecret)
  }
}
