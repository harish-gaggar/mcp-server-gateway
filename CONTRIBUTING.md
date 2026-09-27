# Contributing

Thanks for helping improve MCP Server Gateway.

## Getting started

1. Fork and clone the repo.
2. Run the [README Quick start](README.md#quick-start): `setup-local-env.sh` → `docker compose up -d --build` → `mcp-gateway/scripts/smoke-test.sh`.
3. Follow [doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md) for OAuth and Cursor.

## Verify your change (recommended)

From the repo root, with **Docker running** (and Docker Hub reachable, or images already cached):

```bash
chmod +x mcp-gateway/scripts/verify-stack.sh
mcp-gateway/scripts/verify-stack.sh
```

The script creates a local `.verify-venv/` for Python tests (PEP 668 safe). Gateway unit tests need **Node 20+** (Node 24 matches CI).

This runs Agent Safety Kit tests, Artifactory MCP tests, gateway unit tests, builds the Docker stack, and **end-to-end MCP checks** including **GitHub MCP** health and gateway routing (401 without OAuth).

### Corporate pip index (Credit Karma / internal PyPI)

If `pip install` hits an internal Artifactory mirror and fails, force public PyPI for this repo:

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

| Component | Command |
|-----------|---------|
| Agent Safety Kit | `cd agent-safety-kit && pip install -e ".[dev]" && pytest -v` |
| Artifactory MCP | `cd artifactory && pip install -r requirements-dev.txt && pytest -q` |
| Gateway unit | `cd mcp-gateway && npm ci && npm run test:unit:ci` |
| MCP e2e (stack up) | `cd mcp-gateway && node scripts/e2e-stack.mjs` |

For GitHub e2e, `./scripts/verify-stack.sh` sets `MCP_CONFIG_FILE=./configs/ci-mcp-config.yml` and `OAUTH_CONFIG_FILE=./configs/ci-oauth-config.yml` (GitHub-only OAuth — avoids Google OIDC discovery at boot). For README open mode, leave the defaults (`local-*` configs).

## Pull requests

- Keep changes focused; one concern per PR when possible.
- Do not commit `.env`, tokens, or personal OAuth client secrets.
- Update README or `doc/howto/` if behavior or setup steps change.
- CI runs `verify-stack.sh` on every push to `main`.

## Issues

Bug reports and feature ideas are welcome. Include Docker/OS versions and redacted logs when reporting gateway or OAuth issues.
