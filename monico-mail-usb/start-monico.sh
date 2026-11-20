#!/usr/bin/env bash
set -euo pipefail
: "${MONICO_ADMIN_KEY:?Set MONICO_ADMIN_KEY securely}"
: "${MONICO_DOMAIN:=mail.example.invalid}"
: "${MONICO_STORAGE:=/mnt/monico}"
mkdir -p "$MONICO_STORAGE"
exec python3 server.py
