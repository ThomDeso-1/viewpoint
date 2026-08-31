#!/usr/bin/env bash
set -euo pipefail

# Packages the app into a clean, self-contained .zip you can hand to the
# end user — source code + Docker setup + start/stop scripts + docs, with
# no local dependencies, database, photos, or credentials included.
#
# update.sh downloads exactly this zip from the GitHub 'latest' release
# and rsyncs it over an installed copy.

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NAME="viewpoint-receipts"
OUT="$ROOT/${NAME}-bundle.zip"
STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/$NAME"

source "$ROOT/scripts/lib-stage.sh"

rm -f "$OUT"
stage_source "$STAGE"

( cd "$STAGE_PARENT" && zip -rq "$OUT" "$NAME" )
rm -rf "$STAGE_PARENT"

echo "Bundle written to: $OUT"
echo "Size: $(du -h "$OUT" | cut -f1)"
