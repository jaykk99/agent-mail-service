# Monico Mail USB — independent Linux-hosted mailboxes

**Goal:** Up to 1,000+ independent, **agent-named** email addresses, chosen by each agent, with separate IMAP/SMTP credentials, mailbox identities in SQLite and future real mail delivery through **your own** Postfix/Dovecot Linux mail server. **No Gmail, Outlook or third-party mailbox provider is used.**

## Choose your own domain and email name (new)

**You choose the domain; agents choose their own names.** Examples (illustrative only):

- One agent claims `sales@yourdomain.com`
- Another claims `research@yourdomain.com`
- Another claims `myshop@yourdomain.com`

The internal `agent_id` is generated separately and is **not** used as the email name.

**Important domain limit:** Monico cannot make `yourdomain.com` a real public domain unless it has been delegated to you by the global DNS hierarchy. You can run all your own DNS/mail software without Gmail or a paid email host, but domain delegation itself cannot be bypassed. Do not type a domain you do not control and expect public email to work.

### Configure a domain locally on Linux

From `agent-mail-service/monico-mail-usb`, after sharing the USB drive with Linux:

```bash
export MONICO_DATA="/mnt/chromeos/removable/YOUR_USB/monico"
mkdir -p "$MONICO_DATA"
python3 selfhost/configure_domain.py --domain your-actually-delegated-domain.tld --data "$MONICO_DATA"
source "$HOME/.config/monico-mail/domain.env"
echo "$MONICO_DOMAIN"
```

Replace the sample with **your actual delegated domain or subdomain**. The configurator saves `MONICO_DOMAIN` privately, checks for an existing database using a different domain, and does *not* register DNS. The startup script loads this saved domain automatically when `MONICO_DOMAIN` is not already exported. If you previously created test accounts at `mail.example.invalid`, use a new empty USB data directory for the real domain (or migrate existing accounts explicitly); Monico prevents silent address changes.

### Give agents their own choice of email name

Create one-time signup invitations on your own Linux machine:

```bash
python3 mailbox_admin.py issue-invites --count 10 --valid-days 7
```

Each invitation is a random, single-use secret. Give **one code privately to each agent**. The agent picks its own desired name when claiming, for example:

```bash
python3 mailbox_admin.py claim sales
python3 mailbox_admin.py claim research
python3 mailbox_admin.py claim myshop
```

The `claim` command asks for the invitation code without echoing it. Each claim creates a permanent mailbox such as `sales@$MONICO_DOMAIN`, its own randomly generated **mail password**, and a different **MCP agent token**. Save both credentials securely when they are first displayed. Names are case-insensitive, unique, and first-come-first-served; reserved administrative names cannot be claimed.

For agents already connected to the **private operator-authenticated MCP**, the equivalent tools are `check_email_name(desired_name)`, `claim_my_email(invitation_code, desired_name)`, and admin-only `create_invites(admin_key, count, valid_days)`. The `get_domain_info(admin_key)` tool reports configured domain and free slots. **Do not give the operator-wide HTTP bearer key to untrusted agents**: a separate per-agent HTTP access layer is still required before offering remote self-service signup.

The default capacity is 1,000 mailboxes; you can issue up to 200 invitations per batch. Issued invitations expire and can only be used once. This creates identities on your Linux host, **not live public email delivery** until Postfix/Dovecot and the public DNS/network are deployed.

---

## Status (read before deploying)

- **Built:** self-chosen unique mailbox names with invitation onboarding, configurable domain, persistent registry, independent one-time mail passwords and MCP tokens, password rotation, local agent-to-agent messages, Postfix/Dovecot 2.3 and 2.4 config generator, local mailbox management CLI, unit tests.
- **Tested locally:** 1,000 distinct identities and password/persistence/isolation operations against a local copy of the registry code.
- **NOT yet deployed or verified:** real public inbound/outbound SMTP, TLS certificates, DKIM signing, DNS/PTR, Dovecot/Postfix integration on your Chromebook, securely exposed MCP endpoint and ChromeOS/USB permissions. **Do not expose the MCP service publicly.**
- MCP's internal SQLite-message inbox and the future Dovecot Maildir inbox are different storage systems. Incoming SMTP mail into Dovecot is not yet displayed by the MCP `list_inbox` tool; use IMAP when the mail stack is deployed.

## Reality of "own free domain, no third party"

You can run **all of the software yourself**, including authoritative DNS (e.g., BIND), Postfix, Dovecot, SQLite and your own hardware. There is no required paid mailbox provider.

However, public email addresses like `agent001@yourdomain.tld` require that the domain or a subdomain be **actually delegated in global DNS** by an existing registry/registrar/parent domain owner. Self-declaring an arbitrary domain on Linux will not make it resolve for Gmail or other external mail systems. Free delegated subdomains may exist, but that still involves a domain owner. A truly **zero-external-party** public domain is not possible using the current internet DNS.

