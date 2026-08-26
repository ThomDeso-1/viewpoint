#!/usr/bin/env bash
# What the LaunchAgent (installed by start-native.sh) actually runs. Assumes
# `npm install` / `npm run build` already happened — this only starts the
# already-built app, so it launches fast on every login.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"
source "$APP_DIR/lib-node-runtime.sh"

ensure_node

export NODE_ENV=production
exec node --import tsx server/index.ts
