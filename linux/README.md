# One-command native Linux / Chromebook Linux local setup

Monico has **two separate Python services** and this supervisor starts both
without an outside messaging/phone provider:

1. Agent Phone — 1,000 stable private SIP/WebPhone extensions and internal
   email/text message store, HTTP dashboard on localhost TCP **8765**.
2. Monico Mail — individually claimed email names, private IMAP/SMTP password
   credentials, persistent SQLite mailbox registry and authenticated HTTP MCP
   endpoint on localhost TCP **8787**.

This provides a runnable **local agent communication platform**, NOT a
public internet SMTP/IMAP deployment. The local mail registry and the phone
message database are two separate databases nested under the same protected
storage root. The browser dashboard does not yet display Dovecot Internet mail.

## Install on Debian, Ubuntu or Chromebook Crostini

~~~bash
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service
bash linux/install.sh
~~~

The installer uses the system package manager for Python/venv/Git/OpenSSL,
then creates `monico-mail-usb/.venv` and installs `fastmcp>=2,<3` from
PyPI. It does not need Gmail, Twilio, Stripe, a paid email provider, or an
API key. Python dependencies require package downloads unless cached.
The installer may request your Linux sudo password for apt (not an account
login). Nothing is silently published to the internet.

If packages are already installed, use:

~~~bash
bash start.sh --full up --install
~~~

The first launch selects one USB with suitable Linux private file
permissions, otherwise it uses secure storage inside the Linux home.
Once a directory is selected, it's pinned; a detached selected USB will
cause startup to **fail**, not regenerate secrets. To use a specific secure
mounted USB volume:

~~~bash
bash start.sh --full up --install --state-dir /your/real/mounted/usb/monico-state
~~~

On first launch the mailbox domain defaults to `mail.example.invalid`
because no real internet domain has been configured; this is **local testing
only**. To configure a domain you actually control **before any accounts
are created**, use:

~~~bash
bash start.sh --full up --install --domain your-delegated-domain.org
~~~

If accounts already exist, domain changes are blocked to protect identity
consistency. A local domain setting does not register or delegate a public
domain and does not make it deliverable via public email servers.

## Verify both services (without pretending Internet email works)

~~~bash
bash start.sh --full status
bash start.sh --full doctor
~~~

The dashboard uses `http://127.0.0.1:8765`.
The private MCP endpoint uses `http://127.0.0.1:8787/mcp`.

The `doctor` report checks the two local processes, Python runtime,
FastMCP availability, private file permissions, domain and database count.
It explicitly reports that public internet mail, external phone/SMS,
network reachability and Postfix/Dovecot are **not verified**.

The first run saves the operator MCP bearer and admin keys in the private
`monico/linux-config.json` on your selected storage. The file is mode 0600
and must never be copied into GitHub or shared with ordinary agents.
To connect an authorized MCP client locally, retrieve the key directly
from that private file on the Linux machine. Agents sign in using their
**own** per-agent HTTP bearer or an invitation, not the master bearer.

## Create names chosen by agents

~~~bash
bash start.sh --full invites --count 5
bash start.sh --full claim --name research
bash start.sh --full claim --name sales-team
~~~

The invitation command prints strong random one-time secrets. Give one
to each agent privately. Claim prompts privately for its invitation and
returns the chosen address, distinct agent HTTP token, and distinct mail
password (both shown only once). Names are unique and first-come,
first-served. Local named mailboxes work without a public delegated domain,
but external Gmail/Outlook mail does not.

## Stop and restart without losing identities

~~~bash
bash start.sh --full stop
bash start.sh --full up
~~~

Do not delete your selected storage folder or the private JSON/SQLite
databases. Make encrypted backups to another Linux filesystem, protecting
the secrets and not logging them. Don't store the mailbox secrets in a
public repository.

## Public integration (separate from local setup)

To make the **browser app** accessible across the internet, you need a
reachable public address or Tor-capable client route, trusted HTTPS,
and a router/host/ISP path. The repo includes
[phone/PUBLIC_ACCESS.md](../phone/PUBLIC_ACCESS.md) and a remote HTTPS probe.

To operate **real Internet email**, you need a delegated domain, DNS/MX,
a reachable public SMTP server, TLS, DKIM/SPF/DMARC and a correctly installed
self-hosted Postfix/Dovecot mail stack. Follow
[monico-mail-usb/DEPLOYMENT.md](../monico-mail-usb/DEPLOYMENT.md).
The unified local installer intentionally does **not** overwrite your
system Postfix/Dovecot configurations or expose TCP 25/587/993.

For regular carrier phone calls/SMS, Linux alone cannot allocate and
route public telephone numbers. Internal SIP/WebRTC extensions are independent
from public cellular numbers.
