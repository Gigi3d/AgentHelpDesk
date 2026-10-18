#!/usr/bin/env bash
# demo/gh-secrets.sh: store the keep-live secrets in GitHub from your own machine. Prints no secret values.
#   demo/live.sh secrets     (needs the GitHub CLI: brew install gh && gh auth login)
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
REPO="${AHD_REPO:-Gigi3d/AgentHelpDesk}"
[ -f demo/.env.live ] && [ -f demo/.deploy.json ] || { echo "need demo/.env.live and demo/.deploy.json (run demo/live.sh deploy first)"; exit 1; }
command -v gh >/dev/null || { echo "install the GitHub CLI first: brew install gh && gh auth login"; exit 1; }
TOKEN=$(node -p "require('./demo/.deploy.json').token"); URL=$(node -p "require('./demo/.deploy.json').url")
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT; chmod 600 "$TMP"
{ grep -v '^AHD_API_TOKEN=' demo/.env.live; printf '\nAHD_API_TOKEN=%s\n' "$TOKEN"; } > "$TMP"
gh secret set ENV_LIVE -R "$REPO" < "$TMP"
gh variable set AHD_LIVE_URL -R "$REPO" --body "$URL"
echo "set ENV_LIVE and AHD_LIVE_URL ($URL) on $REPO"
echo "now run the workflow: gh workflow run keep-live -R $REPO"
