#!/usr/bin/env bash
set -euo pipefail

# Builds an UNSIGNED macOS installer package: ViewpointApp-installer.pkg
#
# Double-clicking it installs the app to /Applications/ViewpointApp, then a
# postinstall script (scripts/pkg-scripts/postinstall) migrates any existing
# hand-run install and kicks off the normal first-run setup in a Terminal
# window.
#
# The payload is pure source — no node_modules, no build output — so the
# .pkg is architecture-independent. The native better-sqlite3 binary is
# fetched on first run on the target Mac by start-native.sh, same as today.
#
# Requires macOS (pkgbuild / productbuild). Run locally or in CI on
# macos-latest.

if [[ "$(uname)" != "Darwin" ]]; then
  echo "make-pkg.sh needs macOS (pkgbuild/productbuild)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/ViewpointApp-installer.pkg"
INSTALL_LOCATION="/Applications/ViewpointApp"
IDENTIFIER="com.viewpointreceipts.installer"

source "$ROOT/scripts/lib-stage.sh"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
BUILD="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
PKG_VERSION="${VERSION}.${BUILD}"

STAGE_PARENT="$(mktemp -d)"
PAYLOAD="$STAGE_PARENT/payload"
COMPONENT="$STAGE_PARENT/ViewpointApp-component.pkg"

trap 'rm -rf "$STAGE_PARENT"' EXIT

echo "Staging source (v${PKG_VERSION})..."
stage_source "$PAYLOAD"

echo "Building component package..."
pkgbuild \
  --root "$PAYLOAD" \
  --identifier "$IDENTIFIER" \
  --version "$PKG_VERSION" \
  --install-location "$INSTALL_LOCATION" \
  --scripts "$ROOT/scripts/pkg-scripts" \
  "$COMPONENT"

echo "Building distribution package..."
rm -f "$OUT"
productbuild \
  --distribution "$ROOT/scripts/pkg-resources/distribution.xml" \
  --package-path "$STAGE_PARENT" \
  --resources "$ROOT/scripts/pkg-resources" \
  "$OUT"

echo
echo "Unsigned installer written to: $OUT"
echo "Version: $PKG_VERSION"
echo "Size: $(du -h "$OUT" | cut -f1)"
