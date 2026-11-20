#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

CONFIG_FILE="$HOME/.config/monico-mail/secret.env"
if [[ -f "$CONFIG_FILE" ]]; then
  # Private user-owned config made by configure-mail.sh
  source "$CONFIG_FILE"
fi

: "${MONICO_ADMIN_KEY:?Run bash configure-mail.sh or set MONICO_ADMIN_KEY}"
: "${MONICO_MCP_BEARER_TOKEN:?Run bash configure-mail.sh or set MONICO_MCP_BEARER_TOKEN}"
if [[ "${#MONICO_ADMIN_KEY}" -lt 32 || "${#MONICO_MCP_BEARER_TOKEN}" -lt 32 ]]; then
  echo "Admin and MCP secrets must each be at least 32 characters" >&2
  exit 1
fi
export MONICO_DOMAIN="${MONICO_DOMAIN:-mail.example.invalid}"
export MONICO_DATA="${MONICO_DATA:-/mnt/monico}"
if [[ ! -d "$MONICO_DATA" || ! -w "$MONICO_DATA" ]]; then
  echo "USB storage missing or unwritable: $MONICO_DATA" >&2
  exit 1
fi

if [[ -x ".venv/bin/python" ]]; then
  exec .venv/bin/python server.py
else
  exec python3 server.py
fi
