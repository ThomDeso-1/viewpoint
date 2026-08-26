#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .server.pid ]; then
  echo "Not running."
  exit 0
fi

PID="$(cat .server.pid)"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped."
else
  echo "Not running."
fi
rm -f .server.pid
