#!/bin/bash
# Double-click this file in Finder to stop the app started via start-native.command.
cd "$(dirname "$0")"
./stop-native.sh
echo
read -n 1 -s -r -p "Press any key to close this window..."
echo
