#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Prefer an explicitly exported domain; otherwise load the private configured domain.
if [[ -z "${MONICO_DOMAIN:-}" && -f "$HOME/.config/monico-mail/domain.env" ]]; then
  source "$HOME/.config/monico-mail/domain.env"
fi
: "${MONICO_ADMIN_KEY:?Set a strong MONICO_ADMIN_KEY locally}"
: "${MONICO_MCP_BEARER_TOKEN:?Set a separate strong MONICO_MCP_BEARER_TOKEN locally}"
if [[ "${#MONICO_ADMIN_KEY}" -lt 32 || "${#MONICO_MCP_BEARER_TOKEN}" -lt 32 ]]; then
  echo "Both operator secrets must be at least 32 characters" >&2
  exit 1
fi
export MONICO_DOMAIN="${MONICO_DOMAIN:-mail.example.invalid}"
export MONICO_DATA="${MONICO_DATA:?Point MONICO_DATA at a shared writable USB directory}"
test -d "$MONICO_DATA" && test -w "$MONICO_DATA" || {
  echo "Configured USB volume is absent or not writable: $MONICO_DATA" >&2
  exit 1
}
if [[ -x ".venv/bin/python" ]]; then
  exec .venv/bin/python server.py
else
  exec python3 server.py
fi
