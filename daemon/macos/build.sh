#!/bin/sh
# Builds EverywhereDesktop.app, the remote desktop helper for macOS (see
# Sources/main.swift), for arm64 and x86_64 in one bundle.
#
#   macos/build.sh [version] [out dir]     (default: dev, ../bin)
#
# It's signed with $MAC_SIGN_IDENTITY, or ad hoc without one: macOS then asks
# for Screen Recording and Accessibility again after every update.
set -eu
cd "$(dirname "$0")"
VERSION="${1:-dev}"
OUT="${2:-../bin}"
APP="$OUT/EverywhereDesktop.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos14" -module-name EverywhereDesktop \
    -o "$TMP/everywhere-desktop-$arch" Sources/*.swift
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
lipo -create -output "$APP/Contents/MacOS/everywhere-desktop" "$TMP"/everywhere-desktop-*
sed "s/VERSION/$VERSION/g" Info.plist >"$APP/Contents/Info.plist"
if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$MAC_SIGN_IDENTITY" "$APP"
else
  codesign --force --options runtime --timestamp=none --sign - "$APP"
fi
echo "$APP"
