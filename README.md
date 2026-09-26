# MCP Server Gateway

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**Clone → Docker → working MCP stack.** One repo for a **Model Context Protocol gateway**, **MCP servers** (Artifactory, GitHub, Google Drive), a **LangGraph agent** with **memory**, **LLM tracking & eval**, **PII blocking**, and **context trimming**—the pieces teams usually wire up separately.

Use it to learn governed MCP, fork it as a starter, or run the reference agent locally without shared API tokens in git.

---

## Why developers use this

| You get | What it solves |
|--------|----------------|
| **MCP Gateway** | Single HTTP entry (`:8090`), sessions, optional **per-user OAuth** |
| **MCP servers** | Artifactory, GitHub, GDrive—each behind the gateway |
| **LangGraph agent** | Streamlit **Command Center**; tools via gateway; **durable memory** |
| **Tracking & eval** | Run history, latency, cost estimates, quality views (SQLite local; BigQuery optional) |
| **Agent Safety Kit** | **PII redaction + secret block** before the LLM; offline PII scan on stored text |
| **Context trimming** | Token budgets and **protocol-aware** compression in the agent pipeline |

```
Developer / Cursor / LangGraph agent
              │
              ▼
     MCP Gateway  :8090
       OAuth · consent · proxy
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 Artifactory GitHub   GDrive
   MCP       MCP       MCP
```

---

## Prerequisites

| Tool | Check |
|------|--------|
| **Docker** + Compose | `docker compose version` |
| **Python 3.10+** | For demo scripts & Agent Safety Kit (`python3 --version`) |
| **Git** | Clone this repo |

Optional later: Google/GitHub OAuth apps (secure mode), OpenAI/Anthropic key (smarter agent planner—not required).

---

## Run in 10 minutes

### 1 — Gateway + MCP servers

Default compose starts the **gateway**, **Redis**, and **backend MCP servers** in **open mode** (no OAuth setup required to bring the stack up).

```bash
git clone https://github.com/harish-gaggar/mcp-server-gateway.git
cd mcp-server-gateway/mcp-gateway

cp .env.example .env
# Required: set TOKEN_ENCRYPTION_KEY in .env (paste output of next line)
openssl rand -base64 32

docker compose up -d --build
docker compose ps          # all services healthy
curl -s http://localhost:8090/health    # ok
```

Optional: point Artifactory at your instance in `.env` (`ARTIFACTORY_BASE_URL`, `ARTIFACTORY_ACCESS_TOKEN`). Without it, the Artifactory MCP process still runs for wiring tests.

**Endpoints**

| URL | Use |
|-----|-----|
| `http://localhost:8090/health` | Gateway |
| `http://localhost:8090/artifactory/mcp` | Artifactory via gateway |
| `http://localhost:8091/mcp` | Artifactory direct (dev) |

### 2 — LangGraph agent (memory, eval, context trim, PII guard)

With the gateway up on the host, start the **reference agent** (works **without** an LLM API key—offline planner included). **Agent Safety Kit** is baked into the image for pre-LLM guards.

```bash
cd ../Agents/jfrog-agent
cp .env.example .env
docker compose up --build
```

Open **http://localhost:8501** — Command Center UI.

| Area in UI | Feature |
|------------|---------|
| **Operations / Command** | LangGraph runs, MCP tools through gateway |
| **Insights** | **Tracking & eval** (runs, tokens, latency) |
| **Security / Governance** | Policy, approvals, redaction hooks |
| Agent pipeline | **Context trimming** via `jfrog_agent/context_optimizer/` |

Optional in `.env`: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, `JFROG_AGENT_LLM_PROVIDER=openai`.

First-time **Artifactory via gateway**: complete the browser OAuth flow when the UI prompts you (see [secure mode](#secure-mode-per-user-oauth--cursor) below if you enabled it).

### 3 — PII blocker framework (standalone, ~2 minutes)

No Docker required—use **Agent Safety Kit** in any agent (LangGraph, OpenAI loop, etc.).

```bash
cd ../../agent-safety-kit
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest -v
python examples/01_guard_text.py
python examples/04_drop_into_any_agent.py
```

Details: [agent-safety-kit/README.md](agent-safety-kit/README.md).

---

## Secure mode (per-user OAuth + Cursor)

For **production-shaped** auth—every user signs in with **Google / GitHub**, gateway consent, no shared tokens in the repo:

1. In `mcp-gateway/.env`, uncomment and set:

   ```bash
   OAUTH_CONFIG_FILE=./configs/secure-oauth-config.yml
   MCP_CONFIG_FILE=./configs/secure-mcp-config.yml
   GATEWAY_BASE_URL=http://localhost:8090
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GITHUB_OAUTH_CLIENT_ID=...
   GITHUB_OAUTH_CLIENT_SECRET=...
   ```

2. Follow **[doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md)** — create OAuth apps, wire **Cursor**, troubleshooting.

Smoke test without an IDE:

```bash
cd mcp-gateway
python3 scripts/oauth-client-demo.py --namespace github --tool list_repositories
```

---

## Repository layout

```
mcp-server-gateway/
├── mcp-gateway/              # Gateway + docker compose + Cursor wrappers
├── artifactory/  github/  gdrive/   # MCP server implementations
├── agent-safety-kit/         # PII blocker + secrets guard (framework-agnostic)
├── Agents/jfrog-agent/       # LangGraph agent, memory, tracking, context trim
└── doc/howto/QUICKSTART.md   # Full OAuth + IDE setup
```

---

## Documentation

| Doc | Contents |
|-----|----------|
| [Quickstart (OAuth, Cursor, monitoring)](doc/howto/QUICKSTART.md) | Step-by-step secure stack |
| [Gateway dev](mcp-gateway/README.md) | Config files, `npm run dev`, tests |
| [JFrog agent](Agents/jfrog-agent/README.md) | Memory backends, telemetry, env reference |
| [Context optimizer](Agents/jfrog-agent/jfrog_agent/context_optimizer/README.md) | Trimming layers & presets |
| [Contributing](CONTRIBUTING.md) | PRs and local tests |

---

## Project status

Active reference implementation—APIs may evolve. **Issues, stars, and forks** help; contributions welcome.

## Security

Never commit `.env` or OAuth secrets. Prefer **secure mode** for shared environments. Run **input guard** on all user/tool text before LLM calls.

## License

[Apache-2.0](LICENSE)
