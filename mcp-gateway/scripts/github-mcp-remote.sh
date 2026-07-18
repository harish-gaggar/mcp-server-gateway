#!/bin/bash
# Cursor wrapper: mcp-remote -> local MCP gateway /github namespace (OAuth-protected).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${SCRIPT_DIR}/../tools/mcp-remote-runner"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
TARGET_URL="${MCP_GATEWAY_URL:-http://localhost:8090/github/mcp}"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "node not found; set NODE_BIN to your node binary" >&2
  exit 1
fi

cd "$RUNNER_DIR"

exec "$NODE_BIN" "$RUNNER_DIR/node_modules/mcp-remote/dist/proxy.js" "$TARGET_URL" --allow-http
