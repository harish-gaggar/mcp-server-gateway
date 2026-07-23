# Google Drive + Docs MCP Server

A Model Context Protocol (MCP) server for Google Drive and Google Docs, built
with Python and FastMCP. It can list/search/read/create Drive files and
read/write Google Docs.

## 🚀 Quick Start

### Prerequisites
- Docker and Docker Compose
- A Google credential with Drive + Docs scopes (see [Authentication](#-authentication))

### Running with Docker

1. **Provide a credential** (see below), e.g. copy `.env.example` to `.env` and
   set `GOOGLE_ACCESS_TOKEN`.

2. **Start the server:**
   ```bash
   docker compose up -d --build
   ```

3. **Test with MCP Inspector:**
   - Run: `npx @modelcontextprotocol/inspector`
   - Connect with Transport **Streamable HTTP**, URL **http://localhost:8092/mcp**

4. **Logs / stop:**
   ```bash
   docker logs gdrive-mcp-server
   docker compose down
   ```

### Running locally (without Docker)
```bash
pip install -r requirements.txt
export GOOGLE_ACCESS_TOKEN="ya29...."   # or GOOGLE_SERVICE_ACCOUNT_FILE=...
export HOST="0.0.0.0" PORT="8092"
python server.py
```

## 🔐 Authentication

The server supports three credential modes (pick one):

| Mode | Trigger | Credential used |
|------|---------|-----------------|
| **Secure (per-user)** | `GDRIVE_SECURE_MODE=true` | The user's Google OAuth **access token**, forwarded by the MCP gateway. Every call runs as that user. |
| **Open — access token** | `GOOGLE_ACCESS_TOKEN` set | A shared OAuth access token (expires ~1h). Good for quick local testing. |
| **Open — service account** | `GOOGLE_SERVICE_ACCOUNT_FILE` set | Server mints tokens from a service-account key for `GOOGLE_SCOPES`. Optionally impersonate a user via `GOOGLE_IMPERSONATE_SUBJECT`. |

Required OAuth scopes:
- `https://www.googleapis.com/auth/drive`
- `https://www.googleapis.com/auth/documents`

> To write to a doc **you** own, use **Secure mode** through the gateway (so the
> token belongs to your account) or a `GOOGLE_ACCESS_TOKEN` minted for your
> account. A bare service account can only touch files explicitly shared with
> it (or files it created), unless you configure domain-wide delegation.

## 🛠️ Available Tools

**Drive**
- **`list_files`** — List/search files (Drive `q` query syntax)
- **`get_file_metadata`** — Get metadata for a file
- **`export_file`** — Export a Google Doc/Sheet/Slide to text/markdown/html/csv
- **`create_file`** — Create a plain file with text content

**Docs**
- **`get_document`** — Read a Google Doc's full structure/content
- **`create_document`** — Create a new Google Doc (optionally with initial text)
- **`append_text`** — Append text to the end of a doc
- **`insert_text`** — Insert text at a specific index
- **`replace_text`** — Replace all occurrences of a string

## 📝 Configuration

| Variable | Purpose |
|----------|---------|
| `GDRIVE_SECURE_MODE` | `true` to use the gateway-forwarded per-user token |
| `GOOGLE_ACCESS_TOKEN` | Shared OAuth access token (open mode) |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Path to a service-account JSON key (open mode) |
| `GOOGLE_IMPERSONATE_SUBJECT` | Workspace user to impersonate (service account) |
| `GOOGLE_SCOPES` | Space-separated scopes for the service account |
| `HOST` / `PORT` | Bind address (default `0.0.0.0:8092`) |
| `MCP_DISABLE_DNS_REBINDING` | Disable DNS-rebinding protection (needed in Docker) |

## 🌐 Using through the MCP gateway

The gateway exposes this server behind per-user Google OAuth at
`http://localhost:8090/gdrive/mcp`. See `../mcp-gateway/README.md`. In short:

```bash
cd ../mcp-gateway
OAUTH_CONFIG_FILE=./configs/secure-oauth-config.yml \
MCP_CONFIG_FILE=./configs/secure-mcp-config.yml \
docker compose up -d --build
```

Then point Cursor at `scripts/gdrive-mcp-remote.sh`.

## 📚 Resources
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Google Drive API](https://developers.google.com/drive/api/reference/rest/v3)
- [Google Docs API](https://developers.google.com/docs/api/reference/rest)
