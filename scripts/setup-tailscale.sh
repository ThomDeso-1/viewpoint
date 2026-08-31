#!/usr/bin/env bash
# One-time setup: give Viewpoint a permanent HTTPS web address using
# Tailscale, so "Add to Home Screen" on the iPhone keeps working on any
# network (not just the same Wi-Fi).
#
# Before running this:
#   1. Install the Tailscale app:  https://tailscale.com/download/mac
#   2. Open it and sign in.
#   3. In the Tailscale admin console (login.tailscale.com/admin/dns),
#      turn on **MagicDNS** and **HTTPS Certificates**.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib-app.sh"
source "$APP_DIR/lib-node-runtime.sh"

echo "Setting up a permanent web address for Viewpoint via Tailscale..."
echo

# --- locate the tailscale CLI ------------------------------------------
TS=""
for c in \
  "$(command -v tailscale 2>/dev/null || true)" \
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
  "/opt/homebrew/bin/tailscale" \
  "/usr/local/bin/tailscale"
do
  if [ -n "$c" ] && [ -x "$c" ]; then TS="$c"; break; fi
done

if [ -z "$TS" ]; then
  echo "Tailscale isn't installed yet."
  echo "  1. Install it from https://tailscale.com/download/mac"
  echo "  2. Open the Tailscale app and sign in"
  echo "  3. Run this again"
  open "https://tailscale.com/download/mac" 2>/dev/null || true
  exit 1
fi

# --- check it's signed in --------------------------------------------
if ! "$TS" status >/dev/null 2>&1; then
  echo "Tailscale is installed but not signed in."
  echo "Open the Tailscale app (menu bar) → Log in, then run this again."
  exit 1
fi

# --- resolve this Mac's Tailscale hostname ---------------------------
ensure_node
HOST="$("$TS" status --json | node -e '
  let s = "";
  process.stdin.on("data", d => s += d);
  process.stdin.on("end", () => {
    try {
      const name = JSON.parse(s).Self.DNSName || "";
      process.stdout.write(name.replace(/\.$/, ""));
    } catch { process.exit(1); }
  });
' || true)"

if [ -z "$HOST" ]; then
  echo "Couldn't read this Mac's Tailscale name. Is MagicDNS enabled?"
  echo "  → https://login.tailscale.com/admin/dns  (turn on MagicDNS)"
  exit 1
fi
echo "This Mac is:  $HOST"

# --- point Tailscale at the app (HTTPS 443 → localhost:3000) ----------
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

echo "Enabling HTTPS forwarding to the app on port $PORT..."
if ! "$TS" serve --bg "$PORT" 2>/tmp/vp-ts-serve.err; then
  # Older Tailscale CLI syntax.
  if ! "$TS" serve --bg=true https / "http://127.0.0.1:${PORT}" 2>>/tmp/vp-ts-serve.err; then
    echo
    echo "Tailscale couldn't set up HTTPS. Most likely HTTPS Certificates"
    echo "aren't enabled for your tailnet yet:"
    echo "  → https://login.tailscale.com/admin/dns"
    echo "    enable 'MagicDNS' and 'HTTPS Certificates', then run this again."
    echo
    echo "Details:"
    sed 's/^/  /' /tmp/vp-ts-serve.err
    exit 1
  fi
fi

# --- tell the app it's now behind HTTPS ------------------------------
env_set APP_PUBLIC_URL "https://${HOST}"
env_set TRUST_PROXY 1
echo "Updated $ENV_FILE (APP_PUBLIC_URL, TRUST_PROXY)."

restart_server

cat <<DONE

Done. Viewpoint is now reachable at:

    https://${HOST}

On the iPhone (one time):
  1. Install Tailscale from the App Store and sign in to the SAME account.
  2. Open Safari and go to  https://${HOST}
  3. Log in, then Share → "Add to Home Screen".

That icon will keep working from any network, as long as this Mac is
awake and online. To undo all of this, run tailscale-off.command.
DONE
