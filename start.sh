#!/usr/bin/env bash
set -e

# Check Node.js version
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node 18+ from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found $(node -v))" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Build node-pty from source if not done for this Node version.
# The prebuilt binary ships for darwin-arm64 but fails at runtime on Node 24+.
BUILT_FOR_FILE="node_modules/.node-pty-built-for"
if [ ! -f "$BUILT_FOR_FILE" ] || [ "$(cat "$BUILT_FOR_FILE")" != "$(node -v)" ]; then
  echo "Compiling node-pty for $(node -v)..."
  (cd node_modules/node-pty && npx node-gyp rebuild 2>&1) | grep -E "(error|warning|ok|SOLINK)" || true
  node -v > "$BUILT_FOR_FILE"
fi

# Read port from config.json if it exists
PORT=3000
if [ -f config.json ]; then
  PORT=$(node -e "try{const c=require('./config.json');process.stdout.write(String(c.port||3000))}catch{process.stdout.write('3000')}")
fi

echo ""
echo "  Base"
echo "  ────────────────────────────────"
echo "  Local:      http://localhost:$PORT"

# Tailscale URL if available
if command -v tailscale &>/dev/null; then
  TS_IP=$(tailscale ip -4 2>/dev/null || true)
  if [ -n "$TS_IP" ]; then
    echo "  Tailscale:  http://$TS_IP:$PORT"
  fi
fi

echo ""

node server.js
