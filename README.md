# jaskFiles

Personal universal environment and setup files.

## Structure

- `pi/` — pi-specific setup, bootstrap scripts, settings, and customizations
- `skills/` — copied universal `.agents/skills` content intended to be reusable across harnesses
- `dotfiles/` — shell/editor/system dotfiles and related environment config

## Current conventions

### `pi/`
Use this for pi-only setup assets.

Current contents:
- `install-pi-setup.sh` — personal non-NPM bootstrap script for installing selected pi extensions and helper shims into `~/.pi/agent`

### `skills/`
This mirrors the contents of `~/.agents/skills/` when we want those skills versioned here.
These are treated as cross-harness skills rather than pi-specific assets.

### `dotfiles/`
Reserved for portable environment configuration such as shell, git, editor, and other user-level config.

## Sync model

This repo is the canonical source for portable environment/setup files.

Typical flow:
1. Build or update local setup
2. Copy stable reusable pieces into this repo
3. Commit and push
4. Reuse this repo to bootstrap new machines or environments
