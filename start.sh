#!/bin/sh
# Single command on Linux: discover USB, start all LOCAL routes and MCP-ready server.
# Keeps running after this terminal closes; no cloud or pip/npm required.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required (usually preinstalled on Chromebook Linux)." >&2
  exit 1
fi
# Opt in to BOTH services: phone/dashboard + separate named-mail MCP.
# This leaves existing phone-only 'bash start.sh' behavior unchanged.
# Public HTTPS for Monico's browser/internal-agent service (explicit opt-in).
# Not a public SMTP/IMAP relay or cellular carrier phone service.
if [ "${1-}" = "--public" ]; then
  shift
  exec python3 linux/public_manage.py "$@"
fi
if [ "${1-}" = "--full" ]; then
  shift
  exec python3 linux/manage.py "$@"
fi
if [ "$#" -eq 0 ]; then
  exec python3 phone/start.py --daemon
fi
exec python3 phone/start.py "$@"
