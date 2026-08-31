#!/usr/bin/env bash
# Update Viewpoint to the latest build.
#
# Downloads the current bundle from the GitHub 'latest' release, replaces
# the app code (keeping your data, credentials and downloaded Node), then
# rebuilds and restarts.
#
# Safe to run any time. Can also be run remotely over Tailscale SSH:
#   ssh <this-mac>.<tailnet>.ts.net 'bash /Applications/ViewpointApp/scripts/update.sh'
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib-app.sh"
source "$APP_DIR/lib-node-runtime.sh"

BUNDLE_URL="https://github.com/ThomDeso-1/viewpoint/releases/download/latest/viewpoint-receipts-bundle.zip"

echo "Current build: $(cat "$APP_DIR/BUILD_INFO" 2>/dev/null || echo unknown)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading latest build..."
curl -fSL "$BUNDLE_URL" -o "$TMP/bundle.zip"

echo "Unpacking..."
unzip -q "$TMP/bundle.zip" -d "$TMP/x"
SRC="$TMP/x/viewpoint-receipts"
[ -d "$SRC" ] || { echo "Unexpected bundle layout — aborting."; exit 1; }

echo "Applying update (your data and settings are kept)..."
rsync -a --delete --exclude-from="$DIR/update-preserve.txt" "$SRC"/ "$APP_DIR"/
chmod +x "$APP_DIR"/*.command "$APP_DIR"/*.sh "$APP_DIR"/scripts/*.sh 2>/dev/null || true

echo "Installing dependencies..."
ensure_node
cd "$APP_DIR"
npm install --no-fund --no-audit --ignore-scripts
( cd client && npm install --no-fund --no-audit --ignore-scripts )

echo "Building..."
npm run build

echo "Restarting..."
restart_server

echo
echo "Updated to: $(cat "$APP_DIR/BUILD_INFO" 2>/dev/null || echo unknown)"
