# Monico: self-hosted public email deployment (native Linux)

This is the runbook for a REAL, independent mail server that you operate.
There are no Gmail/Outlook accounts, paid email APIs, email relays, or required
commercial email-hosting providers. Debian packages are open-source components
installed on YOUR Linux machine.

**Status: code and configuration staging are implemented; public delivery is
NOT deployed or verified.** Do not claim otherwise. This guide never
pretends that a locally invented domain is globally delegated.

## Non-negotiable internet prerequisites

For external addresses to send mail to your server, obtain **delegation of a
real public domain/subdomain** from the registry/parent DNS authority. You
can run BIND9 for your own authoritative nameservers, but the parent must
publish the delegation and any necessary glue records. There is no purely
local/no-third-party mechanism to allocate an arbitrary publicly recognized
internet name.

Your Linux host needs a public routable IP (or working public port forwards),
incoming TCP **25** from unrelated internet mail servers, outgoing TCP **25**
to those mail servers, reverse DNS/PTR from the public IP owner, and 24/7
uptime. Set up MX/A, SPF, DKIM and DMARC. Standard email clients also require
a publicly trusted TLS certificate or explicitly installed trust for your own
certificate. Spam/abuse controls, backups and monitoring are necessary.

**Chromebook Crostini:** ChromeOS's Linux port-forwarding UI is primarily for
local-network development access. ChromeOS sleep, NAT, the ISP, and USB
sharing can block public SMTP/IMAP delivery. Shared USB directories may not
support the dedicated Linux vmail/postfix user ownership needed by Maildir.
For public service prefer native, always-on Linux with an actual writable
POSIX filesystem mounted from the USB drive. Never force chown on a ChromeOS
shared FUSE/9p filesystem that doesn't support it.

## Step 1 — Configure your actual domain and USB volume

Run in the repository's monico-mail-usb folder. Replace the examples:

```bash
cd ~/agent-mail-service
git pull
cd monico-mail-usb
bash chromebook-setup.sh

ls -la /mnt/chromeos/removable/
python3 setup_monico.py --usb "YOUR_USB" --domain "your-delegated-domain.org"
python3 mailbox_admin.py status

python3 mailbox_admin.py create-system postmaster
python3 mailbox_admin.py create-system abuse

python3 mailbox_admin.py issue-invites --count 10
```

Agents choose their own names and privately redeem invitations:

```bash
python3 mailbox_admin.py claim research
python3 mailbox_admin.py claim support
```

Each gets a separate random MCP agent token and SMTP/IMAP password, shown
once, and the address will be the chosen name at your configured domain.
Never share either key publicly.

## Step 2 — Verify Linux packages, services and USB permissions

On an actual Debian/Ubuntu mail host:

```bash
sudo apt-get update
sudo apt-get install -y postfix postfix-sqlite dovecot-core dovecot-imapd \
  dovecot-lmtpd dovecot-sqlite bind9 dnsutils opendkim opendkim-tools sqlite3

dovecot --version
postconf -m | grep -i sqlite
```

Dovecot 2.3 (e.g., Debian 12) and 2.4 (e.g., Debian 13) have incompatible
configuration syntax. Choose the matching generated template ONLY and review
it with the installed version's documentation. Do not overwrite your existing
system mail configurations without backups or a security review.

Create a dedicated vmail account if it does not exist:

```bash
id vmail || sudo useradd --system --user-group --home-dir /var/vmail \
  --shell /usr/sbin/nologin vmail
```

Check and arrange **actual Linux read/write permissions** without opening
the database to the world:

```bash
# Run under the SAME MONICO_DATA environment from your setup.
sudo -u vmail test -w "$MONICO_DATA" && echo "vmail writable"
sudo -u postfix test -r "$MONICO_DATA/agents.sqlite3" && echo "postfix can read DB"
```

If either fails, STOP and correct volume mounting and user/group/ACL access.
Dovecot auth workers also need read access to the database. Protect the
database from unrelated users: it contains hashed mailbox credentials.
A simple write test run as the regular Chromebook Linux user is insufficient.

## Step 3 — Generate DKIM keys on your own host

```bash
python3 selfhost/dkim_setup.py --domain "$MONICO_DOMAIN" \
  --output ".generated/dkim"
```

This generates a private RSA signing key, a *public* DNS TXT record file, and
STAGED OpenDKIM/Postfix signing configuration. Keep the private key confidential
and install it with permissions appropriate to the OpenDKIM service account.
Publishing the TXT record is not enough: outbound messages must actually be
signed by the local OpenDKIM milter. Never upload the private key to GitHub.

## Step 4 — Generate self-hosted authoritative DNS

Replace the sample IP addresses with your globally routable IP(s):

```bash
python3 selfhost/dns_zone.py \
  --domain "$MONICO_DOMAIN" \
  --public-ip "$YOUR_REAL_PUBLIC_IPV4" \
  --ns1-ip "$YOUR_NS1_PUBLIC_IPV4" \
  --ns2-ip "$YOUR_NS2_PUBLIC_IPV4" \
  --dkim-txt-file ".generated/dkim/mail.txt"

named-checkzone "$MONICO_DOMAIN" ".generated/dns/db.$MONICO_DOMAIN"
```

