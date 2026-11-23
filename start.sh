#!/bin/sh
# Single plug-and-play command on Linux:
# Starts the self-hosted 1,000-email & 1,000-phone-extension server on port 3000
# and built-in SMTP listener on port 2525 with ZERO API keys or required domains.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if [ "${1-}" = "--public" ]; then
  shift
  exec python3 linux/public_manage.py "$@"
fi
if [ "${1-}" = "--full" ]; then
  shift
  exec python3 linux/manage.py "$@"
fi
if [ "${1-}" = "--python" ]; then
  shift
  exec python3 phone/start.py "$@"
fi

if [ "$#" -eq 0 ] && command -v node >/dev/null 2>&1; then
  if [ ! -d node_modules ]; then
    if ! command -v npm >/dev/null 2>&1; then
      echo "Node dependencies are missing and npm is not installed. Install npm, then rerun ./start.sh." >&2
      exit 1
    fi
    echo "Installing locked Node dependencies once..."
    npm ci --no-audit --no-fund
  fi
  echo "Starting plug-and-play 1,000-agent Mail & Phone server on http://0.0.0.0:3000 (SMTP :2525)..."
  exec node server.js
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Node.js or Python 3 is required." >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  exec python3 phone/start.py --daemon
fi
exec python3 phone/start.py "$@"
