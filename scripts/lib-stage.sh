# Shared by make-bundle.sh and make-pkg.sh. Not meant to be run directly —
# source it, then call `stage_source <dest-dir>`.
#
# Copies a clean tree of the app into <dest-dir>: source code + start/stop
# scripts + docs, with no local dependencies, build output, database,
# photos, or credentials. Also drops a BUILD_INFO file (git sha + UTC
# timestamp) that update.sh and the release notes read to identify a build.

# shellcheck disable=SC2034  # callers use this
STAGE_EXCLUDES=(
  --exclude='.git'
  --exclude='.github'
  --exclude='node_modules'
  --exclude='client/node_modules'
  --exclude='dist'
  --exclude='client/dist'
  --exclude='.node-runtime'
  --exclude='.node-version-used'
  --exclude='data'
  --exclude='backups'
  --exclude='demo-data'
  --exclude='.env'
  --exclude='server.log'
  --exclude='.DS_Store'
  --exclude='viewpoint-receipts-bundle.zip'
  --exclude='ViewpointApp-installer.pkg'
)

stage_source() {
  local dest="$1"
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  mkdir -p "$dest"
  rsync -a "${STAGE_EXCLUDES[@]}" "$root"/ "$dest"/

  # Strip macOS extended attributes (provenance, quarantine, …) so a pkg
  # payload / zip built from this tree doesn't carry AppleDouble ._ files.
  if command -v xattr >/dev/null 2>&1; then
    xattr -rc "$dest" 2>/dev/null || true
  fi

  local sha
  sha="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf '%s %s\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/BUILD_INFO"
}