Files are created in .generated/dns and are NOT installed. Check the zone
syntax, install the reviewed zone in BIND9 with bind-readable permissions,
and arrange the domain delegation at the parent nameserver authority. If
ns1/ns2 are on the same IP/machine, there is a single point of failure.

The domain's published MX record must reference the real mail host; the
public sending IP needs the correct PTR (reverse DNS) set by the IP owner.
You cannot create globally visible reverse DNS by editing your local BIND zone.

## Step 5 — Stage Postfix/Dovecot/TLS settings

Obtain TLS certificate and private-key files that match
mail.your-delegated-domain.org. Normal clients won't automatically trust
a self-signed certificate.

```bash
python3 selfhost/prepare_live.py \
  --domain "$MONICO_DOMAIN" --data "$MONICO_DATA" \
  --public-ip "$YOUR_REAL_PUBLIC_IPV4" \
  --ns1-ip "$YOUR_NS1_PUBLIC_IPV4" \
  --ns2-ip "$YOUR_NS2_PUBLIC_IPV4" \
  --vmail-uid "$(id -u vmail)" --vmail-gid "$(id -g vmail)" \
  --cert "/absolute/path/to/fullchain.pem" \
  --key "/absolute/path/to/privkey.pem" \
  --dkim-public-txt ".generated/dkim/mail.txt"
```

The staged output in .generated/live-stage includes an explicit
STAGED_NOT_DEPLOYED manifest. No system mail config is overwritten.
Review and install the files with correct path, permission, and service
version handling. Add account-level abuse/spam limits, mail quotas,
monitoring, and backup before exposing services.

## Step 6 — Verify the running services

After the above is installed and running, check on YOUR mail host:

```bash
sudo postfix check
sudo doveconf -n
sudo named-checkconf
sudo ss -lntp | grep -E ':(25|53|587|993)\b'
sudo opendkim-testkey -d "$MONICO_DOMAIN" -s mail -vvv
```

Run the public-DNS and local-port preflight (it reports failures rather
than claiming success):

```bash
python3 selfhost/preflight.py \
  --data "$MONICO_DATA" --domain "$MONICO_DOMAIN" \
  --host "mail.$MONICO_DOMAIN" \
  --public-ip "$YOUR_REAL_PUBLIC_IPV4" --live
```

Check that external networks can reach inbound **TCP 25** and the public
MX host, and that outbound TCP 25 is not blocked by your ISP. Testing
localhost alone does not prove this.

Test one real local mailbox end-to-end through your own server:

```bash
python3 selfhost/smoke_test.py \
  --host "mail.$MONICO_DOMAIN" \
  --email "research@$MONICO_DOMAIN"
```

The script prompts for the actual independent SMTP/IMAP password and checks
delivery via port 587 (STARTTLS) into port 993 (IMAPS). This is not sufficient
to prove delivery to unrelated internet providers; also send and receive
from a remote independent mail system. Verify reverse DNS and DKIM signatures
and monitor rejects/bounces.

## Step 7 — MCP agent access

Once the SMTP/IMAP services are deployed and secured:

```bash
export MONICO_MAIL_HOST="mail.$MONICO_DOMAIN"
# Set strong MONICO_ADMIN_KEY and a SEPARATE MONICO_MCP_BEARER_TOKEN
bash start-monico.sh
```

The MCP tools send_real_email, list_real_inbox, read_real_email, and
list_real_sent connect directly to YOUR Postfix/Dovecot using each mailbox's
own credentials. The agent's chosen local part is stable across restarts.

**Keep MCP on localhost/private networks until a production HTTPS gateway is verified.** Per-agent HTTP bearer verification, one-time invitation bearer onboarding and role isolation are implemented, but public remote hosting still requires request rate limiting, TLS termination, deployment validation and abuse protections. A public MCP URL must not be exposed
before those are implemented and verified.

## Status that actually matters

Passing the Python unit tests shows mailbox identity code works; it does
not create DNS delegation, a public IP, real TLS, or SMTP delivery. The
public mail service is online only after live Postfix/Dovecot service checks,
outside-network port-25 access, correct delegated DNS records, and
independent inbound and outbound mail delivery tests have all succeeded.


### Private HTTP MCP onboarding after per-agent authentication

An operator connects to the local MCP endpoint with a bearer equal to
`MONICO_MCP_BEARER_TOKEN` and calls `create_invites` using the separate
`MONICO_ADMIN_KEY`. Give **one code** privately to each agent.

During account selection, the agent authenticates to MCP with its **invitation code as the HTTP bearer** and calls `claim_my_email(invitation_code, desired_name)`. It chooses the name; the domain is inherited from the server's saved `MONICO_DOMAIN` setting.

After receiving its account, the agent reconnects with its **agent_token as the HTTP bearer**, not the master operator token, then uses its own tools with matching `agent_id` and `agent_token`. Tokens are checked against SQLite and rotation invalidates the old bearer. There is no third-party identity provider.

This improves tool-level isolation but does **not** turn a private HTTP endpoint into a safely accessible public URL. Do not forward the MCP port publicly before terminating HTTPS and enabling abuse protections.
