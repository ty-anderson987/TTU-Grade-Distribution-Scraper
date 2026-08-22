#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer was not found. Run ./setup.sh first."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required. Found $(node --version)."
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
      # Wait briefly for the old listener to release port 3847. Browser cleanup now
      # happens after the listener closes, but polling avoids a restart race on slower
      # machines or older builds.
      i=0
      while [ "$i" -lt 24 ]; do
        if ! curl -fsS --max-time 1 http://127.0.0.1:3847/api/status >/dev/null 2>&1; then break; fi
        sleep 0.25
        i=$((i + 1))
      done
      ;;
  esac
fi

# A stale PID file must never kill an unrelated process after PID reuse. Require both
# a Node server.js command and a confirmed working directory equal to this project.
# If the OS cannot expose process cwd safely, leave the process alone and only remove
# the stale marker; the normal localhost shutdown path above remains the primary path.
if [ -f .server.pid ]; then
  PID="$(cat .server.pid 2>/dev/null || true)"
  case "$PID" in
    ''|*[!0-9]*) ;;
    *)
      ARGS="$(ps -p "$PID" -o args= 2>/dev/null || true)"
      PROC_CWD=""
      if [ -e "/proc/$PID/cwd" ]; then
        PROC_CWD="$(readlink "/proc/$PID/cwd" 2>/dev/null || true)"
      elif command -v lsof >/dev/null 2>&1; then
        PROC_CWD="$(lsof -a -p "$PID" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
      fi
      case "$ARGS" in
        *node*server.js*)
          if [ -n "$PROC_CWD" ] && [ "$(cd "$PROC_CWD" 2>/dev/null && pwd -P || true)" = "$(pwd -P)" ]; then
            kill "$PID" >/dev/null 2>&1 || true
          fi
          ;;
      esac
      ;;
  esac
  rm -f .server.pid
fi

mkdir -p logs
if [ -f logs/server.log ]; then
  SIZE="$(wc -c < logs/server.log 2>/dev/null || echo 0)"
  if [ "$SIZE" -gt 5242880 ]; then
    rm -f logs/server-prev.log
    mv logs/server.log logs/server-prev.log
  fi
fi
nohup node server.js >> logs/server.log 2>&1 &
SERVER_PID=$!
sleep 0.35
if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
  echo "TTU Grade Scraper failed to start. Check logs/server.log."
  exit 1
fi
echo "TTU Grade Scraper started (PID $SERVER_PID). Logs: $(pwd)/logs/server.log"
