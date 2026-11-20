#!/usr/bin/env bash
# Local interactive setup. Never paste secrets into GitHub or chat.
set -eo pipefail
umask 077
cd "$(dirname "$0")"
config_dir="$HOME/.config/monico-mail"
config_file="$config_dir/secret.env"
mkdir -p "$config_dir"
if [[ -f "$config_file" ]]; then
  # User-owned previously generated private configuration.
  source "$config_file"
fi

echo "Monico: USB storage and one real SMTP/IMAP mailbox."
echo "Each agent gets a plus-address routing alias, NOT an independent Gmail account."

if [[ -z "$MONICO_DATA" || ! -d "$MONICO_DATA" ]]; then
  echo "Shared USB volumes:"
  ls -1 /mnt/chromeos/removable/ 2>/dev/null || true
  read -r -p "Enter shared USB drive name exactly as shown: " drive
  if [[ -z "$drive" || "$drive" == *"/"* || "$drive" == "." || "$drive" == ".." ]]; then
    echo "Invalid drive name" >&2
    exit 1
  fi
  MONICO_DATA="/mnt/chromeos/removable/$drive/monico"
fi

case "$MONICO_DATA" in
  /mnt/chromeos/removable/*) ;;
  *) echo "Refusing non-USB path: $MONICO_DATA" >&2; exit 1 ;;
esac
mkdir -p "$MONICO_DATA"
( touch "$MONICO_DATA/.monico-write-test" && rm "$MONICO_DATA/.monico-write-test" ) || {
  echo "USB volume is not writable" >&2
  exit 1
}

python3 - "$MONICO_DATA" <<'PY'
import os, sqlite3, sys, tempfile
fd, path = tempfile.mkstemp(prefix=".monico-sqlite-probe-", suffix=".db", dir=sys.argv[1])
os.close(fd)
try:
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, data TEXT)")
        db.execute("INSERT INTO test(data) VALUES ('works')")
        assert db.execute("SELECT data FROM test").fetchone()[0] == "works"
finally:
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            os.remove(path + suffix)
        except FileNotFoundError:
            pass
PY

if [[ -z "$MONICO_ADMIN_KEY" ]]; then
  MONICO_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
fi
if [[ -z "$MONICO_MCP_BEARER_TOKEN" ]]; then
  MONICO_MCP_BEARER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
fi
if [[ -z "$MONICO_DOMAIN" ]]; then MONICO_DOMAIN="mail.example.invalid"; fi

read -r -p "Your real Gmail/Workspace email address: " address
if [[ -n "$address" ]]; then MONICO_MAIL_ACCOUNT="$address"; fi
if [[ -z "$MONICO_MAIL_ACCOUNT" ]]; then
  echo "Real mailbox address required; no configuration saved" >&2
  exit 1
fi
read -r -s -p "Google app password (not your Google sign-in password): " password
echo
if [[ -n "$password" ]]; then MONICO_MAIL_APP_PASSWORD="$password"; fi
if [[ -z "$MONICO_MAIL_APP_PASSWORD" ]]; then
  echo "App password required; no configuration saved" >&2
  exit 1
fi

{
  printf 'export MONICO_DATA=%q\n' "$MONICO_DATA"
  printf 'export MONICO_DOMAIN=%q\n' "$MONICO_DOMAIN"
  printf 'export MONICO_ADMIN_KEY=%q\n' "$MONICO_ADMIN_KEY"
  printf 'export MONICO_MCP_BEARER_TOKEN=%q\n' "$MONICO_MCP_BEARER_TOKEN"
  printf 'export MONICO_MAIL_ACCOUNT=%q\n' "$MONICO_MAIL_ACCOUNT"
  printf 'export MONICO_MAIL_APP_PASSWORD=%q\n' "$MONICO_MAIL_APP_PASSWORD"
} > "$config_file"
chmod 600 "$config_file"
echo "Private configuration saved at $config_file"
echo "Mailbox database directory: $MONICO_DATA"
echo "Run: bash start-monico.sh"
echo "Real mail service connectivity is not tested by this wizard."
