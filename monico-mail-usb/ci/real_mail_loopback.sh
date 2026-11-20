#!/usr/bin/env bash
# Real Postfix SMTP submission -> Dovecot LMTP -> IMAPS test on a disposable
# Ubuntu CI runner. Does not contact a public mailbox or prove Internet delivery.
set -euo pipefail
[[ "$(id -u)" == "0" ]] || { echo "CI integration requires disposable root runner" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MAIL="$ROOT/monico-mail-usb"
DOMAIN="monico-ci.lab.example.net"
HOST="mail.$DOMAIN"
DATA="/var/lib/monico-ci"
CERT="/etc/ssl/monico-ci/server.crt"
KEY="/etc/ssl/monico-ci/server.key"

echo "Postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "Postfix postfix/mailname string $HOST" | debconf-set-selections
apt-get update -qq
apt-get install -y -qq postfix postfix-sqlite dovecot-core dovecot-imapd \
  dovecot-lmtpd dovecot-sqlite openssl ca-certificates acl
id vmail >/dev/null 2>&1 || useradd --system --user-group \
  --home-dir "$DATA/maildirs" --shell /usr/sbin/nologin vmail
mkdir -p "$DATA/maildirs" /etc/ssl/monico-ci
chmod 0750 "$DATA"
chown vmail:vmail "$DATA/maildirs"
chmod 0750 "$DATA/maildirs"
# The disposable DNS name resolves only on this test runner.
printf '127.0.0.1 %s\n' "$HOST" >> /etc/hosts
openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days 2 \
  -subj "/CN=$HOST" -addext "subjectAltName=DNS:$HOST" \
  -keyout "$KEY" -out "$CERT" >/dev/null 2>&1
chmod 0600 "$KEY"
cp "$CERT" /usr/local/share/ca-certificates/monico-ci.crt
update-ca-certificates >/dev/null

# Use real application-generated credentials and the same production templates.
export MONICO_CI_DOMAIN="$DOMAIN" MONICO_CI_DATA="$DATA"
export MONICO_CI_CERT="$CERT" MONICO_CI_KEY="$KEY"
export MONICO_CI_VMAIL_UID="$(id -u vmail)"
export MONICO_CI_VMAIL_GID="$(id -g vmail)"
cd "$MAIL"
python3 - <<'PY'
from pathlib import Path
import os
from monico_core import Registry
from selfhost.generate_config import render

data = Path(os.environ["MONICO_CI_DATA"])
domain = os.environ["MONICO_CI_DOMAIN"]
reg = Registry(data, domain)
account = reg.register("agent_ci_001", "local-delivery")
assert account["mail_password"] and account["email"] == f"local-delivery@{domain}"
secret_file = data / "ci-secret"
secret_file.write_text(account["mail_password"], encoding="utf-8")
secret_file.chmod(0o600)
files = render(domain, str(data / "agents.sqlite3"),
               str(data / "maildirs"), int(os.environ["MONICO_CI_VMAIL_UID"]),
               int(os.environ["MONICO_CI_VMAIL_GID"]),
               os.environ["MONICO_CI_CERT"], os.environ["MONICO_CI_KEY"], "8.8.8.8")
folder = Path("/etc/postfix")
(folder / "main.cf").write_text(files["postfix-main.cf"])
(folder / "sqlite-virtual-mailboxes.cf").write_text(files["postfix-sqlite-virtual-mailboxes.cf"])
(folder / "sqlite-sender-login.cf").write_text(files["postfix-sqlite-sender-login.cf"])
with (folder / "master.cf").open("a") as stream:
    stream.write("\n" + files["postfix-master-submission.cf"] + "\n")
Path("/etc/dovecot/conf.d/99-monico-ci.conf").write_text(files["dovecot-2.3-extra.conf"])
Path("/etc/dovecot/dovecot-sql.conf.ext").write_text(files["dovecot-sql.conf.ext"])
print("Application registered one unique mailbox; real Postfix/Dovecot templates installed on CI runner")
PY

# Only these two service identities may read the credential-hash SQLite DB.
setfacl -m "u:postfix:rx,u:dovecot:rx,u:vmail:rx" "$DATA"
setfacl -m "u:postfix:r,u:dovecot:r" "$DATA/agents.sqlite3"
chmod 0600 "$DATA/ci-secret"
chmod 0644 /etc/postfix/sqlite-virtual-mailboxes.cf /etc/postfix/sqlite-sender-login.cf
chmod 0644 /etc/dovecot/dovecot-sql.conf.ext
echo "Mail transport config validation:"
postfix check
doveconf -n | head -100
echo "Check generated Postfix sender mapping authorization:"
postconf -h proxy_read_maps | grep -Fq "proxy:sqlite:/etc/postfix/sqlite-sender-login.cf"
echo "Check actual Postfix SQLite recipient lookup:"
test "$(postmap -q "local-delivery@$DOMAIN" sqlite:/etc/postfix/sqlite-virtual-mailboxes.cf)" = "local-delivery@$DOMAIN"
echo "Check real Dovecot authentication:"
dovecot stop >/dev/null 2>&1 || true
dovecot
doveadm auth test "local-delivery@$DOMAIN" "$(cat "$DATA/ci-secret")" | grep -qi 'auth succeeded'
postfix stop >/dev/null 2>&1 || true
postfix start
sleep 3

echo "Real STARTTLS SMTP -> LMTP -> IMAPS:"
python3 - <<'PY'
import os
from pathlib import Path
from selfhost.smoke_test import smoke_test

domain = os.environ["MONICO_CI_DOMAIN"]
data = Path(os.environ["MONICO_CI_DATA"])
secret = (data / "ci-secret").read_text(encoding="utf-8")
assert smoke_test("mail." + domain, "local-delivery@" + domain, secret, timeout=45)
print("PASS: actual Linux Postfix/Dovecot SMTP submission and IMAP inbox verification")
PY
rm -f "$DATA/ci-secret"
echo "This verifies local mail transport only, NOT external Internet MX/PTR/port-25 availability."
