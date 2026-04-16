#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC="$HOME/.agents/skills"
SKILLS_DEST="$REPO_DIR/skills"
PI_SCRIPT_SRC="$HOME/install-pi-setup.sh"
PI_SCRIPT_DEST="$REPO_DIR/pi/install-pi-setup.sh"
PI_SETTINGS_SRC="$HOME/.pi/agent/settings.json"
PI_SETTINGS_DEST="$REPO_DIR/pi/settings.json"

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
mkdir -p "$REPO_DIR/pi" "$REPO_DIR/skills" "$REPO_DIR/dotfiles"

if [[ -f "$PI_SCRIPT_SRC" ]]; then
  cp -f "$PI_SCRIPT_SRC" "$PI_SCRIPT_DEST"
  chmod +x "$PI_SCRIPT_DEST"
  log "Synced: $PI_SCRIPT_DEST"
else
  log "Skipped missing file: $PI_SCRIPT_SRC"
fi

if [[ -f "$PI_SETTINGS_SRC" ]]; then
  cp -f "$PI_SETTINGS_SRC" "$PI_SETTINGS_DEST"
  log "Synced: $PI_SETTINGS_DEST"
else
  log "Skipped missing file: $PI_SETTINGS_SRC"
fi

if [[ -d "$SKILLS_SRC" ]]; then
  rsync -a --delete "$SKILLS_SRC/" "$SKILLS_DEST/"
  log "Synced: $SKILLS_DEST/"
else
  log "Skipped missing directory: $SKILLS_SRC"
fi

log
log "Done. Review changes with:"
log "  cd $REPO_DIR && git status"
