#!/bin/bash
# Fallback for start.command that doesn't need Docker — double-click this
# if Docker/OrbStack won't start. Runs the app directly with Node.js.
cd "$(dirname "$0")"
./start-native.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
