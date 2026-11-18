#!/bin/sh
# Build the sandboxed reader. The first argument is the app path. MESSAGES_SIGN_IDENTITY is a codesign identity.
set -eu
src=$(cd "$(dirname "$0")" && pwd)
app=${1:-$HOME/.local/state/messages/MessagesReader.app}
mkdir -p "$app/Contents/MacOS"
cp "$src/Info.plist" "$app/Contents/Info.plist"
swiftc -O -o "$app/Contents/MacOS/reader" "$src/main.swift"
codesign --force --sign "${MESSAGES_SIGN_IDENTITY:--}" --entitlements "$src/reader.entitlements" "$app"
echo "built $app"
