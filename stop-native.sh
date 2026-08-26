#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

LAUNCH_AGENT_LABEL="com.viewpointreceipts.server"
LAUNCH_AGENT_PLIST="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"

if [ ! -f "$LAUNCH_AGENT_PLIST" ]; then
  echo "Not running."
  exit 0
fi

launchctl unload -w "$LAUNCH_AGENT_PLIST" 2>/dev/null || true
echo "Stopped. It won't start itself again until you double-click start-native.command."
