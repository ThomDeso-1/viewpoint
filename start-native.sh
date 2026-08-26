#!/usr/bin/env bash
# Fallback for start.sh that doesn't need Docker at all — runs the app
# directly with Node.js. Use this if Docker/OrbStack won't cooperate.
set -euo pipefail
cd "$(dirname "$0")"

NODE_MIN_MAJOR=18

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed yet."
  echo "Install it first (choose the LTS version): https://nodejs.org/"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt "$NODE_MIN_MAJOR" ]; then
  echo "Node.js $(node -v) is too old — this app needs Node $NODE_MIN_MAJOR or newer."
  echo "Install a current version first: https://nodejs.org/"
  exit 1
fi

# Create these if they don't exist yet — never overwrites an existing .env,
# so your saved credentials are safe to run this again.
touch .env
mkdir -p data

if [ -f .server.pid ] && kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "Viewpoint Receipts is already running."
  echo "  http://localhost:3000"
  exit 0
fi

echo "Setting up Viewpoint Receipts (first run takes a minute or two)..."
npm install --no-fund --no-audit
(cd client && npm install --no-fund --no-audit)

echo "Building..."
npm run build

echo "Starting Viewpoint Receipts..."
NODE_ENV=production nohup node --import tsx server/index.ts > server.log 2>&1 &
echo $! > .server.pid
disown

sleep 1
if ! kill -0 "$(cat .server.pid)" 2>/dev/null; then
  echo "The app failed to start — check server.log for details."
  rm -f .server.pid
  exit 1
fi

echo
echo "Started! Open this address in a browser on this computer:"
echo "  http://localhost:3000"
echo
echo "To use it from your iPhone, connect to the same Wi-Fi network and use"
echo "this computer's network address instead of 'localhost' — see GETTING-STARTED.md."
echo
echo "Note: unlike the Docker version, this won't restart itself if the"
echo "computer reboots — just double-click start-native.command again."
