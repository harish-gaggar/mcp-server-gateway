# MCP Server Gateway

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

## What this is

This repository is a **reference stack for enterprise teams** that need to **build an MCP gateway and MCP servers from scratch**, often starting in an **air-gapped or restricted network** where public SaaS patterns do not apply out of the box. You get working gateway, server, and agent code you can run locally with Docker, then **fork and extend** for internal tools, identity systems, audit rules, and deployment standards.

It is not a hosted product. It is a **starting blueprint**: OAuth-ready gateway, example MCP backends (Artifactory, GitHub, Google Drive), a governed LangGraph agent, PII controls, and the operational pieces (memory, measurement, context control) that production agents usually add later.

## What you can build from here

| Layer | Purpose |
|-------|---------|
| **MCP Gateway** | One HTTP entry (`:8090`), sessions, optional per-user OAuth and consent |
| **MCP servers** | Example backends you can replace or add to match internal APIs |
| **Reference agent** | LangGraph + Streamlit Command Center calling tools **through** the gateway |
| **Agent Safety Kit** | Block secrets and redact PII **before** LLM calls; optional offline scan on stored text |

```
Clients (Cursor, scripts, LangGraph agent)
              |
              v
        MCP Gateway :8090
              |
    +---------+---------+
    v         v         v
Artifactory GitHub    GDrive
  MCP       MCP        MCP
```

## Agent memory, tracking/eval, and context trimming

These three are implemented in [`Agents/jfrog-agent/`](Agents/jfrog-agent/) and are the main reason the reference agent exists alongside the gateway.

**Agent memory** keeps **conversation threads and LangGraph checkpoints** across restarts so multi-step tool workflows do not lose state. Default storage is SQLite on a Docker volume; you can switch to Spanner (including a local emulator) for teams prototyping enterprise-grade persistence.

**Tracking and eval** records **each agent run**: tools invoked, LLM calls, latency, token usage, and cost estimates. Data lands in SQLite locally for the Insights UI; BigQuery is optional when you want warehouse-style eval at scale. Use it to debug failures, compare runs, and separate **agent traffic from IDE (Cursor) traffic** in gateway metrics.

**Context trimming** applies **token budgets before planner and summarizer calls** so long MCP transcripts do not blow the context window. The [`context_optimizer`](Agents/jfrog-agent/jfrog_agent/context_optimizer/) module supports layered selection, compression, and presets aimed at **keeping protocol-critical fields** (IDs, permissions, constraints) while trimming narrative fluff. Enable via agent env (see [`Agents/jfrog-agent/README.md`](Agents/jfrog-agent/README.md)).

**PII guard:** the agent image includes [`agent-safety-kit/`](agent-safety-kit/) for pre-LLM input guardrails; the same kit runs standalone in any agent framework.

## Quick start

**Prerequisites:** Docker Compose, Python 3.10+ for scripts.

**1. Gateway and MCP servers** (open mode; no OAuth required to boot):

```bash
git clone https://github.com/harish-gaggar/mcp-server-gateway.git
cd mcp-server-gateway/mcp-gateway
cp .env.example .env
openssl rand -base64 32   # set TOKEN_ENCRYPTION_KEY in .env
docker compose up -d --build
curl -s http://localhost:8090/health
```

**2. Reference agent** (offline planner works without an LLM API key):

```bash
cd ../Agents/jfrog-agent
cp .env.example .env
docker compose up --build
```

UI: **http://localhost:8501** (Command, Insights, Security/Governance views).

**3. Agent Safety Kit only** (no Docker):

```bash
cd ../../agent-safety-kit
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && pytest -v
```

## Secure mode and full setup

For per-user OAuth (Google/GitHub), Cursor, monitoring, and troubleshooting, use **[doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md)**. Uncomment `OAUTH_CONFIG_FILE`, `MCP_CONFIG_FILE`, and provider client IDs in `mcp-gateway/.env.example`.

## Repository layout

```
mcp-server-gateway/
├── mcp-gateway/           # Gateway, Compose, Cursor wrappers
├── artifactory/ github/ gdrive/   # Example MCP servers
├── agent-safety-kit/      # PII and secrets guard (portable)
├── Agents/jfrog-agent/    # Memory, tracking/eval, context optimizer
└── doc/howto/QUICKSTART.md
```

## Documentation

| Doc | Topic |
|-----|--------|
| [Quickstart](doc/howto/QUICKSTART.md) | OAuth, Cursor, monitoring |
| [JFrog agent](Agents/jfrog-agent/README.md) | Memory backends, tracking, env vars |
| [Context optimizer](Agents/jfrog-agent/jfrog_agent/context_optimizer/README.md) | Trimming layers and presets |
| [Agent Safety Kit](agent-safety-kit/README.md) | Input guard and PII scanner |
| [Gateway dev](mcp-gateway/README.md) | Local dev and tests |

## Status and license

Reference implementation; APIs may change. Do not commit `.env` or OAuth secrets.

[Apache-2.0](LICENSE)