You also need:
- A reachable public mail host with **inbound TCP 25**, outbound TCP 25, and router/ISP support.
- Public DNS records: **A/AAAA, MX, SPF, DKIM, DMARC** plus **PTR/reverse DNS** controlled by the IP provider.
- A trusted TLS certificate if normal email clients will connect without warnings. Self-signed certificates aren't generally trusted.
- Continuous uptime, server maintenance, abuse/spam controls, backups and enough disk space.

**ChromeOS Linux (Crostini) is a development environment, not a guaranteed always-on public mail host.** The ChromeOS Linux port forwarding UI primarily forwards ports on your *local network*. Sleep and network limitations can prevent public mail delivery. ChromeOS's shared USB folders might not permit the `vmail` user ownership/permissions and filesystem locking required by Dovecot and SQLite. Check this before attempting deployment; do not silently fall back to the internal disk.

## 1. Update/install on your Chromebook

In the Linux Terminal:

```bash
sudo apt-get update
sudo apt-get install -y git python3 python3-venv
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service/monico-mail-usb
bash chromebook-setup.sh
```

Already cloned it? Run:

```bash
cd ~/agent-mail-service
git pull
cd monico-mail-usb
```

## 2. Find your USB and check Linux can write it

```bash
ls -la /mnt/chromeos/removable/
```

Replace `YOUR_USB` with the **actual** USB drive name:

```bash
export MONICO_DATA="/mnt/chromeos/removable/YOUR_USB/monico"
mkdir -p "$MONICO_DATA"
touch "$MONICO_DATA/.test" && rm "$MONICO_DATA/.test"
```

## 3. Create an independent mailbox (local identity/password)

Use a domain that has actually been delegated to you if you want to receive internet mail; `mail.example.invalid` is for **local testing only**.

```bash
export MONICO_DOMAIN="mail.example.invalid"
python3 mailbox_admin.py create agent_001 agent001
python3 mailbox_admin.py count
```

Example output includes:
- `email`: `agent001@mail.example.invalid` (not publicly deliverable until a real domain is used)
- `token`: random MCP credential, shown once
- `mail_password`: **different** random password for IMAP/SMTP, shown once

Existing identities created before mail passwords were added can get a mailbox password by running `python3 mailbox_admin.py rotate-password AGENT_ID` and entering the agent's MCP token. Passwords are stored as SHA-256 digests of high-entropy random secrets, not plaintext. Keep their original secrets private.

## 4. Start the private MCP registry

```bash
export MONICO_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export MONICO_MCP_BEARER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
bash start-monico.sh
```

Local endpoint: `http://127.0.0.1:8787/mcp`; use `Authorization: Bearer <MONICO_MCP_BEARER_TOKEN>` in a compatible MCP client. Save the secrets privately for later launches. The operator-wide bearer token MUST NOT be shared with untrusted agents. A separate per-agent HTTP access layer is still needed before public hosting.

## 5. Prepare your own mail stack (ONLY after domain/network prerequisites)

Self-hosted open-source packages on Debian:

```bash
sudo apt-get install -y postfix postfix-sqlite dovecot-core dovecot-imapd dovecot-lmtpd dovecot-sqlite
dovecot --version
postconf -m | grep sqlite
```

Dovecot **2.3 and 2.4 have incompatible configuration syntaxes**. The generator creates separate templates for both; use only the one matching your version. For a **real domain and public IPv4 you control**, prepare config files with:

```bash
python3 selfhost/generate_config.py \
  --domain "$MONICO_DOMAIN" \
  --db "$MONICO_DATA/agents.sqlite3" \
  --mail-root "$MONICO_DATA/maildirs" \
  --vmail-uid "$(id -u vmail)" \
  --vmail-gid "$(id -g vmail)" \
  --cert /path/to/real/tls/fullchain.pem \
  --key /path/to/real/tls/privkey.pem \
  --public-ip "$YOUR_ACTUAL_PUBLIC_IPV4"
```

**Important:** The `vmail` account, TLS cert/key, delegated domain, and public IP above must actually exist. This command generates **review-only config templates** in `.generated/selfhost/`; it does **not** install them or claim the server is online. The templates cover Postfix, Dovecot, SQLite lookups and example DNS. A qualified administrator must review permissions, avoid overwriting existing Postfix/Dovecot configs, add DKIM signing and configure mail service security before activating ports.

After deployment, normal mail-client settings would be: incoming IMAPS on port **993**, outgoing submission with STARTTLS on port **587**, and inbound inter-server SMTP on port **25**, all at your real mail host `mail.yourdomain.tld`. Each agent logs in with its full email address and its own `mail_password`.

## 6. Tests

```bash
bash run-tests.sh
```

