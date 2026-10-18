#!/usr/bin/env bash
# demo/live.sh: one entry point for the live run.
#   demo/live.sh check    look for keys and probe them
#   demo/live.sh server   start the desk backend with every tool that has a key switched to real
#   demo/live.sh mcp      start the MCP edge with a public tunnel URL for Claude's custom connector
#   demo/live.sh run      drive one Ledgerly case through the running desk
#   demo/live.sh deploy   host the desk in a Blaxel sandbox with a public preview URL (needs token gate)
#   demo/live.sh stripe   test mode only: create the ahd_verified_fix meter and a test customer
#   demo/live.sh inkbox   point the Inkbox identity's webhooks at the hosted desk (email and agent-to-agent intake)
#   demo/live.sh armature pull open issues from Armature into cases on the hosted desk
#   demo/live.sh scenarios [--only a,b] [--rounds 2]   run the simulated x402 failures with no human step; round 2 shows Fix Memory
#   demo/live.sh cli run -- <cmd>   run a command; if it fails like an agent error, file a case
#   demo/live.sh approve <case-id>   approve a case parked at the gate on the hosted desk
#   demo/live.sh persist <mode>   prove state and data survive restart, standby and sandbox deletion (restart|standby|wipe)
#   demo/live.sh cleanup [--yes]   list (or with --yes delete) the per-case ahd-* sandboxes; Tier 0 holds only 10
#   demo/live.sh secrets  store the keep-live secrets in GitHub (needs gh)
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
export AHD_SCENARIOS_DIR="$ROOT/demo/scenarios"
export AHD_FRESH_BASELINE=1
export AHD_REPRO_COMMAND='node /ahd/replay.mjs'
export AHD_REPRO_EXPECT=nonzero
CONTACT="${AHD_APPROVALS_FALLBACK_EMAIL:-you@example.com}"
export AHD_APPROVALS_FALLBACK_EMAIL="$CONTACT"
export AHD_VENDOR_JSON="{\"id\":\"ledgerly\",\"name\":\"Ledgerly\",\"risk_policy\":\"${AHD_RISK_POLICY:-autonomous}\",\"report_contacts\":[\"$CONTACT\"],\"test_command\":\"cd /ahd/work && node --test test/*.test.mjs\",\"stripe_customer_id\":\"${STRIPE_TEST_CUSTOMER_ID:-}\",\"payer_mode\":\"vendor\"}"
export AHD_DESK_URL="http://127.0.0.1:${PORT:-8787}"

case "${1:-check}" in
  check)  exec node demo/check-keys.mjs ;;
  server)
    node demo/check-keys.mjs || { echo "refusing to start: fix the keys first (or run check to see)"; exit 1; }
    [ -d product/node_modules/@blaxel/core ] || (cd product && npm i --no-save @blaxel/core)
    exec node --experimental-strip-types product/server.ts ;;
  mcp)
    # After `deploy`, the edge talks to the hosted desk with its token. AHD_MCP_LOCAL=1 keeps the local desk.
    if [ -f demo/.deploy.json ] && [ "${AHD_MCP_LOCAL:-0}" != "1" ]; then
      export AHD_DESK_URL="$(node -p "require('./demo/.deploy.json').url")"
      export AHD_DESK_TOKEN="$(node -p "require('./demo/.deploy.json').token")"
      echo "MCP edge -> hosted desk $AHD_DESK_URL"
    fi
    cd mcp && { [ -d node_modules ] || npm install --legacy-peer-deps; }
    exec npx mcp-use dev --tunnel ;;
  run)    exec node demo/run-live.mjs "${@:2}" ;;
  deploy)
    [ -d product/node_modules/@blaxel/core ] || (cd product && npm i --no-save @blaxel/core)
    exec node demo/deploy-blaxel.mjs ;;
  approve) exec node demo/approve.mjs "${2:-}" ;;
  logs) exec node demo/desk-logs.mjs ;;
  stripe) exec node demo/stripe-setup.mjs ;;
  stripe-seed) exec node demo/stripe-seed.mjs "${@:2}" ;;
  inkbox) exec node demo/inkbox-setup.mjs ;;
  cli) shift; exec node cli/ahd.mjs "$@" ;;
  armature) exec node demo/armature-pull.mjs ;;
  scenarios) exec node demo/scenarios-run.mjs "${@:2}" ;;
  remote)
    [ -f demo/.deploy.json ] || { echo "no demo/.deploy.json: run demo/live.sh deploy first"; exit 1; }
    URL=$(node -p "require('./demo/.deploy.json').url"); export AHD_API_TOKEN=$(node -p "require('./demo/.deploy.json').token")
    exec node demo/run-live.mjs --base "$URL" "${@:2}" ;;
  secrets) exec demo/gh-secrets.sh ;;
  cleanup)
    exec node demo/cleanup-sandboxes.mjs "${@:2}" ;;
  persist)
    exec node demo/persist-check.mjs "${@:2}" ;;
  *) echo "usage: demo/live.sh persist [record|verify|restart|standby|wipe]|cleanup|check|server|mcp|run|deploy|remote|stripe|stripe-seed|inkbox|armature|scenarios|cli|approve|logs|secrets"; exit 2 ;;
esac
