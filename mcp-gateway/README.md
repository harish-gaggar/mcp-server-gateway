# MCP Gateway

HTTP gateway that proxies MCP (Model Context Protocol) clients to one or more backend MCP servers. Supports OAuth for protected upstreams; local backends can run without auth.

This copy is adapted from the production MCP gateway for local development and book examples.

## Architecture

```
MCP client (Cursor, Inspector, etc.)
        |
        |  POST/GET/DELETE /{namespace}/mcp
        v
   MCP Gateway (:8090)
        |
        +-- Redis (sessions, tokens, DCR)
        |
        +-- Backend MCP servers (any streamable-HTTP /mcp endpoint)
              e.g. artifactory-mcp (:8091)
```

Each backend is registered in YAML under `mcp_servers`. The gateway forwards MCP session headers (`mcp-session-id`, `mcp-protocol-version`, etc.) and proxies GET/POST/DELETE to the upstream `/mcp` URL.

## Quick start (Docker)

```bash
cd mcp-gateway

# One-time setup
cp .env.example .env
openssl rand -base64 32   # paste into TOKEN_ENCRYPTION_KEY in .env

# Optional: set real JFrog credentials in .env
# ARTIFACTORY_BASE_URL=https://your-instance.jfrog.io/artifactory
# ARTIFACTORY_ACCESS_TOKEN=your-access-or-identity-token

docker compose up -d --build
npm run test:e2e
```

Endpoints:

| Service | URL |
|---------|-----|
| Gateway health | http://localhost:8090/health |
| Gateway homepage | http://localhost:8090/ |
| Artifactory MCP (direct) | http://localhost:8091/mcp |
| Artifactory via gateway | http://localhost:8090/artifactory/mcp |

## Quick start (host gateway + Docker backends)

```bash
docker compose up -d redis artifactory-mcp
cp .env.example .env   # set TOKEN_ENCRYPTION_KEY
npm install
npm run dev            # gateway on :8090, uses configs/local-host.yml
npm run test:e2e
```

## Add another MCP server

Edit `configs/local-mcp-config.yml` (Docker) or `configs/local-host-mcp-config.yml` (host):

```yaml
my-server:
  name: my-server
  description: My MCP backend
  endpoint: http://my-mcp:8080/mcp
  # auth_provider: google   # omit for open local servers
```

Restart the gateway. Clients connect to `http://localhost:8090/my-server/mcp`.

For OAuth-protected upstreams, add a provider in `configs/local-oauth-config.yml` and set `auth_provider` on the server entry.

## Configuration

| File | Purpose |
|------|---------|
| `configs/local.yml` | Gateway config when running inside Docker Compose |
| `configs/local-host.yml` | Gateway config when running on the host |
| `configs/local-mcp-config.yml` | Backend MCP servers (Docker network hostnames) |
| `configs/local-host-mcp-config.yml` | Backend MCP servers (localhost ports) |
| `configs/local-oauth-config.yml` | OAuth providers (empty `{}` for auth-free local testing) |
| `config.example.yml` | Full reference for all options |

Environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `TOKEN_ENCRYPTION_KEY` | Yes | Base64 key, 32+ bytes (`openssl rand -base64 32`) |
| `ARTIFACTORY_BASE_URL` | For live JFrog calls | JFrog Artifactory base URL |
| `ARTIFACTORY_ACCESS_TOKEN` | For live JFrog calls | JFrog access/identity token, sent as `Authorization: Bearer` (works with company + free-tier) |
| `ARTIFACTORY_API_KEY` | Optional | Legacy API key fallback (`X-JFrog-Art-Api`); deprecated by JFrog |

> **JFrog auth note:** API keys are End-of-Life — new JFrog instances can no
> longer create them. Generate an **access token** (admin: *Administration →
> User Management → Access Tokens*) or an **identity token** (*Profile →
> Generate an Identity Token*) and put it in `ARTIFACTORY_ACCESS_TOKEN`.

## Test with curl

```bash
# Health
curl -s http://localhost:8090/health

# Initialize via gateway
curl -s -X POST http://localhost:8090/artifactory/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# List tools
curl -s -X POST http://localhost:8090/artifactory/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Development

```bash
npm run dev          # hot reload, host config
npm run build        # compile to dist/
npm run test         # lint + typecheck + unit tests
npm run test:e2e     # end-to-end via running gateway
npm run compose:up   # full Docker stack
npm run compose:down
```

Requires Node.js 24 and Redis.

## Cursor / MCP client config

For auth-free local servers:

```json
{
  "mcpServers": {
    "artifactory": {
      "url": "http://localhost:8090/artifactory/mcp"
    }
  }
}
```

OAuth-backed servers require completing the gateway OAuth flow first; see `config.example.yml` for provider setup.
