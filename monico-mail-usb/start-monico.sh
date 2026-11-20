#!/usr/bin/env bash
set -euo pipefail
: "${MONICO_ADMIN_KEY:?Set MONICO_ADMIN_KEY securely}"
export MONICO_DOMAIN="${MONICO_DOMAIN:-mail.example.invalid}"
export MONICO_DATA="${MONICO_DATA:-/mnt/monico}"
test -d "$MONICO_DATA" || { echo "Mount the USB storage at $MONICO_DATA before starting" >&2; exit 1; }
exec python3 server.py
