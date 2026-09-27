<div align="center">

# MCP Server Gateway

**A production-grade MCP Gateway, OAuth-secured MCP servers, and a governed LangGraph agent — ready to fork and run.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/harish-gaggar/mcp-server-gateway?style=flat-square)](https://github.com/harish-gaggar/mcp-server-gateway/stargazers)
[![Forks](https://img.shields.io/github/forks/harish-gaggar/mcp-server-gateway?style=flat-square)](https://github.com/harish-gaggar/mcp-server-gateway/network/members)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](mcp-gateway)
[![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](Agents/jfrog-agent)

[Quick Start](#quick-start) &bull; [Design Principles](#design-framework-not-just-an-agent) &bull; [Repository Layout](#repository-layout) &bull; [Documentation](#documentation)

</div>

---

## Overview

This repository is a **reference stack for enterprise teams** building an MCP gateway and MCP servers from scratch, often inside an **air-gapped or restricted network** where public SaaS patterns don't apply out of the box. It ships working gateway, server, and agent code that runs locally with Docker, so you can **fork and extend** it for your own internal tools, identity systems, audit rules, and deployment standards.

It is not a hosted product — it's a **starting blueprint**: an OAuth-ready gateway, example MCP backends (Artifactory, GitHub, Google Drive), a governed LangGraph agent, PII controls, and the operational pieces (memory, measurement, context control) that production agents usually bolt on later.

<div align="center">
<img width="921" height="369" alt="MCP Server Gateway architecture diagram" src="https://github.com/user-attachments/assets/e2c51646-d205-4d7f-a0ba-7787167175f3" />
</div>

## Design framework, not just an agent

An agent alone isn't a solution — it needs guardrails around it. Every request that flows through this stack passes through eight design principles, all implemented in [`Agents/jfrog-agent/`](Agents/jfrog-agent/):

| # | Principle | What it does |
|---|-----------|---------------|
| 01 | **Agent framework** | Task-specific nodes with skills, prompts, and an internal plugin marketplace |
| 02 | **OAuth before every call** | Each MCP tool call runs authenticated, per user |
| 03 | **Customized MCP** | MCP tools tailored to your internal security practices |
| 04 | **Continuous audit** | Every operation is logged at the MCP gateway |
| 05 | **PII / secrets stripped** | Sensitive data is scrubbed before it ever reaches the LLM ([`agent-safety-kit/`](agent-safety-kit/)) |
| 06 | **Tracking & eval** | Per-query tracking of model, tools, tokens, latency, and response quality |
| 07 | **Memory management** | Conversation threads and LangGraph checkpoints persist across restarts (SQLite by default, Spanner-ready) |
| 08 | **Context optimizer** | Trims and summarizes long MCP transcripts to cut unnecessary token spend while keeping protocol-critical fields |

See [`Agents/jfrog-agent/README.md`](Agents/jfrog-agent/README.md) for memory backends and environment variables, and [`context_optimizer`](Agents/jfrog-agent/jfrog_agent/context_optimizer/) for trimming presets.

## Quick start

Goal: clone the repo, start Docker, and prove **MCP Gateway → MCP server** routing works (Artifactory in open mode; GitHub optional with OAuth).

### Prerequisites

| Requirement | Notes |
|-------------|--------|
| [Docker Desktop](https://docs.docker.com/get-docker/) or Engine + Compose v2 | Docker must be **running** before any `docker compose` command |
| Node.js 20+ | Only for the smoke-test scripts (`node scripts/…`); not required to build images |
| Python 3.10+ | Optional: OAuth demo and Agent Safety Kit |
| Free ports | `8090` gateway, `8091` Artifactory MCP (direct), `6379` Redis |

### 1. Clone and start the stack

**Important:** create `mcp-gateway/.env` and set `TOKEN_ENCRYPTION_KEY` **before** `docker compose`. The setup script does that from `.env.example`.

```bash
git clone https://github.com/harish-gaggar/mcp-server-gateway.git
cd mcp-server-gateway/mcp-gateway

chmod +x scripts/setup-local-env.sh scripts/smoke-test.sh
./scripts/setup-local-env.sh
docker compose up -d --build
```

Wait until every service is healthy (first build can take several minutes):

```bash
docker compose ps
```

You should see **five** containers (`mcp-gateway`, `mcp-gateway-redis`, `artifactory-mcp-server`, `github-mcp-server`, `gdrive-mcp-server`) with status **Up (healthy)**.

Gateway health check:

```bash
curl -s http://localhost:8090/health
```

**Success:** JSON contains `"status":"ok"`.

### 2. Test gateway → MCP server (no OAuth secrets needed)

This checks the gateway proxy to **Artifactory MCP** (initialize + `tools/list`) and direct health on all three MCP backends:

```bash
./scripts/smoke-test.sh
```

**Success:** the script ends with `smoke-test: passed` and prints a tool count for Artifactory (for example `7 tools`).

Manual equivalent (Artifactory only):

```bash
node scripts/e2e-test.mjs
```

### 3. Optional: GitHub MCP with OAuth (live GitHub API)

Default **open mode** does not expose the GitHub namespace on the gateway. To test **gateway OAuth → GitHub MCP → GitHub API**:

1. Create a [GitHub OAuth App](https://github.com/settings/developers) with callback URL **`http://localhost:8090/oauth2callback`**.
2. In `mcp-gateway/.env`, set:
   - `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`
   - `MCP_CONFIG_FILE=./configs/ci-mcp-config.yml`
   - `OAUTH_CONFIG_FILE=./configs/ci-oauth-config.yml`
3. Restart the gateway: `docker compose up -d gateway`
4. Run (browser login + consent once):

```bash
chmod +x scripts/test-github-mcp-oauth.sh
./scripts/test-github-mcp-oauth.sh
```

**Success:** `tools/list` shows GitHub tools and `list_repositories` returns JSON from your account. See also `python3 scripts/oauth-client-demo.py --namespace github --tool get_user_info --args '{"username":"YOUR_GITHUB_LOGIN"}'`.

### 4. Optional: reference agent UI

Start **after** step 1 (gateway on `:8090`):

```bash
cd ../Agents/jfrog-agent
cp .env.example .env
docker compose up --build
```

UI: **http://localhost:8501**. Default memory is SQLite. Spanner emulator: `docker compose --profile spanner up --build`.

### 5. Optional: Agent Safety Kit (no Docker)

```bash
cd ../../agent-safety-kit
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && pytest -v
```

### If something fails

| Symptom | Fix |
|---------|-----|
| `Cannot connect to the Docker daemon` | Start Docker Desktop (or Colima) and retry |
| `docker pull` / `x509: certificate signed by unknown authority` | Corporate TLS proxy: [mcp-gateway/certs/README.md](mcp-gateway/certs/README.md) |
| `invalid IP` / `host-gateway` on Colima | Re-run `./scripts/setup-local-env.sh` (sets `HOST_DOCKER_INTERNAL`) |
| Gateway exits on startup | Empty `TOKEN_ENCRYPTION_KEY` — run `./scripts/setup-local-env.sh` **before** `docker compose` |
| Gateway exits with Google OIDC errors | Use `ci-oauth-config.yml` for GitHub-only tests, or set `GATEWAY_NODE_EXTRA_CA_CERTS` per setup script on proxied networks |
| `smoke-test` cannot reach `:8090` | `docker compose ps` — wait for `mcp-gateway` healthy |
| Cursor / HTTPS / monitoring | [doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md) |

## Secure mode and full setup

Per-user OAuth (Google, GitHub, Drive), Cursor, and monitoring: **[doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md)** and `mcp-gateway/.env.example` (`OAUTH_CONFIG_FILE`, `MCP_CONFIG_FILE`, provider client IDs).

## Repository layout

```
mcp-server-gateway/
├── mcp-gateway/                  # Gateway, Compose, Cursor wrappers
├── artifactory/ github/ gdrive/  # Example MCP servers
├── agent-safety-kit/             # PII and secrets guard (portable)
├── Agents/jfrog-agent/           # Memory, tracking/eval, context optimizer
└── doc/howto/QUICKSTART.md
```

## Verify the stack (contributors and CI)

From a clean clone, the path above (`setup-local-env.sh` → `docker compose up` → `smoke-test.sh`) is the minimum bar.

Full local CI (unit tests + stack + GitHub routing when OAuth creds are set):

```bash
chmod +x mcp-gateway/scripts/verify-stack.sh
mcp-gateway/scripts/verify-stack.sh
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Doc | Topic |
|-----|-------|
| [Contributing](CONTRIBUTING.md) | Full verify script, corporate pip index |
| [Quickstart](doc/howto/QUICKSTART.md) | OAuth, Cursor, monitoring |
| [JFrog agent](Agents/jfrog-agent/README.md) | Memory backends, tracking, env vars |
| [Context optimizer](Agents/jfrog-agent/jfrog_agent/context_optimizer/README.md) | Trimming layers and presets |
| [Agent Safety Kit](agent-safety-kit/README.md) | Input guard and PII scanner |
| [Gateway dev](mcp-gateway/README.md) | Local dev and tests |

## Status and license

Reference implementation; APIs may change. Do not commit `.env` or OAuth secrets.

Licensed under [Apache-2.0](LICENSE). Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

<div align="center">

If this project helps you, consider giving it a ⭐ — it helps others find it too.

</div>
