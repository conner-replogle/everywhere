#!/bin/bash

# Installs the Omarchy theme extension into Chromium from this checkout:
# registers the native host, and loads the extension through
# ~/.config/chromium-flags.conf like Omarchy's own. Run it again after
# `omarchy refresh chromium`, which resets that file. Restart Chromium after.

set -euo pipefail

DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOST=dev.replogle.everywhere.omarchy_theme
FLAGS=$HOME/.config/chromium-flags.conf

mkdir -p "$HOME/.config/chromium/NativeMessagingHosts"
sed "s|__HOST_PATH__|$DIR/host.sh|" "$DIR/$HOST.json" >"$HOME/.config/chromium/NativeMessagingHosts/$HOST.json"

if [[ ! -f $FLAGS ]]; then
  echo "--load-extension=$DIR" >"$FLAGS"
elif grep -qF "$DIR" "$FLAGS"; then
  : # already loaded
elif grep -q '^--load-extension=' "$FLAGS"; then
  sed -i "s|^--load-extension=.*|&,$DIR|" "$FLAGS"
else
  echo "--load-extension=$DIR" >>"$FLAGS"
fi

echo "Installed. Restart Chromium to load it."
