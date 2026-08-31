#!/usr/bin/env bash
# Stop Viewpoint and remove its background service. Does NOT delete your
# data — that lives in the app folder, which you remove by hand afterwards.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/lib-app.sh"

echo "Stopping Viewpoint..."
launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" 2>/dev/null || true
launchctl unload -w "$LAUNCH_AGENT_PLIST" 2>/dev/null || true
rm -f "$LAUNCH_AGENT_PLIST"

TS=""
for c in "$(command -v tailscale 2>/dev/null || true)" \
         "/Applications/Tailscale.app/Contents/MacOS/Tailscale"; do
  if [ -n "$c" ] && [ -x "$c" ]; then TS="$c"; break; fi
done
[ -n "$TS" ] && "$TS" serve reset 2>/dev/null || true

cat <<DONE
Viewpoint has been stopped and will no longer start at login.

Your data and credentials are still in:
    $APP_DIR/data
    $APP_DIR/.env   (contains DATA_ENCRYPTION_KEY — needed to read data/)

To finish removing the app: copy those somewhere safe if you want to keep
them, then drag $APP_DIR to the Trash.
DONE
