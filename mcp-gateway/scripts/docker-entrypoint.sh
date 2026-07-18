#!/bin/sh
set -e

if [ $# -eq 0 ]; then
  set -- node --import ./dist/instrumentation.js ./dist/main.js -c "${MCP_GATEWAY_CONFIG_FILE:-./configs/local.yml}"
fi

exec "$@"
