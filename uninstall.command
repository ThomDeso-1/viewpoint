#!/bin/bash
# Double-click to stop Viewpoint and remove its background service.
cd "$(dirname "$0")"
./scripts/uninstall.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
