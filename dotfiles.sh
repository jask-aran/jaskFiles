#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DOTFILES_DIR="$REPO_DIR/dotfiles"

log() { printf '%s\n' "$*"; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

need_cmd rsync

if [[ "${1:-}" == "--deploy" ]]; then
  log "Deploying dotfiles to ~..."

  cp -f "$DOTFILES_DIR/.zshrc"       "$HOME/.zshrc"
  cp -f "$DOTFILES_DIR/.p10k.zsh"    "$HOME/.p10k.zsh"
  cp -f "$DOTFILES_DIR/.ascii_banner" "$HOME/.ascii_banner"

  mkdir -p "$HOME/.oh-my-zsh/custom/plugins"
  rsync -a --delete --exclude='.git' "$DOTFILES_DIR/omz-custom/plugins/zsh-uv-env/" \
    "$HOME/.oh-my-zsh/custom/plugins/zsh-uv-env/"

  if ! command -v lolcat >/dev/null 2>&1; then
    log "Installing lolcat..."
    brew install lolcat
  else
    log "lolcat already installed, skipping."
  fi

  log ""
  log "Done. Restart your shell or run: source ~/.zshrc"
else
  log "Syncing dotfiles to $DOTFILES_DIR..."

  mkdir -p "$DOTFILES_DIR/omz-custom/plugins"

  cp -f "$HOME/.zshrc"        "$DOTFILES_DIR/.zshrc"
  cp -f "$HOME/.p10k.zsh"     "$DOTFILES_DIR/.p10k.zsh"
  cp -f "$HOME/.ascii_banner"  "$DOTFILES_DIR/.ascii_banner"

  rsync -a --delete --exclude='.git' "$HOME/.oh-my-zsh/custom/plugins/zsh-uv-env/" \
    "$DOTFILES_DIR/omz-custom/plugins/zsh-uv-env/"

  log ""
  log "Done. Review changes with:"
  log "  cd $REPO_DIR && git status"
fi
