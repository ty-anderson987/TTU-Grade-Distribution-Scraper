#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer was not found. Run ./setup.sh first."
  exit 1
fi

if [ ! -d "node_modules/playwright" ]; then
  echo "Dependencies are not installed yet. Run ./setup.sh once first."
  exit 1
fi

# Gracefully stop an existing TTU Grade Scraper session if curl is available.
if command -v curl >/dev/null 2>&1; then
  STATUS="$(curl -fsS --max-time 2 http://127.0.0.1:3847/api/status 2>/dev/null || true)"
  case "$STATUS" in
    *\"loginRequired\"*\"phase\"*|*\"phase\"*\"loginRequired\"*)
      curl -fsS --max-time 2 -X POST http://127.0.0.1:3847/api/shutdown >/dev/null 2>&1 || true
      sleep 1
      ;;
  esac
fi

if [ -f .server.pid ]; then
  PID="$(cat .server.pid 2>/dev/null || true)"
  case "$PID" in
    ''|*[!0-9]*) ;;
    *) kill "$PID" >/dev/null 2>&1 || true ;;
  esac
  rm -f .server.pid
fi

mkdir -p logs
nohup node server.js >> logs/server.log 2>&1 &
