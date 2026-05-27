#!/usr/bin/env bash
# Base bootstrap — sets up a fresh Mac to share Noah's Claude setup via iCloud.
# Idempotent: safe to re-run.

set -euo pipefail

say() { printf '\n\033[36m[base]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[33m[base]\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m[base]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Detect machine ────────────────────────────────────────────────────────
say "Detecting machine"
HOST="$(hostname)"
echo "  hostname: $HOST"
echo "  home:     $HOME"

PROJECTS_ROOT=""
for p in "$HOME/Desktop/Projects" "$HOME/projects" "$HOME/Projects"; do
  if [ -d "$p" ]; then PROJECTS_ROOT="$p"; break; fi
done
if [ -z "$PROJECTS_ROOT" ]; then
  PROJECTS_ROOT="$HOME/projects"
  mkdir -p "$PROJECTS_ROOT"
  say "Created $PROJECTS_ROOT (no existing projects root found)"
fi
echo "  projects: $PROJECTS_ROOT"

ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs/claude"
echo "  icloud:   $ICLOUD"
mkdir -p "$ICLOUD/memory" "$ICLOUD/commands" "$ICLOUD/skills"

# ── 2. Install claude CLI if missing ─────────────────────────────────────────
if ! command -v claude >/dev/null 2>&1; then
  warn "claude CLI not found. Install from https://claude.com/claude-code then re-run."
  die "Install claude and re-run bootstrap.sh"
fi
say "claude CLI: $(which claude)"

# ── 3. Clone or update Base ──────────────────────────────────────────────────
BASE_DIR="$PROJECTS_ROOT/base"
if [ ! -d "$BASE_DIR/.git" ]; then
  if [ -n "${BASE_REPO:-}" ]; then
    say "Cloning Base into $BASE_DIR"
    git clone "$BASE_REPO" "$BASE_DIR"
  else
    warn "BASE_DIR doesn't exist and BASE_REPO env var not set."
    warn "Either:  BASE_REPO=<url> bash bootstrap.sh  -- or clone manually first."
    die "Cannot proceed without Base source"
  fi
else
  say "Base already cloned at $BASE_DIR"
fi

cd "$BASE_DIR"
say "Installing npm deps"
npm install --silent

# ── 4. Wire iCloud symlinks ──────────────────────────────────────────────────

# Symlink a directory: migrate local content into iCloud, replace with symlink.
link_dir() {
  local local_path="$1"
  local icloud_path="$2"
  mkdir -p "$icloud_path"
  # Already correctly symlinked?
  if [ -L "$local_path" ] && [ "$(readlink "$local_path")" = "$icloud_path" ]; then
    echo "  ok:    $local_path"
    return
  fi
  # Real dir? migrate then remove.
  if [ -d "$local_path" ] && [ ! -L "$local_path" ]; then
    cp -Rn "$local_path/." "$icloud_path/" 2>/dev/null || true
    rm -rf "$local_path"
  fi
  # Stale symlink?
  if [ -L "$local_path" ]; then rm "$local_path"; fi
  mkdir -p "$(dirname "$local_path")"
  ln -sfn "$icloud_path" "$local_path"
  echo "  link:  $local_path -> $icloud_path"
}

# Symlink a single file.
link_file() {
  local local_path="$1"
  local icloud_path="$2"
  if [ -L "$local_path" ] && [ "$(readlink "$local_path")" = "$icloud_path" ]; then
    echo "  ok:    $local_path"
    return
  fi
  if [ -f "$local_path" ] && [ ! -L "$local_path" ]; then
    if [ ! -f "$icloud_path" ]; then mv "$local_path" "$icloud_path"
    else rm "$local_path"; fi
  fi
  if [ -L "$local_path" ]; then rm "$local_path"; fi
  mkdir -p "$(dirname "$local_path")"
  if [ -f "$icloud_path" ]; then
    ln -sfn "$icloud_path" "$local_path"
    echo "  link:  $local_path -> $icloud_path"
  else
    echo "  skip:  $icloud_path missing"
  fi
}

# Encode an absolute path the way Claude Code does (slashes -> dashes)
encode_path() { echo "$1" | tr / -; }

HOME_ENCODED="$(encode_path "$HOME")"

say "Wiring iCloud symlinks"
link_dir "$HOME/.claude/projects/$HOME_ENCODED/memory" "$ICLOUD/memory/_home"
link_dir "$HOME/.claude/commands"                       "$ICLOUD/commands"
link_dir "$HOME/skills"                                 "$ICLOUD/skills"
link_file "$HOME/CLAUDE.md"                             "$ICLOUD/CLAUDE.md"

# Per-project memory dirs (from config.json)
if [ -f "$BASE_DIR/config.json" ]; then
  say "Wiring per-project memory"
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$BASE_DIR/config.json', 'utf8'));
    for (const p of (cfg.projects || [])) {
      if (!p.path) continue;
      const name = p.name || p.path.split('/').filter(Boolean).pop();
      console.log(name + '|' + p.path);
    }
  " | while IFS='|' read -r projName projPath; do
    [ -z "$projName" ] && continue
    # Rewrite path to this machine's PROJECTS_ROOT
    fixed_path="$PROJECTS_ROOT/$projName"
    encoded="$(encode_path "$fixed_path")"
    link_dir "$HOME/.claude/projects/$encoded/memory" "$ICLOUD/memory/$projName"
  done
fi

# ── 5. Report ────────────────────────────────────────────────────────────────
say "Done. Run /onboard from inside Claude later to re-verify or clean stale memory."
echo "  Base dir: $BASE_DIR"
echo "  Start with: cd $BASE_DIR && npm start"
