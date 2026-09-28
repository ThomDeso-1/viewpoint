# Shared helpers for the operator-facing scripts (setup-tailscale.sh,
# tailscale-off.sh, update.sh). Source it after nothing in particular —
# it figures out the app directory itself.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
LAUNCH_AGENT_LABEL="com.viewpointreceipts.server"
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"

# Upsert KEY=VALUE in .env: replaces an existing uncommented `KEY=` line,
# otherwise appends. Comments and every other line are preserved, matching
# what the app's own updateEnvConfig() (server/platform/env-config.ts)
# tolerates. Keeps mode 0600.
env_set() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp="$(mktemp)"
  # `|| true`: grep -v exits 1 when it filters out every line (e.g. .env
  # held only this key), which would trip `set -e` in the caller.
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Remove an uncommented `KEY=` line from .env if present.
env_unset() {
  local key="$1" tmp
  [ -f "$ENV_FILE" ] || return 0
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# Print the value of an uncommented `KEY=` line in .env (quotes stripped),
# or nothing.
env_get() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

# Absolute path for a DATA_DIR / BACKUP_DIR value — relative ones resolve
# against the app folder, the same rule as server/db/paths.ts.
resolve_app_path() {
  case "$1" in
    /*) printf '%s\n' "${1%/}" ;;
    *)  local rel="${1#./}"; printf '%s\n' "$APP_DIR/${rel%/}" ;;
  esac
}

# Restart the background server so it re-reads .env.
restart_server() {
  local uid
  uid="$(id -u)"
  if launchctl kickstart -k "gui/${uid}/${LAUNCH_AGENT_LABEL}" 2>/dev/null; then
    return 0
  fi
  # Not loaded yet (fresh install / just migrated) — load it.
  if [ -f "$LAUNCH_AGENT_PLIST" ]; then
    launchctl load -w "$LAUNCH_AGENT_PLIST" 2>/dev/null || true
  else
    echo "  (server isn't set up yet — run start-native.command first)"
  fi
}
