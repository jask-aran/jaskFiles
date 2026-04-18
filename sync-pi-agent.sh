#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_AGENT_SRC="$HOME/.pi/agent"
PI_SETTINGS_SRC="$PI_AGENT_SRC/settings.json"
PI_EXTENSIONS_SRC="$PI_AGENT_SRC/extensions"
PI_DEST_DIR="$REPO_DIR/pi"
PI_SETTINGS_DEST="$PI_DEST_DIR/settings.json"
PI_EXTENSIONS_DEST="$PI_DEST_DIR/extensions"

log() {
  printf '%s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

need_cmd rsync
mkdir -p "$PI_DEST_DIR" "$REPO_DIR/dotfiles"

if [[ -f "$PI_SETTINGS_SRC" ]]; then
  cp -f "$PI_SETTINGS_SRC" "$PI_SETTINGS_DEST"
  log "Synced: $PI_SETTINGS_DEST"
else
  log "Skipped missing file: $PI_SETTINGS_SRC"
fi

if [[ -d "$PI_EXTENSIONS_SRC" ]]; then
  mkdir -p "$PI_EXTENSIONS_DEST"
  rsync -a --delete \
    --exclude 'node_modules/' \
    --exclude 'package-lock.json' \
    --exclude '.package-lock.json' \
    "$PI_EXTENSIONS_SRC/" "$PI_EXTENSIONS_DEST/"
  log "Synced: $PI_EXTENSIONS_DEST/"
else
  log "Skipped missing directory: $PI_EXTENSIONS_SRC"
fi

log
log "Backed up Pi state from: $PI_AGENT_SRC"
log "- settings.json preserves package/npm-installed extension references"
log "- extensions/ preserves the curated local extension layer"
log
log "Done. Review changes with:"
log "  cd $REPO_DIR && git status"
