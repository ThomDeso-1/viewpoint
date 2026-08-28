#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed yet."
  echo "Install Docker Desktop first: https://www.docker.com/products/docker-desktop/"
  exit 1
fi

# Create these if they don't exist yet — never overwrites an existing .env,
# so your saved credentials are safe to run this again.
touch .env
mkdir -p data

echo "Starting Viewpoint Receipts..."
docker compose up -d --build

echo
echo "Started! Open this address in a browser on this computer:"
echo "  http://localhost:3000"
echo
echo "To use it from your iPhone, connect to the same Wi-Fi network and use"
echo "this computer's network address instead of 'localhost' — see docs/GETTING-STARTED.md."
