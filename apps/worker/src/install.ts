const TEMPLATE = `#!/bin/sh
# everywhere installer. Generated for one device enrollment; the token is single-use.
# Optional env: EVERYWHERE_BIN_DIR (install location), EVERYWHERE_NO_SERVICE=1
# (skip systemd), EVERYWHERE_BINARY (use a local binary instead of downloading).
set -eu

SERVER='__SERVER__'
TOKEN='__TOKEN__'
REPO='__REPO__'

die() { printf 'everywhere: %s\\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "only Linux is supported for now"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
for cmd in curl tar sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
done

if [ -n "\${EVERYWHERE_BIN_DIR:-}" ]; then BIN_DIR="$EVERYWHERE_BIN_DIR"
elif [ "$(id -u)" = 0 ]; then BIN_DIR=/usr/local/bin
else BIN_DIR="$HOME/.local/bin"; fi
mkdir -p "$BIN_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "\${EVERYWHERE_BINARY:-}" ]; then
  cp "$EVERYWHERE_BINARY" "$TMP/everywhere"
else
  ASSET="everywhere_linux_$ARCH.tar.gz"
  BASE="https://github.com/$REPO/releases/latest/download"
  echo "Downloading $ASSET..."
  curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET"
  curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt"
  (cd "$TMP" && grep " $ASSET\\$" checksums.txt | sha256sum -c - >/dev/null) || die "checksum mismatch"
  tar -xzf "$TMP/$ASSET" -C "$TMP" everywhere
fi

install -m 0755 "$TMP/everywhere" "$BIN_DIR/everywhere"
"$BIN_DIR/everywhere" enroll --server "$SERVER" --token "$TOKEN"
if [ -n "\${EVERYWHERE_NO_SERVICE:-}" ]; then
  echo "Skipping service install. Start the daemon with: $BIN_DIR/everywhere daemon"
else
  "$BIN_DIR/everywhere" service install
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH." ;;
esac
`;

export function installScript(opts: { server: string; token: string; repo: string }): string {
  return TEMPLATE.replace("__SERVER__", opts.server)
    .replace("__TOKEN__", opts.token)
    .replace("__REPO__", opts.repo);
}

export function failingScript(message: string): string {
  return `#!/bin/sh\necho 'everywhere: ${message.replaceAll("'", "")}' >&2\nexit 1\n`;
}
