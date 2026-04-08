#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${HOME}/.pi/agent"
EXT_DIR="$BASE_DIR/extensions"
INTERCEPT_DIR="$BASE_DIR/intercepted-commands"
TMPDIR="$(mktemp -d)"
REPO_DIR="$TMPDIR/pi-mono"
PI_MONO_REPO="https://github.com/badlogic/pi-mono.git"
PI_MONO_SPARSE_PATH="packages/coding-agent/examples/extensions"
PI_MONO_REF="${PI_MONO_REF:-main}"
MITSU_REF="${MITSU_REF:-main}"
FORCE=0
INSTALL_MITSU_UV=1
INSTALL_PI_MONO=1

usage() {
  cat <<'EOF'
Usage: install-pi-setup.sh [options]

Installs a non-NPM pi setup into ~/.pi/agent by fetching selected extensions
and helper shims from upstream repositories.

Options:
  --only-uv         Install only the Mitsuhiko uv extension and shims
  --only-pi-mono    Install only selected pi-mono example extensions
  --force           Overwrite existing files without creating .bak backups
  -h, --help        Show this help

Environment:
  PI_MONO_REF       Git ref for badlogic/pi-mono (default: main)
  MITSU_REF         Git ref for mitsuhiko/agent-stuff (default: main)

Examples:
  ~/install-pi-setup.sh
  PI_MONO_REF=<commit> MITSU_REF=<commit> ~/install-pi-setup.sh --force
EOF
}

log() {
  printf '%s\n' "$*"
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command not found: $1" >&2
    exit 1
  fi
}

backup_or_overwrite() {
  local target="$1"
  if [[ -e "$target" && "$FORCE" -ne 1 ]]; then
    local backup="${target}.bak"
    rm -rf "$backup"
    cp -R "$target" "$backup"
    log "Backed up existing $(basename "$target") to $backup"
  fi
}

fetch_file() {
  local url="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"
  backup_or_overwrite "$dest"
  curl -fsSL "$url" -o "$dest"
}

install_mitsu_uv() {
  log "Installing Mitsuhiko uv extension into: $EXT_DIR"
  mkdir -p "$EXT_DIR" "$INTERCEPT_DIR"

  local uv_url="https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/pi-extensions/uv.ts"
  fetch_file "$uv_url" "$EXT_DIR/mitsu-uv.ts"

  log "Fetching intercepted command shims..."
  for cmd in pip pip3 poetry python python3; do
    local shim_url="https://raw.githubusercontent.com/mitsuhiko/agent-stuff/${MITSU_REF}/intercepted-commands/${cmd}"
    fetch_file "$shim_url" "$INTERCEPT_DIR/${cmd}"
    chmod +x "$INTERCEPT_DIR/${cmd}"
  done
}

install_pi_mono_examples() {
  log "Installing pi-mono example extensions into: $EXT_DIR"
  mkdir -p "$EXT_DIR"

  local question_url="https://raw.githubusercontent.com/badlogic/pi-mono/${PI_MONO_REF}/packages/coding-agent/examples/extensions/question.ts"
  local todo_url="https://raw.githubusercontent.com/badlogic/pi-mono/${PI_MONO_REF}/packages/coding-agent/examples/extensions/todo.ts"

  log "Fetching single-file extensions..."
  fetch_file "$question_url" "$EXT_DIR/question.ts"
  fetch_file "$todo_url" "$EXT_DIR/todo.ts"

  log "Fetching multi-file extension: plan-mode/..."
  git clone --depth 1 --branch "$PI_MONO_REF" --filter=blob:none --sparse "$PI_MONO_REPO" "$REPO_DIR" >/dev/null 2>&1 || {
    rm -rf "$REPO_DIR"
    git clone --depth 1 --filter=blob:none --sparse "$PI_MONO_REPO" "$REPO_DIR" >/dev/null 2>&1
    (
      cd "$REPO_DIR"
      git checkout "$PI_MONO_REF" >/dev/null 2>&1
    )
  }

  (
    cd "$REPO_DIR"
    git sparse-checkout set "$PI_MONO_SPARSE_PATH/plan-mode" >/dev/null 2>&1
  )

  if [[ -e "$EXT_DIR/plan-mode" && "$FORCE" -ne 1 ]]; then
    local backup="$EXT_DIR/plan-mode.bak"
    rm -rf "$backup"
    cp -R "$EXT_DIR/plan-mode" "$backup"
    log "Backed up existing plan-mode to $backup"
  fi

  rm -rf "$EXT_DIR/plan-mode"
  cp -R "$REPO_DIR/$PI_MONO_SPARSE_PATH/plan-mode" "$EXT_DIR/plan-mode"
}

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only-uv)
      INSTALL_MITSU_UV=1
      INSTALL_PI_MONO=0
      ;;
    --only-pi-mono)
      INSTALL_MITSU_UV=0
      INSTALL_PI_MONO=1
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

need_cmd curl
if [[ "$INSTALL_PI_MONO" -eq 1 ]]; then
  need_cmd git
fi

log "Installing pi setup into: $BASE_DIR"
log "Refs: pi-mono=${PI_MONO_REF}, agent-stuff=${MITSU_REF}"
log

if [[ "$INSTALL_MITSU_UV" -eq 1 ]]; then
  install_mitsu_uv
  log
fi

if [[ "$INSTALL_PI_MONO" -eq 1 ]]; then
  install_pi_mono_examples
  log
fi

log 'Installed files:'
if [[ -f "$EXT_DIR/mitsu-uv.ts" ]]; then
  printf '  %s\n' "$EXT_DIR/mitsu-uv.ts"
fi
for cmd in pip pip3 poetry python python3; do
  if [[ -f "$INTERCEPT_DIR/$cmd" ]]; then
    printf '  %s\n' "$INTERCEPT_DIR/$cmd"
  fi
done
for path in "$EXT_DIR/question.ts" "$EXT_DIR/todo.ts" "$EXT_DIR/plan-mode"; do
  if [[ -e "$path" ]]; then
    printf '  %s\n' "$path"
  fi
done

cat <<'EOF'

Done.

Next steps:
  1. Start pi
  2. Run /reload

Notes:
  - This is a personal bootstrap script for a non-NPM pi setup.
  - It installs cherry-picked extensions directly into ~/.pi/agent.
  - For fully shareable/reproducible setups, prefer pi packages + settings.json.
EOF
