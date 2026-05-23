# Base

Local AI command center. Dark dashboard with two terminals, git status, scratchpad, and Claude Code usage stats.

## Requirements

- Node.js 18+
- macOS (node-pty requires native compilation)

## Setup

```bash
cd base
chmod +x start.sh
./start.sh
```

Open `http://localhost:3000` in Chrome (WebSerial isn't needed — use any browser).

## config.json

Generated on first run. Edit it to add projects and set your Obsidian vault path.

```json
{
  "obsidianVaultPath": "/Users/you/your-vault",
  "projects": [
    "/Users/you/projects/repo-one",
    "/Users/you/projects/repo-two"
  ],
  "port": 3000
}
```

- **obsidianVaultPath** — where `scratchpad.md` and `CONTEXT.md` are written
- **projects** — shown in the Git Status project switcher; Terminal 1 opens in `projects[0]`
- **port** — defaults to 3000

Restart the server after editing config.json.

## Accessing from phone via Tailscale

1. Install Tailscale on your Mac and your phone
2. Connect both to the same tailnet
3. Run `./start.sh` — it prints your Tailscale URL automatically
4. Open that URL in your phone's browser

The server binds to `0.0.0.0` so it's reachable on all interfaces including Tailscale.

## Terminals

- **Terminal 1** launches `claude` (falls back to bash if not found)
- **Terminal 2** launches your default shell (`$SHELL`)

Terminals resize automatically with the browser window.

## Scratchpad

Type a note and hit **Save** (or Cmd+Enter). Notes are appended to `scratchpad.md` in your vault with a timestamp — they accumulate rather than overwrite.

**→ Context** appends the note to `CONTEXT.md` in your vault, visible in the Context panel.

## Usage stats

Reads directly from `~/.claude/` — no API key needed:

- `~/.claude/history.jsonl` — recent prompts timeline
- `~/.claude/projects/*/` — session files for token counts and activity
- `~/.claude/stats-cache.json` — aggregate cache (used as fallback)

Hit **↻** in the Usage panel header to refresh.
