#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC_DIR="$HOME/.agents/skills"
SKILL_LOCK_SRC="$HOME/.agents/.skill-lock.json"
SKILLS_DEST_DIR="$REPO_DIR/skills"
SKILL_LOCK_DEST="$SKILLS_DEST_DIR/.skill-lock.json"
SKILL_SOURCES_DEST="$SKILLS_DEST_DIR/skill-sources.json"

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
need_cmd python3
mkdir -p "$SKILLS_DEST_DIR"

if [[ -d "$SKILLS_SRC_DIR" ]]; then
  rsync -a --delete \
    --exclude '.skill-lock.json' \
    --exclude 'skill-sources.json' \
    "$SKILLS_SRC_DIR/" "$SKILLS_DEST_DIR/"
  log "Synced: $SKILLS_DEST_DIR/"
else
  log "Skipped missing directory: $SKILLS_SRC_DIR"
fi

if [[ -f "$SKILL_LOCK_SRC" ]]; then
  cp -f "$SKILL_LOCK_SRC" "$SKILL_LOCK_DEST"
  log "Synced: $SKILL_LOCK_DEST"
else
  log "Skipped missing file: $SKILL_LOCK_SRC"
fi

python3 - <<'PY'
import json
import os
from pathlib import Path

repo_dir = Path(os.path.expanduser('~/jaskFiles'))
skills_dir = repo_dir / 'skills'
lock_path = skills_dir / '.skill-lock.json'
out_path = skills_dir / 'skill-sources.json'

skills_on_disk = sorted([p.name for p in skills_dir.iterdir() if p.is_dir()]) if skills_dir.exists() else []
lock_data = {}
if lock_path.exists():
    try:
        lock_data = json.loads(lock_path.read_text())
    except Exception:
        lock_data = {}

locked = lock_data.get('skills', {}) if isinstance(lock_data, dict) else {}
summary = {
    'generatedFrom': str(lock_path) if lock_path.exists() else None,
    'remoteManagedSkills': [],
    'localOnlySkills': [],
}

locked_names = set(locked.keys())
for name in sorted(locked_names):
    entry = locked.get(name, {})
    summary['remoteManagedSkills'].append({
        'name': name,
        'source': entry.get('source'),
        'sourceType': entry.get('sourceType'),
        'sourceUrl': entry.get('sourceUrl'),
        'skillPath': entry.get('skillPath'),
        'installedAt': entry.get('installedAt'),
        'updatedAt': entry.get('updatedAt'),
        'presentInBackup': name in skills_on_disk,
    })

for name in skills_on_disk:
    if name not in locked_names:
        summary['localOnlySkills'].append({
            'name': name,
            'note': 'Not present in .skill-lock.json; likely local/manual/copied skill. Keep backup copy.'
        })

out_path.write_text(json.dumps(summary, indent=2) + '\n')

print(f"Generated: {out_path}")
print(f"Remote-managed skills: {len(summary['remoteManagedSkills'])}")
print(f"Local-only skills: {len(summary['localOnlySkills'])}")
PY

log
log "Skill backup notes:"
log "- .skill-lock.json identifies skills installed/managed via the skills CLI"
log "- skill-sources.json records which skills can likely be reinstalled from remote sources"
log "- backed-up skill folders remain as a fallback in case remote sources disappear or change"
log
log "Done. Review changes with:"
log "  cd $REPO_DIR && git status"