The test suite covers 1,000 registry entries, credentials, storage persistence, internal inbox isolation, and rendering of self-hosted mail-server configuration. GitHub Actions is configured to run tests on repository changes. **Offline tests cannot prove internet mail deliverability.** After configuring a running Postfix/Dovecot mail stack with a trusted TLS certificate, perform a live local SMTP-to-IMAP delivery check:

```bash
python3 selfhost/smoke_test.py --host mail.YOUR_DOMAIN --email agent001@YOUR_DOMAIN
```

The script securely prompts for the agent's independent IMAP/SMTP password, submits a test email to the same mailbox over port 587 with STARTTLS, then checks for it over IMAPS port 993. It uses only your own mail server and reports failure rather than guessing. Even if this test passes, **external internet delivery** still needs a separate test from/to an independent email system; delivery cannot be validated without communicating with another mail system.

## Security / operating notes

- The mail server design uses **only your Linux host** for SMTP/IMAP, not Gmail or a paid API.
- Random 256-bit mailbox passwords use a SHA-256 hex digest compatible with Dovecot SQL password schemes; don't permit user-chosen weak passwords.
- Never commit mail passwords, MCP keys, private TLS keys or actual database files.
- Rotate any secrets that were pasted into a public repo or conversation.
- Implement backup/restore, quotas, DKIM signing, spam filtering, account-specific MCP transport authorization, rate limiting and pairing before relying on this as a public service.
- Maildir/SQLite on a ChromeOS-shared USB must be validated for permissions, ownership and locking under the actual `postfix` and `vmail` users.

See [CHROMEBOOK.md](CHROMEBOOK.md) for Crostini-specific context.


## 7. Check host readiness before installation and public exposure

On the **actual Linux mail host** (not inside this chat), replace the sample values with real ones:

```bash
python3 selfhost/preflight.py \
  --data "$MONICO_DATA" \
  --domain "$MONICO_DOMAIN" \
  --host "mail.$MONICO_DOMAIN" \
  --public-ip "$YOUR_ACTUAL_PUBLIC_IPV4"
```

After you have real DNS records, running Postfix/Dovecot and router forwarding in place, add `--live` to check your domain's MX/NS/SPF/DMARC/PTR records and local connectivity to ports 587/993. Install `dnsutils` first (`sudo apt-get install dnsutils`). These checks deliberately **do not** claim that port 25 is reachable from the internet; verify TCP 25 from a separate outside network.

A domain ending in `.invalid` is explicitly rejected for a public mail deployment. No code can make an arbitrary unregistered name globally reachable by itself.

## 8. Agent tools for real self-hosted mail

Once **your own** Postfix and Dovecot are working with a valid trusted TLS certificate, set:

```bash
export MONICO_MAIL_HOST="mail.$MONICO_DOMAIN"
bash start-monico.sh
```

These MCP tools then use **each agent's own** credentials to access the local self-hosted SMTP/IMAP services:

- `send_real_email(agent_id, agent_token, mail_password, recipient, subject, body)`: authenticated SMTP submission with STARTTLS to port 587; sender is the agent's own email.
- `list_real_inbox(agent_id, agent_token, mail_password, limit=20)`: read subject/from/date over TLS using Dovecot IMAPS on port 993.
- `read_real_email(agent_id, agent_token, mail_password, imap_uid)`: read the corresponding plain-text message from the agent's own IMAP mailbox.
- `list_real_sent(agent_id, agent_token, limit=20)`: local history of accepted SMTP submissions. **Not** a Dovecot Sent folder.

All connections use the Python standard library, require certificate verification, and contact only `mail.$MONICO_DOMAIN`. The SMTP MCP tool enforces 10 attempts per agent per hour and 1,000 attempts per host per hour, but **direct Postfix SMTP clients bypass this tool-level limit**. Enforce mail-server-level rate limits, abuse protection, and quotas separately. Do not expose the operator bearer token to agents.

The old `send_internal_mail` / `list_inbox` tools use a **separate local SQLite message store**. For actual inbound internet mail, use the **real** IMAP tools above. These protocols only become operational after the real Postfix/Dovecot services are installed and configured.

## 9. Before calling the project complete

Run `bash run-tests.sh` and then verify a genuine mailbox with:

```bash
python3 selfhost/smoke_test.py --host "mail.$MONICO_DOMAIN" --email "agent001@$MONICO_DOMAIN"
```

For public internet delivery, also confirm independent external servers can send to your MX and receive outbound messages, that DKIM is signing, and that SPF/DMARC and reverse DNS are correct. No public service is considered live just because configuration templates were generated.

**Caution:** Changing `MONICO_DOMAIN` after accounts exist is blocked to prevent silently changing their identities. Provision accounts under the real domain after delegation rather than using a placeholder as your permanent database.
