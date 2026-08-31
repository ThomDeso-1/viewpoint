#!/usr/bin/env bash
# Undo setup-tailscale.command: stop serving the app over Tailscale and
# remove the HTTPS settings from .env.
#
# Note: once the app holds real patient data it refuses to start over
# plain HTTP (server/platform/phi-guard.ts). After running this you're
# back to same-Wi-Fi-only access via the Mac's IP address, and you may
# need another HTTPS setup before it will start again.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib-app.sh"

TS=""
for c in \
  "$(command -v tailscale 2>/dev/null || true)" \
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
  "/opt/homebrew/bin/tailscale" \
  "/usr/local/bin/tailscale"
do
  if [ -n "$c" ] && [ -x "$c" ]; then TS="$c"; break; fi
done

if [ -n "$TS" ]; then
  echo "Turning off Tailscale HTTPS forwarding..."
  "$TS" serve reset 2>/dev/null || true
fi

env_unset APP_PUBLIC_URL
env_unset TRUST_PROXY
echo "Removed APP_PUBLIC_URL and TRUST_PROXY from $ENV_FILE."

restart_server
echo "Done."
