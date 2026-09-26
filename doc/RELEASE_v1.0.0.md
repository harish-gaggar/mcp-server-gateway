# Release v1.0.0 — MCP Server Gateway

First public release of the reference **MCP gateway + MCP servers + governed agent** stack.

## Highlights

- **MCP Gateway** — per-user OAuth, consent, Redis-backed sessions, multi-namespace proxy
- **MCP servers** — Artifactory, GitHub, Google Drive
- **LangGraph agent** — Command Center UI, durable memory (SQLite / Spanner emulator), MCP-through-gateway
- **Tracking & eval** — run telemetry, cost estimates, BigQuery optional backend
- **Agent Safety Kit** — secrets block + PII redaction before LLM; offline PII scan on stored text
- **Context trimming** — token budgeting and protocol-aware compression in the reference agent
- **Observability** — OpenTelemetry + Grafana dashboard (client type: Cursor vs agent)

## Quick start

```bash
git clone https://github.com/harish-gaggar/mcp-server-gateway.git
cd mcp-server-gateway/mcp-gateway
cp .env.example .env
docker compose up -d --build
```

See [doc/howto/QUICKSTART.md](howto/QUICKSTART.md) for OAuth and Cursor.

## Notes

Reference implementation; not a supported commercial product. Pre-release APIs may change in patch releases.
