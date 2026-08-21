#!/bin/bash
# Viewpoint Receipts — one-command Xcode project setup
# Prerequisites: Xcode 15+, Homebrew
set -e

echo "=== Viewpoint Receipts Setup ==="
echo ""

# Check for Xcode command-line tools
if ! command -v xcodebuild &> /dev/null; then
    echo "Error: Xcode command-line tools are required."
    echo "Install Xcode from the App Store, then run: xcode-select --install"
    exit 1
fi

# Install XcodeGen if needed
if ! command -v xcodegen &> /dev/null; then
    echo "Installing XcodeGen via Homebrew..."
    if ! command -v brew &> /dev/null; then
        echo "Error: Homebrew is required to install XcodeGen."
        echo "Install from https://brew.sh"
        exit 1
    fi
    brew install xcodegen
fi

# Generate the Xcode project
echo "Generating Xcode project..."
xcodegen generate

echo ""
echo "=== Project generated ==="
echo ""
echo "Next steps:"
echo "  1. Open ViewpointReceipts.xcodeproj (opening now...)"
echo "  2. In Signing & Capabilities:"
echo "     - Select your Development Team"
echo "     - Add the 'iCloud' capability"
echo "     - Check 'iCloud Documents'"
echo "     - Add container: iCloud.com.viewpoint.receipts"
echo "  3. Plug in your iPhone and build (Cmd+R)"
echo ""
echo "  Bundle ID:         com.viewpoint.receipts"
echo "  iCloud container:  iCloud.com.viewpoint.receipts"
echo "  Min iOS:           17.0"
echo ""

open ViewpointReceipts.xcodeproj
