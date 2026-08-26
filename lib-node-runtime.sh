# Shared by start-native.sh and run-server.sh. Not meant to be run directly —
# source it after setting APP_DIR to the app's own folder.
#
#   APP_DIR="$(cd "$(dirname "$0")" && pwd)"
#   source "$APP_DIR/lib-node-runtime.sh"

# launchd (used for auto-start at login) hands scripts a minimal PATH that
# doesn't include Homebrew or other common install locations, so broaden it
# before looking for an existing Node install.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# better-sqlite3's native addon needs Node 22+ (older Node ABI builds cause
# a silent crash rather than a clean error), so that's the floor here too.
NODE_MIN_MAJOR=22
NODE_VENDOR_MAJOR=22
RUNTIME_DIR="$APP_DIR/.node-runtime"
LOCAL_NODE_BIN="$RUNTIME_DIR/bin"

# Makes sure a usable `node`/`npm` end up on PATH, one way or another: uses
# the system install if it's new enough, otherwise downloads a private copy
# matched to this Mac's actual processor (Intel vs Apple Silicon) into
# .node-runtime/ — no admin password, no system-wide install, no terminal
# typing required. Always resolves the latest v22.x build at download time
# rather than a hardcoded version, so this doesn't rot as old point releases
# get removed from nodejs.org.
ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
      return
    fi
  fi

  if [ -x "$LOCAL_NODE_BIN/node" ]; then
    export PATH="$LOCAL_NODE_BIN:$PATH"
    return
  fi

  echo "Node.js isn't installed (or is too old) — downloading a private copy"
  echo "just for this app (one-time, doesn't touch anything else on your Mac)..."

  local arch shasums_url filename url
  case "$(uname -m)" in
    arm64)  arch="arm64" ;;
    x86_64) arch="x64" ;;
    *)
      echo "Unrecognized processor type: $(uname -m)."
      echo "Install Node.js manually instead: https://nodejs.org/"
      exit 1
      ;;
  esac

  shasums_url="https://nodejs.org/dist/latest-v${NODE_VENDOR_MAJOR}.x/SHASUMS256.txt"
  filename="$(curl -fsSL "$shasums_url" 2>/dev/null | grep -o "node-v${NODE_VENDOR_MAJOR}\.[0-9]*\.[0-9]*-darwin-${arch}\.tar\.gz" | head -1 || true)"

  if [ -z "$filename" ]; then
    echo "Couldn't figure out which Node.js build to download."
    echo "Install it manually instead: https://nodejs.org/"
    exit 1
  fi

  url="https://nodejs.org/dist/latest-v${NODE_VENDOR_MAJOR}.x/${filename}"

  mkdir -p "$RUNTIME_DIR"
  if ! curl -fSL "$url" -o "$RUNTIME_DIR/$filename"; then
    echo "Couldn't download Node.js — check your internet connection and try again."
    echo "Or install it manually: https://nodejs.org/"
    rm -rf "$RUNTIME_DIR"
    exit 1
  fi
  tar -xzf "$RUNTIME_DIR/$filename" -C "$RUNTIME_DIR" --strip-components=1
  rm -f "$RUNTIME_DIR/$filename"

  if [ ! -x "$LOCAL_NODE_BIN/node" ]; then
    echo "Couldn't set up Node.js automatically. Install it manually: https://nodejs.org/"
    exit 1
  fi

  export PATH="$LOCAL_NODE_BIN:$PATH"
}
