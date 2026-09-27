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

**Prerequisites:** Docker Compose, Python 3.10+ for scripts.

**1. Gateway and MCP servers** (open mode; no OAuth required to boot):

```bash
git clone https://github.com/harish-gaggar/mcp-server-gateway.git
cd mcp-server-gateway/mcp-gateway
cp .env.example .env
openssl rand -base64 32 # set TOKEN_ENCRYPTION_KEY in .env
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

For per-user OAuth (Google/GitHub), Cursor, monitoring, and troubleshooting, see **[doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md)**. Uncomment `OAUTH_CONFIG_FILE`, `MCP_CONFIG_FILE`, and provider client IDs in `mcp-gateway/.env.example`.

## Repository layout

```
mcp-server-gateway/
├── mcp-gateway/                  # Gateway, Compose, Cursor wrappers
├── artifactory/ github/ gdrive/  # Example MCP servers
├── agent-safety-kit/             # PII and secrets guard (portable)
├── Agents/jfrog-agent/           # Memory, tracking/eval, context optimizer
└── doc/howto/QUICKSTART.md
```

## Documentation

| Doc | Topic |
|-----|-------|
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
