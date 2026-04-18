# jaskFiles

Personal universal environment and setup files.

## Structure

- `pi/` — pi-specific setup backups, especially settings and curated extensions
- `skills/` — backed-up agent skills plus metadata about which ones are remotely managed
- `dotfiles/` — shell/editor/system dotfiles and related environment config

## Current conventions

### `pi/`
Use this for pi-only setup assets.

Current contents:
- `settings.json` — backed-up global Pi settings
- `extensions/` — backed-up curated local extensions from `~/.pi/agent/extensions`
- `sync-pi-agent.sh` (repo root) — syncs the important Pi agent state into this repo

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
2. Run `./sync-pi-agent.sh` for Pi config/extensions
3. Run `./sync-skills.sh` for skills and skill-source metadata
4. Commit and push
5. Reuse this repo to bootstrap new machines or environments

## Reinstallation guidance

When restoring on a new machine, prefer having an agent inspect this repo and decide what should be restored directly versus reinstalled from source.

Recommended strategy:
- For `pi/`:
  - copy `pi/settings.json` back to `~/.pi/agent/settings.json`
  - copy `pi/extensions/` back to `~/.pi/agent/extensions/`
  - let Pi reinstall any package-based dependencies referenced in `settings.json` (for example npm-installed Pi packages) rather than trying to vendor them here
- For `skills/`:
  - inspect `skills/.skill-lock.json` and `skills/skill-sources.json`
  - if a skill has a recorded remote source, prefer reinstalling it from that source via the skills CLI/tooling
  - use the backed-up skill folder as a fallback if the remote source is unavailable, stale, or intentionally avoided
  - if a skill is not present in `.skill-lock.json`, treat it as local/manual and restore it by copying from this repo

In other words:
- package-managed Pi dependencies should generally be reinstalled from their recorded package references
- remotely managed skills should generally be reinstalled from their recorded upstream sources
- curated local Pi extensions and local/manual skills should be restored from the backup copy in this repo

This keeps the repo small and understandable while still preserving enough state for an agent to reconstruct the environment reliably.
