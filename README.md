# MCP Server Gateway

A local, book-ready reference stack for running **MCP Gateway** with two OAuth-protected backends:

| Backend | Namespace | OAuth provider | What it does |
|---------|-----------|----------------|--------------|
| [Artifactory MCP](artifcatory/) | `/artifactory/mcp` | Google | JFrog Artifactory tools (repos, artifacts, search) |
| [GitHub MCP](github/) | `/github/mcp` | GitHub | GitHub API tools (repos, issues, PRs, search) |

There is also an optional **[JFrog AI Agent (Command Center)](Agents/jfrog-agent/)** — a
LangGraph + Streamlit app that talks to the Artifactory MCP server *through* this
gateway (per-user OAuth), with durable memory and LLM usage/evaluation tracking.
Set the gateway up first, then see [Agents/jfrog-agent/README.md](Agents/jfrog-agent/README.md).

The gateway sits in front of both servers. Every tool call requires the user to **sign in via OAuth** and approve a **gateway consent screen**. No shared tokens are checked into the repo.

```
Cursor / oauth-client-demo
        |
        |  http://localhost:8090/{namespace}/mcp
        v
   MCP Gateway (:8090)
        |-- Google OAuth  (artifactory)
        |-- GitHub OAuth  (github)
        |
        +-- artifactory-mcp (:8091, internal)
        +-- github-mcp    (:8080, internal)
```

---

## Prerequisites

Install these before you start:

| Tool | Version | Check |
|------|---------|-------|
| **Docker Desktop** (or Docker Engine + Compose) | recent | `docker compose version` |
| **Node.js** | 20+ (24 recommended for gateway dev) | `node --version` |
| **Python** | 3.10+ | `python3 --version` |
| **OpenSSL** | any | `openssl version` |

Optional but recommended for IDE testing:

