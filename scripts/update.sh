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

# Where the database lives — same resolution as server/db/paths.ts.
DATA_SETTING="$(env_get DATA_DIR)"
DATA_PATH="$(resolve_app_path "${DATA_SETTING:-./data}")"
BACKUP_SETTING="$(env_get BACKUP_DIR)"
if [ -n "$BACKUP_SETTING" ]; then
  BACKUP_PATH="$(resolve_app_path "$BACKUP_SETTING")"
else
  BACKUP_PATH="$DATA_PATH/backups"
fi
DB="$DATA_PATH/receipts.db"

# The database sitting directly in the app folder can't be protected from
# the --delete below without also freezing the code — refuse outright.
if [ "$(cd "$DATA_PATH" 2>/dev/null && pwd -P)" = "$(cd "$APP_DIR" && pwd -P)" ]; then
  echo "DATA_DIR in .env points at the app folder itself — updating would delete the database."
  echo "Move the database into a data/ subfolder (and set DATA_DIR=./data) first. Aborting."
  exit 1
fi

# rsync --delete removes anything in the app folder the new build doesn't
# have. update-preserve.txt covers the default data/ and backups/; if
# DATA_DIR or BACKUP_DIR were moved to some other folder *inside* the app
# folder, protect those too, or the update would delete them.
EXTRA_EXCLUDES=()
for p in "$DATA_PATH" "$BACKUP_PATH"; do
  case "$p" in
    "$APP_DIR"/*) EXTRA_EXCLUDES+=("--exclude=/${p#"$APP_DIR"/}/") ;;
  esac
done

# Snapshot the database before touching anything. VACUUM INTO writes a
# consistent copy even while the server is running (a plain cp would miss
# whatever is still in the -wal file). No snapshot → no update.
HAD_DB=""
if [ -f "$DB" ]; then
  HAD_DB=1
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3 not found, so the database can't be backed up first — aborting update."
    exit 1
  fi
  mkdir -p "$BACKUP_PATH"
  SNAP="$BACKUP_PATH/receipts-pre-update-$(date -u +%Y-%m-%dT%H-%M-%SZ).db"
  sqlite3 "$DB" "VACUUM INTO '$SNAP'"
  chmod 600 "$SNAP"
  echo "Database backed up to $SNAP"
fi

echo "Applying update (your data and settings are kept)..."
rsync -a --delete --exclude-from="$DIR/update-preserve.txt" ${EXTRA_EXCLUDES[@]+"${EXTRA_EXCLUDES[@]}"} "$SRC"/ "$APP_DIR"/

if [ -n "$HAD_DB" ] && [ ! -f "$DB" ]; then
  echo "ERROR: the database at $DB is missing after the update."
  echo "Restore it from $SNAP before starting the app. Not restarting."
  exit 1
fi
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
