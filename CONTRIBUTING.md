# Contributing

Thanks for helping improve MCP Server Gateway.

## Getting started

1. Fork and clone the repo.
2. Run the [README Quick start](README.md#quick-start): `setup-local-env.sh` → `docker compose up -d --build` → `smoke-test.sh`.
3. Follow [doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md) for OAuth and Cursor.

## Verify your change (recommended)

From the repo root, with **Docker running**:

```bash
chmod +x mcp-gateway/scripts/verify-stack.sh
mcp-gateway/scripts/verify-stack.sh
```

The script creates a local `.verify-venv/` for Python tests (PEP 668 safe). Gateway unit tests need **Node.js 20+** (Node 24 matches CI).

It runs Agent Safety Kit tests, Artifactory MCP tests, gateway unit tests, builds the Docker stack, and **end-to-end MCP checks** including **GitHub MCP** health and gateway routing (401 without OAuth).

### pip / PyPI (restricted networks)

If `pip install` fails because your environment uses a private package index, force public PyPI for this repo:

```bash
export PIP_INDEX_URL=https://pypi.org/simple
export PIP_EXTRA_INDEX_URL=
pip install -e "./agent-safety-kit[dev]"
```

Or prefix a single command:

```bash
PIP_INDEX_URL=https://pypi.org/simple pip install -r artifactory/requirements-dev.txt
```

## Individual test targets

| Area | Command |
|------|---------|
| Smoke test (gateway + MCP) | `mcp-gateway/scripts/smoke-test.sh` |
| Gateway unit tests | `cd mcp-gateway && npm run test:unit:ci` |
| Agent Safety Kit | `cd agent-safety-kit && pytest -v` |
| Artifactory MCP | `cd artifactory && pytest -q` |
| GitHub OAuth path | `mcp-gateway/scripts/test-github-mcp-oauth.sh` (requires OAuth app creds in `.env`) |

## Pull requests

- Keep changes focused; match existing style in each subproject.
- Do not commit `.env`, tokens, or credentials.
- Ensure `verify-stack.sh` passes locally when your change touches gateway, MCP servers, or CI configs.
