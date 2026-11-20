# Chromebook Linux (Crostini) deployment notes

Monico now prepares **independent self-hosted mailboxes**, not Gmail aliases. Provisioning agents and generating Postfix/Dovecot configuration works without a third-party mailbox provider. Actual public SMTP/IMAP operation is **not yet deployed or verified**.

## USB storage

ChromeOS Files -> select the USB drive -> **Share with Linux**. In Linux Terminal:

```bash
ls -la /mnt/chromeos/removable/
lsblk -f
```

Find the actual shared folder or passed-through block device. The two methods are different. Never assume a path without checking it.

```bash
export MONICO_DATA="/mnt/chromeos/removable/YOUR_DRIVE/monico"
mkdir -p "$MONICO_DATA"
touch "$MONICO_DATA/.write-test" && rm "$MONICO_DATA/.write-test"
```

**Critical:** Shared USB directories might be FUSE-based mounts and may not support Linux Unix ownership or the locking required by Postfix/Dovecot virtual-mail users. Local writes as your user do not prove that Dovecot's `vmail` user can write mail. Verify with your actual mailbox storage permissions before setup.

## Local account test

```bash
cd ~/agent-mail-service
git pull
cd monico-mail-usb
bash chromebook-setup.sh
bash run-tests.sh

export MONICO_DOMAIN="mail.example.invalid"
python3 mailbox_admin.py create agent_001 agent001
```

The domain above is for local account testing, not internet mail. The account has an independent IMAP/SMTP mail password and an independent MCP token.

## MCP registry (private only)

```bash
export MONICO_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export MONICO_MCP_BEARER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
bash start-monico.sh
```

The MCP endpoint is bound to `127.0.0.1:8787` inside Crostini. Operator bearer authentication is present but not suitable for sharing with untrusted agents. Do not publish it on the internet.

## Real email deployment prerequisites

Postfix and Dovecot are **open-source software installed locally**, not hosted email services. Before enabling public mail you need:
1. A **genuinely delegated public domain or subdomain**. You cannot create a globally routable arbitrary domain using only a local DNS server; parent registry/zone delegation is a requirement.
2. A public IPv4 with working inbound/outbound **TCP 25**, router mapping to the Linux mail server, and suitable reverse DNS.
3. A trusted certificate, MX, SPF, DKIM, DMARC, spam/abuse protection, backups and correct Linux filesystem permissions.
4. A mail server that stays awake. ChromeOS may suspend Crostini; its Linux forwarding UI is primarily for local-network devices.

Use `selfhost/generate_config.py` after these are available to generate review-only Postfix/Dovecot configuration. **Dovecot 2.3 and 2.4 require different config files**; check `dovecot --version`.

Do not expose TCP 25, 587 or 993 until the services have been installed, secured and tested. An MCP HTTPS tunnel does not solve incoming SMTP routing.

The complete commands and current limitations are in [README.md](README.md).
