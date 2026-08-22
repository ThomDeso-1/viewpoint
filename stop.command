#!/bin/bash
# Double-click this file in Finder to stop the app.
cd "$(dirname "$0")"
./stop.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
