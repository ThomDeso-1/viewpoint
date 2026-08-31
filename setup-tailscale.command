#!/bin/bash
# Double-click to give Viewpoint a permanent HTTPS web address via Tailscale.
cd "$(dirname "$0")"
./scripts/setup-tailscale.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