- **Cursor** (or any MCP client that supports OAuth)
- A **Google account** (for Artifactory OAuth)
- A **GitHub account** (for GitHub OAuth)
- A **JFrog Cloud free-tier instance** ([jfrog.com/start](https://jfrog.com/start)) if you want live Artifactory data

---

## Step 1 — Clone and open the repo

```bash
git clone https://github.com/YOUR_ORG/mcp-server-gateway.git
cd mcp-server-gateway
```

Repo layout:

```
mcp-server-gateway/
├── mcp-gateway/          # Gateway + docker compose + Cursor wrappers
├── artifcatory/          # Python Artifactory MCP server
├── github/               # TypeScript GitHub MCP server
├── gdrive/               # Python Google Drive + Docs MCP server (standalone)
├── Agents/
│   └── jfrog-agent/      # Optional LangGraph + Streamlit JFrog AI agent
└── README.md             # ← you are here
```

---

## Step 2 — Create `.env` and encryption key

```bash
cd mcp-gateway
cp .env.example .env
```

Generate a token-encryption key and paste it into `.env`:

```bash
openssl rand -base64 32
# → paste the output as TOKEN_ENCRYPTION_KEY=...
```

Enable **secure (per-user OAuth) mode** by uncommenting these lines in `.env`:

```bash
OAUTH_CONFIG_FILE=./configs/secure-oauth-config.yml
MCP_CONFIG_FILE=./configs/secure-mcp-config.yml
GATEWAY_BASE_URL=http://localhost:8090
```

Leave `ARTIFACTORY_ACCESS_TOKEN` **empty** — in secure mode the gateway forwards each user's OAuth token instead of a shared JFrog token.

Set your JFrog base URL (free-tier example):

```bash
ARTIFACTORY_BASE_URL=https://YOUR_INSTANCE.jfrog.io/artifactory
```

---

## Step 3 — Google OAuth (Artifactory namespace)

The Artifactory backend uses **Google** as its OAuth provider.

### 3a. Create a Google Cloud OAuth client

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create a project (or pick an existing one).
3. **APIs & Services → OAuth consent screen**
   - User type: **External** (or Internal if you have Google Workspace).
   - Fill in app name, support email, developer contact.
   - Scopes: default is fine (`openid`, `email` are added by the gateway).
   - Add your email as a **test user** while the app is in "Testing" mode.
4. **Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `MCP Gateway (local)`
   - **Authorized redirect URIs** — add exactly:
     ```
     http://localhost:8090/oauth2callback
     ```
5. Copy the **Client ID** and **Client secret** into `.env`:

```bash
GOOGLE_OAUTH_CLIENT_ID=123456789-xxxx.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxx
```

> **Important:** The redirect URI must be `http` (not `https`) and port `8090` — that is where the gateway listens locally.

### 3b. (Optional) True per-user JFrog tokens

To exchange each user's Google `id_token` for a **user-scoped JFrog token** (instead of a shared token), you also need a JFrog OIDC integration:

1. In JFrog Platform → **Administration** → **General Management** → **Manage Integrations** → **OpenID Connect** tab, click **New Integration → OpenID Connect** and create a provider (set the Projects dropdown to **All Projects** first):
   - **Provider Name:** `google-mcp-gateway` (must match `ARTIFACTORY_OIDC_PROVIDER_NAME` in `.env`)
   - **Provider Type:** `generic`
   - **Provider URL:** `https://accounts.google.com`
   - **Audience:** your Google OAuth **client ID** (the same `GOOGLE_OAUTH_CLIENT_ID` from `.env`)
2. Add an **Identity Mapping** to that integration. Match on the `aud` claim (your client ID) so **any** user who authenticated through the gateway is trusted — no per-email hardcoding:
   - **Claims JSON:**
     ```json
     { "aud": "<YOUR_GOOGLE_CLIENT_ID>.apps.googleusercontent.com" }
     ```
   - **Token scope:** `Group` → `readers` (uniform read access for every authenticated user), leave the user field blank.
     Alternatively, use `User Dynamic Mapping` with pattern `{{email}}` for per-user identity (non-existent users become transient users and inherit any group marked *Automatically Join New Users*).
   - **Service:** All · **Expiry:** `60`
3. Uncomment in `.env`:
   ```bash
   ARTIFACTORY_OIDC_PROVIDER_NAME=google-mcp-gateway
   ```

> **Important:** If you ever recreate the Google OAuth client, the token's `aud` changes — update the **Audience** on the integration **and** the `aud` in the identity mapping's Claims JSON to the new client ID, or the exchange fails with `HTTP 403 Forbidden`.

Skip this subsection if you only want to validate the OAuth + gateway flow first.

---

## Step 4 — GitHub OAuth App (GitHub namespace)

The GitHub backend uses a **GitHub OAuth App** (not a GitHub App).

### 4a. Register the OAuth App

1. Open [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers).
2. **New OAuth App**
   - **Application name:** `mcp-gateway` (any name works)
   - **Homepage URL:** `http://localhost:8090`
   - **Authorization callback URL** — must be exactly:
     ```
     http://localhost:8090/oauth2callback
     ```
3. Click **Register application**.
4. Copy the **Client ID**.
5. Click **Generate a new client secret** and copy it immediately.

Add both to `.env`:

```bash
GITHUB_OAUTH_CLIENT_ID=Ov23lixxxxxxxx
GITHUB_OAUTH_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4b. Copy credentials carefully

GitHub client IDs are case-sensitive and easy to mistype:

- The third segment uses **`I`** (capital i) vs **`l`** (lowercase L) — copy with the **Copy** button, do not retype.
- The last character is usually **`0`** (zero), not **`O`** (letter O).

A wrong client ID causes a GitHub **404** on the authorize page after you sign in.

### 4c. (Optional) Restrict which GitHub users can connect

```bash
GITHUB_ALLOWED_USERS=your-github-login
```

Comma-separated list. Leave unset to allow any GitHub user who completes OAuth.

---

## Step 5 — Start the stack

From `mcp-gateway/`:

```bash
docker compose up -d --build
```

Wait until all services are healthy:

```bash
docker compose ps
```

Expected:

| Container | Port | Status |
|-----------|------|--------|
| `mcp-gateway` | 8090 | healthy |
| `artifactory-mcp-server` | 8091 | healthy |
| `github-mcp-server` | internal only | healthy |
| `mcp-gateway-redis` | 6379 | healthy |

Quick sanity check:

```bash
curl -s http://localhost:8090/health
# → ok
```

Unauthenticated MCP calls must return **401**:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost:8090/github/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# → 401
```

---

## Step 6 — Test OAuth with the reference client

The repo includes a zero-dependency Python client that runs the full MCP OAuth handshake (DCR → browser login → token → tool call).

### Artifactory (Google OAuth)

```bash
python3 scripts/oauth-client-demo.py --namespace artifactory --tool list_repositories
```

### GitHub (GitHub OAuth)

```bash
python3 scripts/oauth-client-demo.py --namespace github --tool list_repositories
```

What happens:

1. Terminal prints discovery + DCR output.
2. Browser opens → **gateway consent screen** → click **Authorize**.
3. Browser redirects to **Google** or **GitHub** → sign in → approve the app.
4. Browser shows *"Authorization complete. You can close this tab."*
5. Terminal prints the live tool result.

If the GitHub step shows a **404** after login, re-check the Client ID in `.env` against GitHub settings (Step 4b).

---

## Step 7 — Connect Cursor

Cursor cannot talk HTTP OAuth to `localhost` directly; use the included **`mcp-remote`** wrappers.

### 7a. Install mcp-remote (one time)

```bash
cd mcp-gateway/tools/mcp-remote-runner
npm install
cd ../..
```

### 7b. Add MCP servers to Cursor

Edit `~/.cursor/mcp.json` (use absolute paths on your machine):

```json
{
  "mcpServers": {
    "artifactory": {
      "command": "/ABSOLUTE/PATH/TO/mcp-server-gateway/mcp-gateway/scripts/artifactory-mcp-remote.sh"
    },
    "github": {
      "command": "/ABSOLUTE/PATH/TO/mcp-server-gateway/mcp-gateway/scripts/github-mcp-remote.sh"
    },
    "gdrive": {
      "command": "/ABSOLUTE/PATH/TO/mcp-server-gateway/mcp-gateway/scripts/gdrive-mcp-remote.sh"
    }
  }
}
```

> **Note:** Each wrapper pins a **fixed loopback callback port** (`42833` artifactory, `42834` github, `42835` gdrive). This keeps the `mcp-remote` OAuth token cache stable across restarts — otherwise a random port each launch invalidates the cached token and forces a fresh browser login every time. Override per server with `MCP_CALLBACK_PORT` if a port is already in use.

### 7c. Authenticate in Cursor

1. **Cursor → Settings → Tools → MCP**
2. Enable **artifactory** and/or **github**
3. Click **Authenticate** (or **Connect**) on each server
4. Complete gateway consent → Google/GitHub login → approve
5. You should see tools listed (e.g. *7 tools* for Artifactory, *13 tools* for GitHub)

In chat, try:

> List my GitHub repositories using the MCP server

---

## Step 8 — (Optional) Monitoring

An OpenTelemetry + Grafana stack lives under `mcp-gateway/monitoring/`. To enable traces:

1. Uncomment in `.env`:
   ```bash
   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   ```
2. Start the monitoring stack:
   ```bash
   cd mcp-gateway/monitoring
   docker compose up -d
   ```
3. Open Grafana at `http://localhost:3000`.

The *MCP Gateway* dashboard includes a **Client type** view that separates
autonomous agent traffic (e.g. the JFrog agent below) from interactive coding
assistants like Cursor.

---

## Step 9 — (Optional) JFrog AI Agent (Command Center)

Once the gateway is running (Step 7 works), you can run the LangGraph + Streamlit
**JFrog agent** that queries Artifactory through the gateway with per-user OAuth,
plus durable conversation memory and LLM usage/evaluation tracking.

```bash
cd Agents/jfrog-agent
cp .env.example .env          # then set OPENAI_API_KEY (or use the offline planner)
docker compose up --build     # UI at http://localhost:8501
```

Full instructions (local run, memory backends incl. the Spanner emulator, and the
`scripts/verify_memory.py` check) are in
[Agents/jfrog-agent/README.md](Agents/jfrog-agent/README.md).

---

## Endpoints reference

| URL | Purpose |
|-----|---------|
| `http://localhost:8090/health` | Gateway health |
| `http://localhost:8090/artifactory/mcp` | Artifactory MCP (OAuth required) |
| `http://localhost:8090/github/mcp` | GitHub MCP (OAuth required) |
| `http://localhost:8090/oauth2callback` | OAuth redirect (both providers) |
| `http://localhost:8091/mcp` | Artifactory MCP direct (bypasses gateway — dev only) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| GitHub **404** on authorize | Wrong `GITHUB_OAUTH_CLIENT_ID` in `.env` | Copy Client ID from GitHub settings again |
| `error fetching user info` in Cursor | Gateway container cannot reach `api.github.com` | Retry; check Docker network / VPN; restart gateway |
| Gateway **401** forever | Secure mode not enabled | Set `OAUTH_CONFIG_FILE` + `MCP_CONFIG_FILE` in `.env`, restart |
| Cursor **Error — Show Output** | `mcp-remote` not installed | Run `npm install` in `tools/mcp-remote-runner/` |
| Artifactory tools return empty/errors | JFrog URL wrong or OIDC not configured | Check `ARTIFACTORY_BASE_URL`; set up OIDC for per-user mode |
| `GITHUB_ALLOWED_USERS` rejection | Logged in as different GitHub user | Match login in `.env` or clear the allowlist |
| Browser login prompts **every** call / OAuth callback `ERR_CONNECTION_REFUSED` on a random `localhost:<port>` | `mcp-remote` used a random callback port, invalidating the cached token | Ensure the wrappers pin `CALLBACK_PORT` (already set); clear stale state with `rm -rf ~/.mcp-auth/mcp-remote-*` and reconnect once |
| `JFrog OIDC exchange failed: HTTP 403 Forbidden` | Identity mapping's `aud` (or email) claim doesn't match the live token — usually after recreating the Google client | Update the OIDC integration **Audience** and the identity mapping **Claims JSON** `aud` to the current `GOOGLE_OAUTH_CLIENT_ID` |
| `JFrog OIDC exchange failed: HTTP 400 invalid audience` | Integration **Audience** doesn't equal the Google client ID | Set the integration's Audience to `GOOGLE_OAUTH_CLIENT_ID` |

View gateway logs:

```bash
cd mcp-gateway
docker compose logs -f gateway
```

---

## Development

See [mcp-gateway/README.md](mcp-gateway/README.md) for gateway-specific dev commands (`npm run dev`, tests, config reference).

---

## Security notes

- **Never commit `.env`** — it is gitignored. Only `.env.example` belongs in the repo.
- OAuth client secrets live in `.env` locally and in Google/GitHub developer consoles.
- In secure mode, no shared `GITHUB_TOKEN` or `ARTIFACTORY_ACCESS_TOKEN` is required.
