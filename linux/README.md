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

## Start everything automatically in one command

Run this once, as your normal Linux user, in the cloned repository:

~~~bash
bash linux/enable_autostart.sh
~~~

That single command does the whole installation: it detects or creates private
storage, installs FastMCP into `monico-mail-usb/.venv` when missing, starts the
dashboard (`http://127.0.0.1:8765`) and mail MCP
(`http://127.0.0.1:8787/mcp`), then installs and enables a `systemd --user`
watchdog unit that restarts both services when they stop and starts them with
your session. It also enables lingering so the stack comes back after a reboot
without you logging in. Nothing else is required.

It is idempotent: re-run the same command after a reboot, an update or a crash
and it reuses the same storage, identities and unit. Options are only for
non-default choices:

~~~bash
bash linux/enable_autostart.sh --state-dir /your/usb/monico-state  # pin storage
bash linux/enable_autostart.sh --domain your-delegated-domain.org  # first run
bash linux/enable_autostart.sh --free-domain                       # claim a free name
bash linux/enable_autostart.sh --interval 120                      # check every 2 min
bash linux/enable_autostart.sh --status
bash linux/enable_autostart.sh --uninstall
bash linux/enable_autostart.sh --print                             # review the unit
~~~

On a first interactive run it asks for the mailbox domain: press Enter to claim
a free DuckDNS subdomain, or type a domain you already control. The claim needs
a free token from [duckdns.org](https://www.duckdns.org), read from
`DUCKDNS_TOKEN` or prompted once and saved to
`~/.config/monico/duckdns.token` with mode 0600. Only a name DuckDNS reports as
not taken is kept. A free name resolves to your host, but it does not provide
inbound TCP/25, reverse DNS or a delegated mail domain, so receiving internet
email on it still needs the separate mail deployment in
[monico-mail-usb/DEPLOYMENT.md](../monico-mail-usb/DEPLOYMENT.md).

The installer verifies a freshly claimed name straight away. When its A record
does not point at this host yet, that is a warning printed with the failing
address and the exact re-check command, not a failed installation. Running
`bash linux/enable_autostart.sh --status` prints the pinned domain and repeats
that check, so it can be re-run at any time without claiming a new name.

To verify a claimed name later, compare its A record with your public address:

~~~bash
python3 linux/free_domain.py --check monico-abc123.duckdns.org
~~~

`--check` asks 8.8.8.8 and 1.1.1.1 directly, so a stale local cache cannot hide
a record pointing elsewhere, then falls back to the system resolver. It exits
non-zero when the name has no A record yet or resolves to a different address.
Pass `--expect-ip` to compare against a known address instead of detecting the
public one. This confirms DNS only: an A record is still not an MX or a PTR.

The installer refuses a relative path, a `monico/linux-config.json` readable
by other users, and `--public-ip` without `--allow-public`. It never re-runs
USB discovery for the unit: the pinned directory is used, so a detached drive
fails loudly instead of creating a second identity store. Unit files contain
paths and the optional public IP, never operator or agent secrets. Running it
with `sudo` is corrected to your user automatically; a root shell with no user
is refused.

This supervises the **local** dashboard and MCP services only; public
SMTP/IMAP, DNS, carrier calls/SMS and outside-network reachability remain
separate, unverified work.

## Optional: Start your own public HTTPS browser gateway

This exposes **only the Monico browser messenger, private extensions, and
WebRTC signaling**, not an open public SMTP relay or cellular network.
You must already have a routable public IPv4 under your control, forwarded
to the Linux host on TCP 8766. ChromeOS's local Linux port-forwarding alone
does not make an ISP/router accept arbitrary internet traffic.

After running `bash start.sh --full up --install`, you can stage
HTTPS credentials **without exposing anything**:

~~~bash
bash start.sh --public prepare --public-ip YOUR_ACTUAL_PUBLIC_IPV4
bash start.sh --public status
~~~

This generates a private local certificate authority and an IP-specific
TLS certificate. Only install the PUBLIC `monico-ca.crt` on devices you
trust. **Never distribute `monico-ca.key` or `server.key`.**

To deliberately start HTTPS bound to all Linux interfaces:

~~~bash
bash start.sh --public up --allow-public
bash start.sh --public doctor
~~~

Alternatively, once the local dependencies are installed, start
**phone + named-mail MCP + HTTPS gateway in one command**:

~~~bash
bash start.sh --full up \
  --public-ip YOUR_ACTUAL_PUBLIC_IPV4 \
  --allow-public
~~~

This command prepares the certificate if necessary and starts all three
services. It rejects missing opt-in, private IP addresses, certificate
identity changes, and occupied ports. The HTTPS gateway uses the **same**
pinned agent identity/credential store as the local dashboard and does
not publish the private MCP port 8787.

The intended URL is `https://YOUR_ACTUAL_PUBLIC_IPV4:8766`. To establish
that it really works across the public internet, use a different machine
on a different network (such as mobile data with a Linux shell) and run:

~~~bash
python3 phone/probe_public.py \
  --url "https://YOUR_ACTUAL_PUBLIC_IPV4:8766" \
  --ca-cert /safe/path/to/monico-ca.crt
~~~

The probe verifies trusted TLS, the 1,000-agent response, and unauthorized
API rejection. It **does not** test PSTN phone numbers, carrier SMS, actual
WebRTC audio across NAT, or external email delivery.

Manage the public gateway independently with:

~~~bash
bash start.sh --public status
bash start.sh --public stop
~~~

The unified `bash start.sh --full doctor` report also shows the public
gateway's *local* TLS health and explicitly marks outside-network access
unverified. `bash start.sh --full stop` stops the public gateway and
both local services. Restarting with `--full up` **does not reopen** the
public listener automatically; use `--allow-public` again.

---

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
