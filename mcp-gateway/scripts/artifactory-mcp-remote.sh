#!/bin/bash
# Wrapper that lets Cursor launch mcp-remote reliably against the local gateway.
#
# Why this exists:
#   Cursor spawns MCP "command" servers with its own app-resources directory as
#   the working dir and npm_config_* env pointing inside Cursor.app. That breaks
#   `npx`/`npm` path resolution (ENOENT on .../Resources/app/resources/lib). We
#   avoid it by cd'ing to a stable dir and running a pre-installed mcp-remote via
#   node directly (no runtime npx fetch).
#
# Transport: plain HTTP to the local gateway. mcp-remote allows unencrypted
# connections to localhost with --allow-http. The OAuth flow (login + gateway
# consent) runs over http://localhost:8090.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${SCRIPT_DIR}/../tools/mcp-remote-runner"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
TARGET_URL="${MCP_GATEWAY_URL:-http://localhost:8090/artifactory/mcp}"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found; set NODE_BIN to your node binary" >&2
  exit 1
fi

cd "$RUNNER_DIR"

exec "$NODE_BIN" "$RUNNER_DIR/node_modules/mcp-remote/dist/proxy.js" "$TARGET_URL" --allow-http
