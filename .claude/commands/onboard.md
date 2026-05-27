---
description: Wire this machine into the shared iCloud Claude setup — symlinks, paths, memory cleanup
---

You are onboarding this machine to Noah's shared Claude setup. The goal: make `~/.claude/commands`, `~/skills`, `~/CLAUDE.md`, and every memory dir resolve to the SAME files across every machine via iCloud symlinks. Execute every step, report what changed.

This command is idempotent — safe to re-run anytime.

## Step 1 — Detect machine

Run `hostname` and `echo $HOME`. Set:
- `PROJECTS_ROOT` = whichever exists: `$HOME/Desktop/Projects`, `$HOME/projects`, `$HOME/Projects`. Stop if none.
- `ICLOUD` = `$HOME/Library/Mobile Documents/com~apple~CloudDocs/claude`

If `$ICLOUD` does not exist, create it and these subdirs: `memory`, `commands`, `skills`.

## Step 2 — Fix config.json

Read `config.json` in the Base project dir. For every entry whose `path` doesn't exist, try swapping its projects-root prefix for `$PROJECTS_ROOT`. Keep entries that now resolve, drop entries that don't. Save.

## Step 3 — Wire iCloud symlinks

For each target below, run this idempotent procedure:
1. Ensure the iCloud destination exists (`mkdir -p`).
2. If the local path is a real directory (not a symlink), `cp -Rn <local>/. <icloud>/` to migrate any local-only files, then `rm -rf <local>`.
3. If the local path is a real file (not a symlink), move it: `mv <local> <icloud>/<basename>` (skip if iCloud already has a copy).
4. Create or replace symlink: `ln -sfn <icloud> <local>` (or for files: `ln -sfn <icloud>/<basename> <local>`).
5. If the symlink already points to the right iCloud target, skip.

**Targets:**

| Local | iCloud |
|---|---|
| `~/.claude/projects/$(echo $HOME \| tr / -)/memory` | `$ICLOUD/memory/_home` |
| `~/.claude/commands` | `$ICLOUD/commands` |
| `~/skills` | `$ICLOUD/skills` |
| `~/CLAUDE.md` (file) | `$ICLOUD/CLAUDE.md` |

**Per-project memory:** for each project in `config.json`, derive `<encoded>` = `$(echo $PROJECTS_ROOT/<projName> | tr / -)` and symlink:
- Local: `~/.claude/projects/<encoded>/memory`
- iCloud: `$ICLOUD/memory/<projName>`

Create the encoded parent dir if missing.

## Step 4 — Clean stale memory

In `$ICLOUD/memory/_home/`:
- Delete `daily_*.md` files older than 30 days.
- Remove their lines from `MEMORY.md`.
- Remove any memory file whose body references absolute paths not present on this machine.

## Step 5 — Verify

- `which claude` — warn if missing.
- `ls -la ~/.claude/commands ~/skills ~/CLAUDE.md` — confirm they're symlinks pointing into iCloud.

## Step 6 — Report

Print:
- Hostname, PROJECTS_ROOT, ICLOUD
- Symlinks created vs already correct vs failed
- config.json: kept vs removed
- Stale memory deleted
- Claude binary status
