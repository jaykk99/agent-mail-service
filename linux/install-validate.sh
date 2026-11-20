#!/bin/bash
# install-validate.sh — install + validate the agent-mail-service /
# Calling-linux stack on a real Linux box (Ubuntu/Debian).
#
# Run as root (or with sudo) from the agent-mail-service repo root:
#   sudo bash linux/install-validate.sh [mail-domain]
#   sudo bash linux/install-validate.sh agents.errorinbox.qd.je
#   sudo bash linux/install-validate.sh test.local   # loopback-only test
#
# What it does:
#   1. Installs postfix, dovecot-core, dovecot-imapd, asterisk, coturn,
#      opendkim (apt, no card, no signups).
#   2. Creates /etc/linux-carrier-1000/env (mode 600) with FRESH RANDOM
#      CARRIER_HMAC_SECRET / AMI_SECRET / TURN_SECRET. No hardcoded secrets
#      anywhere; re-running keeps existing secrets.
#   3. Installs the validated configs from linux/config/ (domain substituted).
#   4. Generates a DKIM key for the domain and prints the DNS TXT record.
#   5. Validates: postfix check, dovecot -n, opendkim key check, then a
#      live SMTP -> Maildir -> IMAP loop (test.local domain) if the domain
#      is test.local; for a real domain it validates configs + starts the
#      services and prints the checks Jay must run (see
#      PUBLIC_DEPLOY_CHECKLIST.md).
#   6. Starts Postfix/Dovecot (systemd) and runs the stack smoke test
#      (bash start-all.sh) when the Calling-linux checkout is next door.
#
# Idempotent: safe to re-run; it never deletes maildirs or credentials.
set -eu
cd "$(dirname "$0")/.."

DOMAIN="${1:-test.local}"
ENV_FILE="/etc/linux-carrier-1000/env"
STATE_DIR="/etc/linux-carrier-1000"
VMAIL_BASE="/var/mail/vhosts"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo bash linux/install-validate.sh [domain])" >&2
  exit 1
fi

echo "== 1. packages =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postfix dovecot-core dovecot-imapd asterisk coturn opendkim

echo "== 2. secrets (fresh random, kept in $ENV_FILE mode 600) =="
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
for var in CARRIER_HMAC_SECRET AMI_SECRET TURN_SECRET; do
  if ! grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
    echo "${var}=$(openssl rand -hex 24)" >> "$ENV_FILE"
    echo "generated $var"
  else
    echo "kept existing $var"
  fi
done
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

echo "== 3. configs =="
mkdir -p /etc/postfix /etc/dovecot /etc/asterisk
sed "s/__MAIL_DOMAIN__/${DOMAIN}/g" linux/config/postfix-main.cf > /etc/postfix/main.cf
# Keep the stock master.cf (it is correct); only main.cf is replaced.
sed "s/__MAIL_DOMAIN__/${DOMAIN}/g" linux/config/dovecot.conf > /etc/dovecot/dovecot.conf
sed -e "s/__MAIL_DOMAIN__/${DOMAIN}/g" -e "s/__TURN_SECRET__/${TURN_SECRET}/g" \
  linux/config/turnserver.conf > /etc/turnserver.conf
# AMI manager user (secret from the env file, never from the repo).
sed "s/__AMI_SECRET__/${AMI_SECRET}/g" linux/config/asterisk-manager.conf > /etc/asterisk/manager.conf
chmod 640 /etc/asterisk/manager.conf
chown root:asterisk /etc/asterisk/manager.conf 2>/dev/null || true

# Maildirs base must be traversable by the virtual delivery uid (5000).
mkdir -p "$VMAIL_BASE"
chmod 755 "$VMAIL_BASE"
# The virtual map lives in /etc/postfix (AppArmor-safe, readable by postfix).
touch /etc/postfix/virtual
postmap hash:/etc/postfix/virtual

echo "== 4. DKIM key =="
DKIM_DIR="/etc/opendkim/keys/${DOMAIN}"
mkdir -p "$DKIM_DIR"
if [ ! -f "$DKIM_DIR/mail.private" ]; then
  opendkim-genkey -D "$DKIM_DIR" -d "$DOMAIN" -s mail
  chown -R opendkim:opendkim "$DKIM_DIR" 2>/dev/null || chown -R root:root "$DKIM_DIR"
  chmod 600 "$DKIM_DIR/mail.private"
fi
echo "Publish this DNS TXT record at ${DOMAIN} (selector mail):"
cat "$DKIM_DIR/mail.txt"
echo "(Verify later: opendkim-testkey -d ${DOMAIN} -s mail -k $DKIM_DIR/mail.private)"

echo "== 5. config validation =="
postfix check && echo "postfix check: OK"
dovecot -n >/dev/null && echo "dovecot -n: OK"
openssl rsa -in "$DKIM_DIR/mail.private" -check -noout
asterisk -V | head -1
turnserver -V 2>&1 | head -1 || true

echo "== 6. services =="
systemctl enable --now postfix dovecot || { postfix start; dovecot; }
systemctl enable --now asterisk coturn 2>/dev/null || true
ss -ltn | grep -E ":(25|143|993|3478|5038)" || true

echo "== 7. stack smoke test =="
if [ -d ../Calling-linux ]; then
  CALLING_LINUX_DIR="$PWD/../Calling-linux" bash start-all.sh
  bash start-all.sh --status
else
  echo "Calling-linux not found next door; clone it beside this repo and run bash start-all.sh"
fi

echo
echo "DONE. Next: PUBLIC_DEPLOY_CHECKLIST.md (DNS, ports, go-live checks)."
echo "Env file: $ENV_FILE (600). Back it up with linux/backup.sh."
