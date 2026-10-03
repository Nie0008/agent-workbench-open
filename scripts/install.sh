#!/bin/sh
# Install Agent Workbench for the current macOS user. No sudo, DSH installation, or client configuration changes.
set -eu
archive=
checksum=
version=latest
noninteractive=0
apps=${WORKBENCH_APPLICATIONS_DIR:-"$HOME/Applications"}
bin=${WORKBENCH_BIN_DIR:-"$HOME/.local/bin"}
repo=${WORKBENCH_RELEASE_REPO:-Nie0008/agent-workbench-open}
fail() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) [ "$#" -ge 2 ] || fail '--archive requires a path'; archive=$2; shift 2 ;;
    --checksum) [ "$#" -ge 2 ] || fail '--checksum requires a path'; checksum=$2; shift 2 ;;
    --version) [ "$#" -ge 2 ] || fail '--version requires a version'; version=$2; shift 2 ;;
    --noninteractive) noninteractive=1; shift ;;
    --help) printf '%s\n' 'Usage: sh install.sh [--version VERSION | --archive ZIP] [--checksum FILE] [--noninteractive]'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
[ "$(uname -s)" = Darwin ] || fail 'This installer supports macOS; use install.ps1 on Windows.'
case $(uname -m) in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) fail 'Unsupported macOS architecture' ;; esac
printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fail 'Invalid release repository'
tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-workbench-install.XXXXXX")
stage=
backup_app=
backup_command=
backup_dispatch=
installed=0
installed_command=0
installed_dispatch=0
committed=0
app="$apps/Agent Workbench.app"
command_path="$bin/workbench"
dispatch_path="$bin/agent-workbench"
cleanup() {
  status=$?
  if [ "$committed" -eq 0 ]; then
    if [ "$installed" -eq 1 ]; then rm -rf "$app"; fi
    if [ "$installed_command" -eq 1 ]; then rm -f "$command_path"; fi
    if [ "$installed_dispatch" -eq 1 ]; then rm -f "$dispatch_path"; fi
    if [ -n "$backup_app" ] && [ -e "$backup_app" ]; then mv "$backup_app" "$app"; fi
    if [ -n "$backup_command" ] && { [ -e "$backup_command" ] || [ -L "$backup_command" ]; }; then
      rm -f "$command_path"; mv "$backup_command" "$command_path"
    fi
    if [ -n "$backup_dispatch" ] && { [ -e "$backup_dispatch" ] || [ -L "$backup_dispatch" ]; }; then
      rm -f "$dispatch_path"; mv "$backup_dispatch" "$dispatch_path"
    fi
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [ -z "$archive" ]; then
  use_gh=0
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then use_gh=1; fi
  if [ "$version" = latest ]; then
    if [ "$use_gh" -eq 1 ]; then
      version=$(gh release view --repo "$repo" --json tagName --jq '.tagName') || fail 'Cannot read release with gh. Check repository access, or use --archive for offline installation.'
    else
      release_url=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output /dev/null --write-out '%{url_effective}' "https://github.com/$repo/releases/latest") || fail 'Cannot download release. A private repository requires authenticated gh, or --archive for offline installation.'
      version=${release_url##*/}
    fi
    version=${version#v}
  fi
  printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || fail 'Invalid release version'
  asset="agent-workbench-$version-darwin-$arch.zip"
  archive="$tmp/$asset"
  checksum="$archive.sha256"
  base="https://github.com/$repo/releases/download/v$version"
  if [ "$use_gh" -eq 1 ]; then
    gh release download "v$version" --repo "$repo" --pattern "$asset" --pattern "$asset.sha256" --dir "$tmp" || fail 'Cannot download release with gh. Check repository access, or use --archive for offline installation.'
  else
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$base/$asset" --output "$archive" || fail 'Cannot download release. A private repository requires authenticated gh, or --archive for offline installation.'
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$base/$asset.sha256" --output "$checksum" || fail 'Cannot download SHA-256 file. A private repository requires authenticated gh, or --archive for offline installation.'
  fi
fi
checksum=${checksum:-"$archive.sha256"}
[ -f "$archive" ] && [ -f "$checksum" ] || fail 'Archive and SHA-256 file are required.'
expected=$(awk 'NR==1 { print $1 }' "$checksum")
printf '%s' "$expected" | grep -Eq '^[0-9A-Fa-f]{64}$' || fail 'Invalid SHA-256 file'
actual=$(shasum -a 256 "$archive" | awk '{print $1}')
[ "$(printf '%s' "$expected" | tr A-F a-f)" = "$actual" ] || fail 'SHA-256 verification failed; nothing was installed.'
unzip -Z1 "$archive" > "$tmp/entries"
awk 'BEGIN { bad=0 } !/^agent-workbench\// || /(^|\/)\.\.(\/|$)/ || /\\/ { bad=1 } END { exit bad }' "$tmp/entries" || fail 'Unsafe archive paths'
unzip -q "$archive" -d "$tmp/unpacked"
bundle="$tmp/unpacked/agent-workbench"
[ -f "$bundle/bundle.json" ] || fail 'Missing bundle metadata'
grep -Eq '"platform"[[:space:]]*:[[:space:]]*"darwin"' "$bundle/bundle.json" || fail 'Wrong package platform'
grep -Eq '"arch"[[:space:]]*:[[:space:]]*"'"$arch"'"' "$bundle/bundle.json" || fail 'Wrong package architecture'
source_app="$bundle/Agent Workbench.app"
[ -x "$source_app/Contents/MacOS/Electron" ] && [ -f "$source_app/Contents/Resources/app/dist/main/cli.js" ] && [ -f "$source_app/Contents/Resources/app/bin/agent-workbench.mjs" ] || fail 'Incomplete application bundle'
running() {
  ps -axo command= > "$tmp/processes" || fail 'Unable to inspect running applications'
  awk -v prefix="$app/Contents/" 'index($0,prefix)>0 { found=1 } END { exit !found }' "$tmp/processes"
}
running && fail 'Agent Workbench is running. Quit it yourself before installing; no task has been stopped.'
mkdir -p "$apps" "$bin"
stage=$(mktemp -d "$apps/.agent-workbench-stage.XXXXXX")
cp -R "$source_app" "$stage/Agent Workbench.app"
# The wrapper is written as data, then atomically moved; apostrophes in user paths remain literal.
quoted_app=$(printf '%s' "$app" | sed "s/'/'\\\\''/g")
{
  printf '%s\n' '#!/bin/sh' '# Agent Workbench launcher' 'set -eu'
  printf "app='%s'\n" "$quoted_app"
  printf '%s\n' 'exec env ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Electron" "$app/Contents/Resources/app/dist/main/cli.js" "$@"'
} > "$stage/workbench"
chmod 755 "$stage/workbench"
{
  printf '%s\n' '#!/bin/sh' '# Agent Workbench dispatch launcher' 'set -eu'
  printf "app='%s'\n" "$quoted_app"
  printf '%s\n' 'exec env ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Electron" "$app/Contents/Resources/app/bin/agent-workbench.mjs" "$@"'
} > "$stage/agent-workbench"
chmod 755 "$stage/agent-workbench"
running && fail 'Agent Workbench started during installation; quit it yourself and retry.'
suffix="$(date +%Y%m%d-%H%M%S)-$$"
if [ -e "$app" ]; then backup_app="$app.backup-$suffix"; mv "$app" "$backup_app"; fi
if [ -e "$command_path" ] || [ -L "$command_path" ]; then
  backup_command="$command_path.backup-$suffix"; mv "$command_path" "$backup_command"
fi
if [ -e "$dispatch_path" ] || [ -L "$dispatch_path" ]; then
  backup_dispatch="$dispatch_path.backup-$suffix"; mv "$dispatch_path" "$backup_dispatch"
fi
mv "$stage/Agent Workbench.app" "$app"
installed=1
mv "$stage/workbench" "$command_path"
installed_command=1
mv "$stage/agent-workbench" "$dispatch_path"
installed_dispatch=1
committed=1
printf 'Installed: %s\nCommand: %s\nDispatch: %s\n' "$app" "$command_path" "$dispatch_path"
[ -z "$backup_app" ] || printf 'Previous app retained: %s\n' "$backup_app"
[ -z "$backup_command" ] || printf 'Previous command retained: %s\n' "$backup_command"
[ -z "$backup_dispatch" ] || printf 'Previous dispatch command retained: %s\n' "$backup_dispatch"
case :$PATH: in *:"$bin":*) ;; *) printf 'For this shell: export PATH="%s:$PATH"\n' "$bin" ;; esac
if [ "$noninteractive" -eq 1 ] || [ ! -t 0 ] || [ ! -t 1 ]; then
  "$command_path" setup --noninteractive
else
  "$command_path" setup
fi
