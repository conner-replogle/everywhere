#!/bin/bash

# Native messaging host for the Omarchy Theme extension: sends the current
# Omarchy theme's colors.toml as JSON, then again whenever it changes, until
# Chromium closes the connection.

set -uo pipefail

theme_dir() {
  local dir
  for dir in "$HOME/.local/state/omarchy/current" "$HOME/.config/omarchy/current"; do
    [[ -f $dir/theme/colors.toml ]] && echo "$dir" && return
  done
}

# {"name": "miasma", "colors": {"mode": "dark", "background": "#222222", ...}},
# or {"name": null, "colors": null} without an Omarchy theme.
read_theme() {
  local dir name
  dir=$(theme_dir)
  if [[ -z $dir ]]; then
    echo '{"name":null,"colors":null}'
    return
  fi
  name=$(cat "$dir/theme.name" 2>/dev/null)
  sed -nE 's/^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*"([^"]*)".*/\1\t\2/p' "$dir/theme/colors.toml" |
    jq -Rsc --arg name "$name" '
      split("\n") | map(select(length > 0) | split("\t") | {(.[0]): .[1]}) | add // {}
      | {name: $name, colors: .}'
}

# A native message: its length as 4 bytes, little-endian, then the JSON.
send() {
  local msg=$1
  local n
  n=$(LC_ALL=C; echo ${#msg})
  printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' $((n & 255)) $((n >> 8 & 255)) $((n >> 16 & 255)) $((n >> 24 & 255)))"
  printf '%s' "$msg"
}

last=""
while true; do
  theme=$(read_theme)
  if [[ $theme != "$last" ]]; then
    send "$theme"
    last=$theme
  fi
  # omarchy theme set swaps the whole theme directory, so poll. The extension
  # never writes, so read only returns early when Chromium closes stdin.
  read -r -t 2 _
  (($? > 128)) || exit 0
done
