#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Found $(node --version)."
  exit 1
fi

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npx playwright install chromium

echo "Setup complete. Run ./start.sh (it launches the server in the background)"
