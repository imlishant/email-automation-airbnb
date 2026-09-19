#!/usr/bin/env bash
# Start the dev server from the right place, every time.
#
# The app is ES modules importing ../../shared/rules.js, so it has to be served
# from the repo root — not from frontend/, and not opened as a file://. This
# script removes the chance of getting that wrong.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-5173}"

if [ "${1:-}" = "stop" ]; then
  pkill -f "http.server 5173" 2>/dev/null && echo "stopped" || echo "nothing running"
  exit 0
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop it with:  ./dev.sh stop"
  echo "Or pick another:                             ./dev.sh 5174"
  exit 1
fi

echo "GatePass dev server"
echo "  app     http://localhost:$PORT/"
echo "  checks  http://localhost:$PORT/frontend/test.html"
echo "  root    $(pwd)"
echo "  (ctrl-c to stop)"
echo
exec python3 -m http.server "$PORT"
