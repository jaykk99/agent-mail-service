#!/bin/bash
# backup.sh — timestamped, restorable backup of the mail/phone state.
#
# Run as root:
#   sudo bash linux/backup.sh [output-dir]
#
# Backs up:
#   /var/mail/vhosts            (all Maildirs)
#   /etc/linux-carrier-1000/credentials.json
#   /etc/linux-carrier-1000/carrier-state.json
#   /etc/linux-carrier-1000/env (the secrets file — WITHOUT it a restore
#     cannot log in to AMI or verify webhook HMACs, so it is included)
#   /etc/postfix/main.cf + virtual, /etc/dovecot/dovecot.conf (configs)
#
# The backup file itself contains secrets (env + credential hashes). It is
# written mode 600. Keep it off shared storage; never post it anywhere.
# Restore: unpack as root over the same paths, fix owners (chown -R
# 5000:5000 /var/mail/vhosts), then `postfix reload` and restart dovecot.
set -eu

OUT_DIR="${1:-/var/backups/linux-carrier-1000}"
STATE_DIR="/etc/linux-carrier-1000"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/backup-$STAMP.tar.gz"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo bash linux/backup.sh [output-dir])" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
# Collect only paths that exist; never fail the whole backup on one missing file.
TMP_LIST="$(mktemp)"
{
  [ -d /var/mail/vhosts ] && echo /var/mail/vhosts
  [ -f "$STATE_DIR/credentials.json" ] && echo "$STATE_DIR/credentials.json"
  [ -f "$STATE_DIR/carrier-state.json" ] && echo "$STATE_DIR/carrier-state.json"
  [ -f "$STATE_DIR/env" ] && echo "$STATE_DIR/env"
  [ -f /etc/postfix/main.cf ] && echo /etc/postfix/main.cf
  [ -f /etc/postfix/virtual ] && echo /etc/postfix/virtual
  [ -f /etc/dovecot/dovecot.conf ] && echo /etc/dovecot/dovecot.conf
  [ -f /etc/dovecot/dovecot-users ] && echo /etc/dovecot/dovecot-users
} > "$TMP_LIST" || true

tar -czf "$DEST" -T "$TMP_LIST"
chmod 600 "$DEST"
rm -f "$TMP_LIST"
echo "backup written: $DEST (mode 600, contains secrets — keep private)"
tar -tzf "$DEST"
echo "restore: sudo tar -xzf $DEST -C / && sudo chown -R 5000:5000 /var/mail/vhosts && sudo postfix reload"
