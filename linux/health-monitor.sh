#!/bin/bash
# health-monitor.sh — check the stack, restart it if anything is down.
#
# Designed for cron (every 5 minutes):
#   */5 * * * * /path/to/agent-mail-service/linux/health-monitor.sh >> /var/log/linux-carrier-1000/health.log 2>&1
#
# Checks:
#   phone dashboard   http://127.0.0.1:8765/health
#   mail API          http://127.0.0.1:3000/health
#   Calling-linux     http://127.0.0.1:3001/api/system/capabilities
#   SIP listener      UDP :5060 bound (ss) — the CL embedded SIP socket
#   Postfix/Dovecot   TCP :25 and :993 bound (ss) — the system mail path
#
# If any check fails it runs `bash start-all.sh --stop` + `bash start-all.sh`
# once, re-checks, and logs the outcome. It never touches the maildirs,
# credentials, or secrets. SIP calls themselves cannot be probed from here
# (a real OPTIONS probe needs phone/sip_probe.py against a live Asterisk);
# the listener check only proves the socket is bound.
set -u
cd "$(dirname "$0")/.."
LOG="${HEALTH_LOG:-/var/log/linux-carrier-1000/health.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || LOG="$PWD/logs/health.log"
mkdir -p "$(dirname "$LOG")"

fail=0
check_http() {
  if curl -fsS --max-time 3 "$2" >/dev/null 2>&1; then
    echo "$(date -Is) $1: up"
  else
    echo "$(date -Is) $1: DOWN ($2)"
    fail=1
  fi
}
check_listen() {
  if ss -ltn 2>/dev/null | grep -q ":$2 " || ss -lun 2>/dev/null | grep -q ":$2 "; then
    echo "$(date -Is) $1: listening (:$2)"
  else
    echo "$(date -Is) $1: NOT LISTENING (:$2)"
    fail=1
  fi
}

{
  check_http phone http://127.0.0.1:8765/health
  check_http mail-api http://127.0.0.1:3000/health
  check_http calling-linux http://127.0.0.1:3001/api/system/capabilities
  check_listen sip-5060-udp 5060
  check_listen postfix-25 25
  check_listen dovecot-993 993
} | tee -a "$LOG"

if [ "$fail" -eq 1 ]; then
  echo "$(date -Is) one or more checks failed; restarting via start-all.sh" | tee -a "$LOG"
  bash start-all.sh --stop >>"$LOG" 2>&1 || true
  sleep 2
  CALLING_LINUX_DIR="${CALLING_LINUX_DIR:-$PWD/../Calling-linux}" bash start-all.sh >>"$LOG" 2>&1 || true
  sleep 2
  bash start-all.sh --status | tee -a "$LOG"
  echo "$(date -Is) restart attempted; see status above" | tee -a "$LOG"
fi
exit 0
