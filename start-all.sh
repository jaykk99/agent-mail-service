#!/bin/sh
# One command to bring up the whole wired stack on Linux:
#   (a) agent phone server  :8765  (bash start.sh --daemon)
#   (b) agent mail API/SMTP :3000 / :2525  (node server.js)
#   (c) Calling-linux dashboard + SIP/SMTP :3001 / :5060 / :2526
#
#   bash start-all.sh           # start all three in the background
#   bash start-all.sh --status  # check all three health endpoints
#   bash start-all.sh --stop    # stop all three
#
# Ports are the combined plan: Calling-linux runs on :3001 (not :3000) and
# its embedded SMTP on :2526 (not :2525) so it never clashes with the mail
# API/SMTP listener on the same box. The phone server keeps :8765.
# No public numbers, no carrier, no internet mail without DNS/MX + a public
# IP; localhost wiring needs none of that. See RUN_ON_LINUX.md.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

RUN_DIR="$PWD/.run"
LOG_DIR="$PWD/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

CALLING_LINUX_DIR="${CALLING_LINUX_DIR:-$PWD/../Calling-linux}"
MAIL_DOMAIN="${MAIL_DOMAIN:-localhost}"
CALLING_LINUX_URL="${CALLING_LINUX_URL:-http://127.0.0.1:3001}"
AGENT_MAIL_URL="${AGENT_MAIL_URL:-http://127.0.0.1:3000}"

wait_health() {
  url="$1"; tries="${2:-40}"
  i=0
  while [ "$i" -lt "$tries" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 0.25
  done
  return 1
}

start_one() {
  name="$1"; pidfile="$RUN_DIR/$name.pid"; log="$LOG_DIR/$name.log"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidfile"))"
    return 0
  fi
  shift
  # setsid makes the service a process-group leader, so --stop kills the
  # whole tree (npm -> tsx -> node), not just the launcher wrapper.
  setsid nohup "$@" >>"$log" 2>&1 &
  echo "$!" > "$pidfile"
  echo "$name started (pid $(cat "$pidfile"), log $log)"
}

stop_one() {
  name="$1"; pidfile="$RUN_DIR/$name.pid"
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; echo "$name stopped (pid $pid)"; else echo "$name not running"; fi
    rm -f "$pidfile"
  else
    echo "$name not running"
  fi
}

if [ "${1:-}" = "--stop" ]; then
  stop_one calling-linux
  stop_one mail-api
  # The phone server owns its own pid file; ask it to stop cleanly.
  bash start.sh --stop >/dev/null 2>&1 || true
  rm -f "$RUN_DIR/phone.pid"
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  for pair in "phone http://127.0.0.1:8765/health" "mail-api http://127.0.0.1:3000/health" "calling-linux http://127.0.0.1:3001/api/system/capabilities"; do
    set -- $pair
    if curl -fsS --max-time 3 "$2" >/dev/null 2>&1; then echo "$1: up ($2)"; else echo "$1: DOWN ($2)"; fi
  done
  exit 0
fi

# (a) phone server, daemonised by its own launcher (owns server.pid).
if ! curl -fsS --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  PHONE_STATE_DIR="${PHONE_STATE_DIR:-}" bash start.sh --daemon
else
  echo "phone server already running"
fi

# (b) mail API + SMTP listener.
if ! curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null 2>&1; then
  if ! command -v node >/dev/null 2>&1; then echo "node is required for the mail API" >&2; exit 1; fi
  if [ ! -d node_modules ]; then echo "installing mail API dependencies (npm install)..."; npm install --no-audit --no-fund >&2; fi
  start_one mail-api env PORT=3000 SMTP_PORT=2525 MAIL_DOMAIN="$MAIL_DOMAIN" \
    CALLING_LINUX_URL="$CALLING_LINUX_URL" node server.js
  wait_health http://127.0.0.1:3000/health || { echo "mail API did not become healthy; see $LOG_DIR/mail-api.log" >&2; exit 1; }
else
  echo "mail API already running"
fi

# (c) Calling-linux dashboard + embedded SIP/SMTP.
if [ -d "$CALLING_LINUX_DIR" ]; then
  if ! curl -fsS --max-time 2 http://127.0.0.1:3001/api/system/capabilities >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then echo "npm is required for Calling-linux" >&2; exit 1; fi
    if [ ! -d "$CALLING_LINUX_DIR/node_modules" ]; then
      echo "installing Calling-linux dependencies (npm install)..."
      (cd "$CALLING_LINUX_DIR" && npm install --no-audit --no-fund >&2)
    fi
    if [ ! -d "$CALLING_LINUX_DIR/dist" ]; then
      echo "building Calling-linux dashboard (npm run build)..."
      (cd "$CALLING_LINUX_DIR" && npm run build >&2)
    fi
    start_one calling-linux env NODE_ENV=production PORT=3001 SIP_PORT=5060 SMTP_INBOUND_PORT=2526 \
      AGENT_MAIL_URL="$AGENT_MAIL_URL" \
      sh -c "cd '$CALLING_LINUX_DIR' && exec npm run start"
    # tsx cold start can take >10s; give it 30s before declaring failure.
    wait_health http://127.0.0.1:3001/api/system/capabilities 120 || { echo "Calling-linux did not become healthy; see $LOG_DIR/calling-linux.log" >&2; exit 1; }
  else
    echo "Calling-linux already running"
  fi
else
  echo "Calling-linux not found at $CALLING_LINUX_DIR; skipped (phone + mail are up)"
fi

echo "All up:"
echo "  phone dashboard/API : http://127.0.0.1:8765/health"
echo "  mail API / SMTP     : http://127.0.0.1:3000/health  (SMTP :2525)"
echo "  Calling-linux       : http://127.0.0.1:3001  (SIP :5060, SMTP :2526)"
echo "Stop everything: bash start-all.sh --stop"
