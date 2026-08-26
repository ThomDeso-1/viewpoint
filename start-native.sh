#!/usr/bin/env bash
# Fallback for start.sh that doesn't need Docker at all — runs the app
# directly with Node.js, supervised by launchd so it also starts itself
# automatically at login and restarts itself if it ever crashes. Use this
# if Docker/OrbStack won't cooperate.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
source "$APP_DIR/lib-node-runtime.sh"

ensure_node

# If the effective Node changed since the last run (e.g. it upgraded, or
# this switched between a system install and the vendored copy), native
# modules like better-sqlite3 need to be rebuilt for the new ABI — a stale
# binary doesn't error cleanly, it segfaults. Wipe and let npm reinstall.
NODE_VERSION_MARKER="$APP_DIR/.node-version-used"
CURRENT_NODE_VERSION="$(node -v)"
if [ "$(cat "$NODE_VERSION_MARKER" 2>/dev/null || true)" != "$CURRENT_NODE_VERSION" ]; then
  rm -rf node_modules client/node_modules
fi

# Create these if they don't exist yet — never overwrites an existing .env,
# so your saved credentials are safe to run this again.
touch .env
mkdir -p data

PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

echo "Setting up Viewpoint Receipts (first run takes a minute or two)..."
npm install --no-fund --no-audit
(cd client && npm install --no-fund --no-audit)
echo "$CURRENT_NODE_VERSION" > "$NODE_VERSION_MARKER"

echo "Building..."
npm run build

# Installs a LaunchAgent — macOS's own background-process manager — so the
# app starts itself the moment you log in, and gets restarted automatically
# if it ever crashes. This replaces any previously-installed copy, so
# re-running this also works as a restart (e.g. after editing .env).
LAUNCH_AGENT_LABEL="com.viewpointreceipts.server"
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"

echo "Setting up automatic startup..."
launchctl unload -w "$LAUNCH_AGENT_PLIST" >/dev/null 2>&1 || true
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LAUNCH_AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${APP_DIR}/run-server.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${APP_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${APP_DIR}/server.log</string>
</dict>
</plist>
PLIST

launchctl load -w "$LAUNCH_AGENT_PLIST"

echo "Starting Viewpoint Receipts..."
READY=""
for i in $(seq 1 20); do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.5
done

if [ -z "$READY" ]; then
  echo "The app didn't start — check server.log for details."
  echo "If you previously tried the Docker version, make sure Docker Desktop"
  echo "isn't still using port $PORT (quit it from the menu bar), then try again."
  exit 1
fi

echo
echo "Started! Open this address in a browser on this computer:"
echo "  http://localhost:3000"
echo
echo "To use it from your iPhone, connect to the same Wi-Fi network and use"
echo "this computer's network address instead of 'localhost' — see GETTING-STARTED.md."
echo
echo "It'll now start itself automatically every time you log in, and"
echo "restart itself if it ever crashes — you shouldn't need to run this again."
