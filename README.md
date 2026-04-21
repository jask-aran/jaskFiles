# jaskFiles

Personal universal environment and setup files.

## Structure

- `.pi/` — primary backup of the local Pi home directory from `~/.pi/`
- `pi/` — older curated Pi snapshot format, kept around for compatibility/reference
- `skills/` — backed-up agent skills plus metadata about which ones are remotely managed
- `dotfiles/` — shell/editor/system dotfiles and related environment config

## Current conventions

### `.pi/`
This is now the main Pi backup in this repo. It is a copy of the local `~/.pi/` tree.

The repo intentionally ignores some machine-local or sensitive runtime state:
- `.pi/agent/auth.json`
- `.pi/agent/sessions/`
- `.pi/logs/`

Everything else under `.pi/` is treated as restorable Pi state unless a later cleanup narrows that scope.

### `pi/`
This is the old Pi backup layout. It was designed as a smaller curated snapshot rather than a full `.pi` copy.

Current contents:
- `settings.json` — backed-up global Pi settings
- `extensions/` — backed-up curated local extensions from `~/.pi/agent/extensions`

This directory is being kept around for now because it reflects the older backup model and may still be useful for comparison, migration, or selective restore.

### `sync-pi-agent.sh`
This script also belongs to the old model. It copies only selected state from `~/.pi/agent` into `./pi/`:
- `settings.json`
- `extensions/`

It does **not** produce the new primary `.pi/` backup. It is being kept around as a legacy helper until the repo is cleaned up or a new sync script replaces it.

### `skills/`
This stores a backup of `~/.agents/skills/`, plus metadata from `~/.agents/.skill-lock.json`.
That lock file lets us distinguish skills managed by the `npx skills` ecosystem from purely local/manual skills.

Current conventions:
- prefer reinstalling remotely managed skills from their recorded sources when rebuilding on a new machine
- keep the backed-up skill folders as a fallback in case remote sources drift or disappear
- treat skills not present in `.skill-lock.json` as local/manual and preserve them directly

### `dotfiles/`
Reserved for portable environment configuration such as shell, git, editor, and other user-level config.

## Sync model

This repo is the canonical source for portable environment/setup files.

Typical flow:
1. Build or update local setup
2. Copy `~/.pi/` into `./.pi/`
3. Run `./sync-skills.sh` for skills and skill-source metadata
4. Commit and push
5. Reuse this repo to bootstrap new machines or environments

`./sync-pi-agent.sh` remains available only for the older `./pi/` snapshot workflow.

## Reinstallation guidance

When restoring on a new machine, prefer having an agent inspect this repo and decide what should be restored directly versus reinstalled from source.

Recommended strategy:
- For `.pi/`:
  - copy `.pi/` back into `~/.pi/`
  - do **not** restore ignored secrets/runtime state from git; recreate authentication locally and allow sessions/logs to regenerate
- For `pi/`:
  - treat it as legacy backup material, mainly useful for reference or selective manual restore
- For `skills/`:
  - inspect `skills/.skill-lock.json` and `skills/skill-sources.json`
  - if a skill has a recorded remote source, prefer reinstalling it from that source via the skills CLI/tooling
  - use the backed-up skill folder as a fallback if the remote source is unavailable, stale, or intentionally avoided
  - if a skill is not present in `.skill-lock.json`, treat it as local/manual and restore it by copying from this repo

In other words:
- `.pi/` is now the main Pi backup surface
- `pi/` and `sync-pi-agent.sh` are legacy artifacts from the previous curated backup approach
- remotely managed skills should generally be reinstalled from their recorded upstream sources
- local/manual skills should be restorable from this repo

This keeps the current backup model explicit while preserving the older one until it is no longer useful.
