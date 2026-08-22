#!/usr/bin/env bash
set -euo pipefail

# Packages the app into a clean, self-contained .zip you can hand to the
# end user — source code + Docker setup + start/stop scripts + docs, with
# no local dependencies, database, photos, or credentials included.

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NAME="viewpoint-receipts"
OUT="$ROOT/${NAME}-bundle.zip"
STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/$NAME"

rm -f "$OUT"
mkdir -p "$STAGE"

rsync -a \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='node_modules' \
  --exclude='client/node_modules' \
  --exclude='dist' \
  --exclude='client/dist' \
  --exclude='data' \
  --exclude='backups' \
  --exclude='.env' \
  --exclude='.DS_Store' \
  --exclude="${NAME}-bundle.zip" \
  ./ "$STAGE"/

( cd "$STAGE_PARENT" && zip -rq "$OUT" "$NAME" )
rm -rf "$STAGE_PARENT"

echo "Bundle written to: $OUT"
echo "Size: $(du -h "$OUT" | cut -f1)"
