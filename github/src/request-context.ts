import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  /** User's GitHub OAuth access token forwarded by the MCP gateway. */
  token: string;
  login?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function requireGithubToken(): string {
  const ctx = requestContext.getStore();
  const token = ctx?.token;
  if (!token) {
    throw new Error(
      "Secure mode: no Authorization bearer on the request. " +
        "This server must be called through the OAuth-protected MCP gateway."
    );
  }
  return token;
}
