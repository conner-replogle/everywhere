const TEMPLATE = `#!/bin/sh
# everywhere installer. Generated for one device enrollment; the token is single-use.
# Optional env: EVERYWHERE_BIN_DIR (install location), EVERYWHERE_NO_SERVICE=1
# (skip the systemd/launchd service), EVERYWHERE_BINARY (use a local binary instead of downloading).
set -eu

SERVER='__SERVER__'
TOKEN='__TOKEN__'
REPO='__REPO__'

die() { printf 'everywhere: %s\\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  MINGW* | MSYS* | CYGWIN*) die "on Windows, run the PowerShell install command from the web UI instead" ;;
  *) die "unsupported OS: $(uname -s); only Linux, macOS and Windows are supported" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac
for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
done
# macOS has shasum rather than sha256sum.
if command -v sha256sum >/dev/null 2>&1; then SHA256SUM=sha256sum
elif command -v shasum >/dev/null 2>&1; then SHA256SUM="shasum -a 256"
else die "sha256sum or shasum is required"; fi

if [ -n "\${EVERYWHERE_BIN_DIR:-}" ]; then BIN_DIR="$EVERYWHERE_BIN_DIR"
elif [ "$(id -u)" = 0 ]; then BIN_DIR=/usr/local/bin
else BIN_DIR="$HOME/.local/bin"; fi
mkdir -p "$BIN_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ -n "\${EVERYWHERE_BINARY:-}" ]; then
  cp "$EVERYWHERE_BINARY" "$TMP/everywhere"
  # The remote desktop worker, if it was built next to it.
  WORKER="$(dirname "$EVERYWHERE_BINARY")/everywhere-desktop"
  if [ -f "$WORKER" ]; then cp "$WORKER" "$TMP/everywhere-desktop"; fi
else
  ASSET="everywhere_\${OS}_$ARCH.tar.gz"
  BASE="https://github.com/$REPO/releases/latest/download"
  echo "Downloading $ASSET..."
  curl -fsSL "$BASE/$ASSET" -o "$TMP/$ASSET"
  curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt"
  (cd "$TMP" && grep " $ASSET\\$" checksums.txt | $SHA256SUM -c - >/dev/null) || die "checksum mismatch"
  tar -xzf "$TMP/$ASSET" -C "$TMP"
fi

install -m 0755 "$TMP/everywhere" "$BIN_DIR/everywhere"
# Linux releases carry the remote desktop worker; it must sit next to the daemon.
if [ -f "$TMP/everywhere-desktop" ]; then
  install -m 0755 "$TMP/everywhere-desktop" "$BIN_DIR/everywhere-desktop"
fi
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

// The Windows installer, piped from irm into iex in PowerShell 5.1 or later. It
// throws rather than exits: exit would close the user's PowerShell window.
const WINDOWS_TEMPLATE = `# everywhere installer for Windows. Generated for one device enrollment; the token is single-use.
# Optional env: EVERYWHERE_BIN_DIR (install location), EVERYWHERE_NO_SERVICE=1
# (skip the scheduled task), EVERYWHERE_BINARY (use a local binary instead of downloading).
& {
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar slows downloads to a crawl.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Server = '__SERVER__'
$Token = '__TOKEN__'
$Repo = '__REPO__'

function Die($msg) { throw "everywhere: $msg" }

# 32-bit PowerShell on 64-bit Windows reports the real architecture separately.
$Machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$Arch = switch ($Machine) { 'AMD64' { 'amd64' } 'ARM64' { 'arm64' } default { Die "unsupported architecture: $Machine" } }

$BinDir = if ($env:EVERYWHERE_BIN_DIR) { $env:EVERYWHERE_BIN_DIR } else { Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'everywhere' }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ('everywhere-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
  if ($env:EVERYWHERE_BINARY) {
    Copy-Item $env:EVERYWHERE_BINARY (Join-Path $Tmp 'everywhere.exe')
    # The remote desktop worker, if it was built next to it.
    $Worker = Join-Path (Split-Path $env:EVERYWHERE_BINARY) 'everywhere-desktop.exe'
    if (Test-Path $Worker) { Copy-Item $Worker (Join-Path $Tmp 'everywhere-desktop.exe') }
  } else {
    $Asset = "everywhere_windows_$Arch.tar.gz"
    $Base = "https://github.com/$Repo/releases/latest/download"
    $Archive = Join-Path $Tmp $Asset
    $Sums = Join-Path $Tmp 'checksums.txt'
    Write-Host "Downloading $Asset..."
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Asset" -OutFile $Archive
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/checksums.txt" -OutFile $Sums
    $Want = Get-Content $Sums | Where-Object { $_.EndsWith(" $Asset") } | ForEach-Object { ($_ -split ' ')[0] } | Select-Object -First 1
    $Got = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLower()
    if (-not $Want -or $Got -ne $Want) { Die 'checksum mismatch' }
    tar.exe -xzf $Archive -C $Tmp
    if ($LASTEXITCODE -ne 0) { Die "couldn't extract $Asset" }
  }

  $Exe = Join-Path $BinDir 'everywhere.exe'
  # A running binary can't be overwritten but can be renamed; the daemon
  # deletes the old one once it restarts. The remote desktop worker must sit
  # next to the daemon.
  foreach ($Name in 'everywhere.exe', 'everywhere-desktop.exe') {
    $Src = Join-Path $Tmp $Name
    if (-not (Test-Path $Src)) { continue }
    $Dst = Join-Path $BinDir $Name
    if (Test-Path $Dst) { Move-Item $Dst (Join-Path $BinDir ('.' + $Name + '.' + [DateTime]::UtcNow.Ticks + '.old')) }
    Copy-Item $Src $Dst
  }
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}

& $Exe enroll --server $Server --token $Token
if ($LASTEXITCODE -ne 0) { Die 'enrollment failed' }
if ($env:EVERYWHERE_NO_SERVICE) {
  Write-Host "Skipping service install. Start the daemon with: $Exe daemon"
} else {
  & $Exe service install
  if ($LASTEXITCODE -ne 0) { Die "couldn't install the service" }
}

# Add the install directory to the user's PATH, keeping the value's type so
# entries like %USERPROFILE% keep expanding.
$EnvKey = Get-Item 'HKCU:\\Environment'
$UserPath = $EnvKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
if (($UserPath -split ';') -notcontains $BinDir) {
  $NewPath = if ($UserPath) { $UserPath.TrimEnd(';') + ';' + $BinDir } else { $BinDir }
  Set-ItemProperty 'HKCU:\\Environment' -Name Path -Value $NewPath -Type ExpandString
  # Setting a variable tells running programs the environment changed.
  [Environment]::SetEnvironmentVariable('EVERYWHERE_INSTALL', '1', 'User')
  [Environment]::SetEnvironmentVariable('EVERYWHERE_INSTALL', $null, 'User')
  $env:Path += ";$BinDir"
  Write-Host "Added $BinDir to your PATH; open a new terminal to use everywhere."
}
}
`;

export type InstallPlatform = "unix" | "windows";

export function installScript(opts: { server: string; token: string; repo: string; platform?: InstallPlatform }): string {
  return (opts.platform === "windows" ? WINDOWS_TEMPLATE : TEMPLATE)
    .replace("__SERVER__", opts.server)
    .replace("__TOKEN__", opts.token)
    .replace("__REPO__", opts.repo);
}

export function failingScript(message: string, platform: InstallPlatform = "unix"): string {
  const clean = message.replaceAll("'", "");
  if (platform === "windows") return `throw 'everywhere: ${clean}'\n`;
  return `#!/bin/sh\necho 'everywhere: ${clean}' >&2\nexit 1\n`;
}
