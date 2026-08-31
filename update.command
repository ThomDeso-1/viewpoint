#!/bin/bash
# Double-click to update Viewpoint to the latest build.
cd "$(dirname "$0")"
./scripts/update.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
