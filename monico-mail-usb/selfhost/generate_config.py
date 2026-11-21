#!/usr/bin/env python3
"""Generate REVIEW-ONLY Postfix/Dovecot 2.3/2.4 configs for an independent mail host.

The generated files are not installed automatically. Real domain delegation,
public reachability, PTR DNS and trusted TLS are prerequisites for public mail.
"""
import argparse
import ipaddress
import os
from pathlib import Path
import re

DOMAIN_PATTERN = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


def check_domain(domain):
    domain = str(domain or "agents.local").strip().lower().lstrip("@")
    if not domain:
        return "agents.local"
    if not DOMAIN_PATTERN.fullmatch(domain) or ".." in domain:
        raise ValueError("Invalid domain format (use letters, numbers, dots, hyphens)")
    return domain


def check_path(value):
    value = str(Path(value).expanduser().resolve())
    if any(c in value for c in ("\n", "\r", "\x00")) or "'" in value or '"' in value:
        raise ValueError("Unsafe path")
    return value


def render(domain, db, mail_root, uid, gid, certificate, private_key, public_ip, public_ipv6=None):
    domain = check_domain(domain)
    db, mail_root = check_path(db), check_path(mail_root)
    certificate, private_key = check_path(certificate), check_path(private_key)
    if uid < 100 or gid < 100:
        raise ValueError("Use a dedicated non-system vmail UID and GID >= 100")
    if not public_ip and not public_ipv6:
        raise ValueError("A globally routable public IPv4 or IPv6 address is required")
    if public_ip is not None:
        ip4 = ipaddress.ip_address(public_ip)
        if ip4.version != 4 or not ip4.is_global:
            raise ValueError("IPv4 must be globally routable")
        public_ip = str(ip4)
    if public_ipv6 is not None:
        ip6 = ipaddress.ip_address(public_ipv6)
        if ip6.version != 6 or not ip6.is_global:
            raise ValueError("IPv6 must be globally routable")
        public_ipv6 = str(ip6)
    protocols = "all" if public_ip and public_ipv6 else ("ipv6" if public_ipv6 else "ipv4")

    postfix_main = f"""# REVIEW BEFORE INSTALLING; do not overwrite an existing production main.cf
myhostname = mail.{domain}
mydomain = {domain}
myorigin = $mydomain
mydestination = localhost
inet_interfaces = all
inet_protocols = {protocols}
mynetworks = 127.0.0.0/8
virtual_mailbox_domains = {domain}
virtual_mailbox_maps = proxy:sqlite:/etc/postfix/sqlite-virtual-mailboxes.cf
# Postfix proxymap must approve the authenticated sender lookup explicitly.
# Preserve its standard read maps rather than allowing unrestricted proxy access.
proxy_read_maps = $local_recipient_maps, $mydestination, $virtual_alias_maps, $virtual_alias_domains, $virtual_mailbox_maps, $virtual_mailbox_domains, $relay_recipient_maps, $relay_domains, $canonical_maps, $sender_canonical_maps, $recipient_canonical_maps, $relocated_maps, $transport_maps, $mynetworks, $smtpd_sender_login_maps, proxy:sqlite:/etc/postfix/sqlite-sender-login.cf
virtual_transport = lmtp:unix:private/dovecot-lmtp
smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination
smtpd_recipient_restrictions = reject_unauth_destination
smtpd_sasl_type = dovecot
smtpd_sasl_path = private/auth
smtpd_sasl_auth_enable = no
smtpd_tls_cert_file = {certificate}
smtpd_tls_key_file = {private_key}
smtpd_tls_security_level = may
smtpd_tls_auth_only = yes
smtp_tls_security_level = may
disable_vrfy_command = yes
"""
    postfix_sqlite = f"""# /etc/postfix/sqlite-virtual-mailboxes.cf
dbpath = {db}
query = SELECT email FROM agents WHERE email = '%s'
"""
    sender_sqlite = f"""# /etc/postfix/sqlite-sender-login.cf
dbpath = {db}
query = SELECT email FROM agents WHERE email = '%s'
"""
    master = """# Add to /etc/postfix/master.cf only after checking existing submission section
submission inet n       -       y       -       -       smtpd
  -o syslog_name=postfix/submission
  -o smtpd_tls_security_level=encrypt
  -o smtpd_sasl_auth_enable=yes
  -o smtpd_sasl_security_options=noanonymous
  -o smtpd_sender_login_maps=proxy:sqlite:/etc/postfix/sqlite-sender-login.cf
  -o smtpd_sender_restrictions=reject_authenticated_sender_login_mismatch
  -o smtpd_relay_restrictions=permit_sasl_authenticated,reject
"""
    dovecot_conf = f"""# Additional Dovecot 2.3 configuration; do not copy into Dovecot 2.4 without updating
protocols = imap lmtp
postmaster_address = postmaster@{domain}
mail_location = maildir:{mail_root}/%d/%n/Maildir
ssl = required
ssl_min_protocol = TLSv1.2
ssl_cert = <{certificate}
ssl_key = <{private_key}
disable_plaintext_auth = yes
auth_mechanisms = plain login

passdb {{
  driver = sql
  args = /etc/dovecot/dovecot-sql.conf.ext
}}
userdb {{
  driver = static
  args = uid={uid} gid={gid} home={mail_root}/%d/%n
}}
service lmtp {{
  unix_listener /var/spool/postfix/private/dovecot-lmtp {{
    mode = 0600
    user = postfix
    group = postfix
  }}
}}
service auth {{
  unix_listener /var/spool/postfix/private/auth {{
    mode = 0660
    user = postfix
    group = postfix
  }}
}}
"""
    dovecot_sql = f"""# Must be readable by Dovecot auth workers. Never make secrets world writable.
driver = sqlite
connect = {db}
default_pass_scheme = SHA256.HEX
password_query = SELECT a.email AS user, m.password_hash AS password FROM agents a JOIN mail_accounts m ON m.email = a.email WHERE a.email = '%u'
"""

    dovecot_24 = f"""# REVIEW ONLY: Dovecot 2.4, not compatible with Dovecot 2.3
dovecot_config_version = 2.4.0
dovecot_storage_version = 2.4.0
protocols = imap lmtp
postmaster_address = postmaster@{domain}
mail_driver = maildir
mail_path = ~/Maildir
ssl = yes
ssl_server_cert_file = {certificate}
ssl_server_key_file = {private_key}
auth_allow_cleartext = no
auth_mechanisms = plain login
sql_driver = sqlite
sqlite_path = {db}
passdb_default_password_scheme = SHA256.HEX

passdb sql {{
  query = SELECT a.email AS user, m.password_hash AS password FROM agents a JOIN mail_accounts m ON m.email = a.email WHERE a.email = '%{{user}}'
}}
userdb static {{
  fields {{
    uid = {uid}
    gid = {gid}
    home = {mail_root}/%{{user | domain}}/%{{user | username}}
  }}
}}
service lmtp {{
  unix_listener /var/spool/postfix/private/dovecot-lmtp {{
    mode = 0600
    user = postfix
    group = postfix
  }}
}}
service auth {{
  unix_listener /var/spool/postfix/private/auth {{
    mode = 0660
    user = postfix
    group = postfix
  }}
}}
"""

    # DNS files deliberately have placeholders for verification of DKIM
    # rather than inventing a key and claiming deliverability.
    addresses = "\n".join(
        (["mail 3600 IN A " + public_ip] if public_ip else []) +
        (["mail 3600 IN AAAA " + public_ipv6] if public_ipv6 else [])
    )
    zone = f"""; Illustrative authoritative DNS records. A parent-zone delegation is REQUIRED.
; Replace domain and infrastructure details to match your delegated zone.
$ORIGIN {domain}.
@ 3600 IN MX 10 mail.{domain}.
{addresses}
@ 3600 IN TXT "v=spf1 mx -all"
_dmarc 3600 IN TXT "v=DMARC1; p=none"
; DKIM public TXT record must be added after generating and configuring a DKIM key.
; Reverse DNS/PTR must be configured by the owner of the public IP address.
"""
    return {
        "postfix-main.cf": postfix_main,
        "postfix-master-submission.cf": master,
        "postfix-sqlite-virtual-mailboxes.cf": postfix_sqlite,
        "postfix-sqlite-sender-login.cf": sender_sqlite,
        "dovecot-2.3-extra.conf": dovecot_conf,
        "dovecot-2.4-extra.conf": dovecot_24,
        "dovecot-sql.conf.ext": dovecot_sql,
        "dns-zone-example.txt": zone,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--domain", required=True, help="Already-delegated mail domain")
    p.add_argument("--db", required=True, help="Existing agents.sqlite3 file on USB")
    p.add_argument("--mail-root", required=True, help="USB-backed virtual-mail storage")
    p.add_argument("--vmail-uid", type=int, required=True)
    p.add_argument("--vmail-gid", type=int, required=True)
    p.add_argument("--cert", required=True, help="TLS certificate path (not created)")
    p.add_argument("--key", required=True, help="TLS private key path (not created)")
    p.add_argument("--public-ip", help="Globally routable IPv4, optional with IPv6")
    p.add_argument("--public-ipv6", help="Globally routable IPv6, optional with IPv4")
    p.add_argument("--output", default=".generated/selfhost")
    args = p.parse_args()
    configs = render(args.domain, args.db, args.mail_root, args.vmail_uid,
                     args.vmail_gid, args.cert, args.key, args.public_ip, args.public_ipv6)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    for name, content in configs.items():
        file_path = output / name
        file_path.write_text(content, encoding="utf-8")
        file_path.chmod(0o600)
        print(file_path)
    print("CONFIG TEMPLATES GENERATED. Nothing has been installed or exposed publicly.")
    print("Select ONE Dovecot config matching the installed version (2.3 or 2.4).")
    print("Do NOT deploy without TLS, DNS/MX/PTR, DKIM, security review and tested USB permissions.")


if __name__ == "__main__":
    main()
