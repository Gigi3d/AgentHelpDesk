#!/usr/bin/env bash
# demo/live.sh: one entry point for the live run.
#   demo/live.sh check    look for keys and probe them
#   demo/live.sh server   start the desk backend with every tool that has a key switched to real
#   demo/live.sh mcp      start the MCP edge with a public tunnel URL for Claude's custom connector
#   demo/live.sh run      drive one Ledgerly case through the running desk
#   demo/live.sh deploy   host the desk in a Blaxel sandbox with a public preview URL (needs token gate)
#   demo/live.sh remote   run the case against the hosted desk (reads demo/.deploy.json)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ -f demo/.env.live ]; then set -a; . demo/.env.live; set +a; fi

# Blaxel's SDK reads BL_*; the desk client checks BLAXEL_*. Make both visible.
export BL_API_KEY="${BL_API_KEY:-${BLAXEL_API_KEY:-}}"; export BLAXEL_API_KEY="${BL_API_KEY}"
export BL_WORKSPACE="${BL_WORKSPACE:-${BLAXEL_WORKSPACE:-}}"

# The live recipe from demo/RUNBOOK.md.
export AHD_SANDBOX_IMAGE="${AHD_SANDBOX_IMAGE:-blaxel/base-image:latest}"
export AHD_RESOLVER=claude
export AHD_PROVISION_DIR="$ROOT/demo/sandbox-root"
export AHD_FRESH_BASELINE=1
export AHD_REPRO_COMMAND='node /ahd/replay.mjs'
export AHD_REPRO_EXPECT=nonzero
CONTACT="${AHD_APPROVALS_FALLBACK_EMAIL:-you@example.com}"
export AHD_APPROVALS_FALLBACK_EMAIL="$CONTACT"
export AHD_VENDOR_JSON="{\"id\":\"ledgerly\",\"name\":\"Ledgerly\",\"risk_policy\":\"approve_first\",\"report_contacts\":[\"$CONTACT\"],\"test_command\":\"cd /ahd/work && node --test test/*.test.mjs\",\"stripe_customer_id\":\"${STRIPE_TEST_CUSTOMER_ID:-}\",\"payer_mode\":\"vendor\"}"
export AHD_DESK_URL="http://127.0.0.1:${PORT:-8787}"

case "${1:-check}" in
  check)  exec node demo/check-keys.mjs ;;
  server)
    node demo/check-keys.mjs || { echo "refusing to start: fix the keys first (or run check to see)"; exit 1; }
    [ -d product/node_modules/@blaxel/core ] || (cd product && npm i --no-save @blaxel/core)
    exec node --experimental-strip-types product/server.ts ;;
  mcp)
    cd mcp && { [ -d node_modules ] || npm install --legacy-peer-deps; }
    exec npx mcp-use dev --tunnel ;;
  run)    exec node demo/run-live.mjs "${@:2}" ;;
  deploy)
    [ -d product/node_modules/@blaxel/core ] || (cd product && npm i --no-save @blaxel/core)
    exec node demo/deploy-blaxel.mjs ;;
  remote)
    [ -f demo/.deploy.json ] || { echo "no demo/.deploy.json: run demo/live.sh deploy first"; exit 1; }
    URL=$(node -p "require('./demo/.deploy.json').url"); export AHD_API_TOKEN=$(node -p "require('./demo/.deploy.json').token")
    exec node demo/run-live.mjs --base "$URL" "${@:2}" ;;
  *) echo "usage: demo/live.sh check|server|mcp|run|deploy|remote"; exit 2 ;;
esac
