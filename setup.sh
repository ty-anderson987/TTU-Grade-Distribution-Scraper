#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  exit 1
fi

npm install
npx playwright install chromium

echo "Setup complete. Run ./start.sh (it launches the server in the background)"
