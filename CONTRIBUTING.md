# Contributing

Thanks for helping improve MCP Server Gateway.

## Getting started

1. Fork and clone the repo.
2. Follow [doc/howto/QUICKSTART.md](doc/howto/QUICKSTART.md) for the gateway stack.
3. Gateway unit tests: `cd mcp-gateway && npm install && npm test`
4. Artifactory MCP tests: `cd artifactory && pip install -r requirements-dev.txt && pytest`
5. Agent Safety Kit: `cd agent-safety-kit && pip install -r requirements-dev.txt && pytest`

## Pull requests

- Keep changes focused; one concern per PR when possible.
- Do not commit `.env`, tokens, or personal OAuth client secrets.
- Update README or `doc/howto/` if behavior or setup steps change.

## Issues

Bug reports and feature ideas are welcome. Include Docker/OS versions and redacted logs when reporting gateway or OAuth issues.
