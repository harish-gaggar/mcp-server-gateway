# MCP Gateway

HTTP gateway that proxies MCP clients to backend MCP servers with optional **per-user OAuth**.

> **New here?** Start with the [root README](../README.md) for the full step-by-step local setup (Google OAuth, GitHub OAuth App, Docker, Cursor, and testing).

## Architecture

```
MCP client (Cursor, oauth-client-demo, etc.)
        |
        |  POST/GET/DELETE /{namespace}/mcp
        v
   MCP Gateway (:8090)
        |
        +-- Redis (sessions, tokens, DCR)
        |
        +-- artifactory-mcp  →  JFrog API   (Google OAuth)
        +-- github-mcp       →  GitHub API  (GitHub OAuth)
```

Each backend is registered in `configs/secure-mcp-config.yml` (secure mode) or `configs/local-mcp-config.yml` (open mode). The gateway forwards MCP session headers and proxies to the upstream `/mcp` URL.

## Quick commands

```bash
# From mcp-gateway/ — assumes .env is configured (see root README)
docker compose up -d --build
docker compose ps
curl -s http://localhost:8090/health

# OAuth end-to-end test (opens browser)
python3 scripts/oauth-client-demo.py --namespace artifactory --tool list_repositories
python3 scripts/oauth-client-demo.py --namespace github --tool list_repositories

# Tear down
docker compose down
```

## Configuration modes

| Mode | `.env` | MCP config | OAuth config | Use case |
|------|--------|------------|--------------|----------|
| **Open** (default) | `OAUTH_CONFIG_FILE` unset | `local-mcp-config.yml` | `local-oauth-config.yml` (`{}`) | Smoke test without OAuth |
| **Secure** | `OAUTH_CONFIG_FILE=./configs/secure-oauth-config.yml` | `secure-mcp-config.yml` | `secure-oauth-config.yml` | Per-user OAuth (book demo) |

Secure mode environment variables (full list in `.env.example`):

| Variable | Required in secure mode | Description |
|----------|-------------------------|-------------|
| `TOKEN_ENCRYPTION_KEY` | Yes | `openssl rand -base64 32` |
| `GOOGLE_OAUTH_CLIENT_ID` | For Artifactory | Google Cloud OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | For Artifactory | Google Cloud OAuth secret |
| `GITHUB_OAUTH_CLIENT_ID` | For GitHub | GitHub OAuth App client ID |
| `GITHUB_OAUTH_CLIENT_SECRET` | For GitHub | GitHub OAuth App secret |
| `ARTIFACTORY_BASE_URL` | For live JFrog data | e.g. `https://YOUR.jfrog.io/artifactory` |
| `ARTIFACTORY_OIDC_PROVIDER_NAME` | Optional | True per-user JFrog RBAC via OIDC |
| `GITHUB_ALLOWED_USERS` | Optional | Comma-separated GitHub logins |
| `GATEWAY_BASE_URL` | Recommended | `http://localhost:8090` |

Both OAuth providers share one gateway callback URL:

```
http://localhost:8090/oauth2callback
```

## Config files

| File | Purpose |
|------|---------|
| `configs/secure-oauth-config.yml` | Google + GitHub OAuth providers |
| `configs/secure-mcp-config.yml` | Artifactory + GitHub backend routes |
| `configs/local-mcp-config.yml` | Open-mode backends (Docker hostnames) |
| `configs/local-oauth-config.yml` | Empty `{}` — no OAuth |
| `config.example.yml` | Full gateway option reference |

## Cursor integration

Wrappers in `scripts/` launch `mcp-remote` against the gateway over plain HTTP (`--allow-http`):

| Script | Gateway URL |
|--------|-------------|
| `scripts/artifactory-mcp-remote.sh` | `http://localhost:8090/artifactory/mcp` |
| `scripts/github-mcp-remote.sh` | `http://localhost:8090/github/mcp` |

One-time setup:

```bash
cd tools/mcp-remote-runner && npm install
```

Example `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "artifactory": {
      "command": "/ABSOLUTE/PATH/TO/mcp-gateway/scripts/artifactory-mcp-remote.sh"
    },
    "github": {
      "command": "/ABSOLUTE/PATH/TO/mcp-gateway/scripts/github-mcp-remote.sh"
    }
  }
}
```

## Development (host gateway)

Run the gateway on the host while backends stay in Docker:

```bash
docker compose up -d redis artifactory-mcp github-mcp
cp .env.example .env   # configure as in root README
npm install
npm run dev            # gateway on :8090
```

```bash
npm run build          # compile to dist/
npm run test           # lint + typecheck + unit tests
npm run test:e2e       # end-to-end via running gateway
```

Requires Node.js 24 and Redis.

## Monitoring (optional)

Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` in `.env` and bring up the stack under `monitoring/` for Grafana traces of OAuth flows and tool calls.

## curl smoke test (open mode only)

When running in open mode without OAuth:

```bash
curl -s -X POST http://localhost:8090/artifactory/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

In secure mode, unauthenticated calls return **401** with a `WWW-Authenticate` header pointing at OAuth discovery — that is expected.
