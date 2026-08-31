#!/bin/bash
# Double-click to stop serving Viewpoint over Tailscale.
cd "$(dirname "$0")"
./scripts/tailscale-off.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
