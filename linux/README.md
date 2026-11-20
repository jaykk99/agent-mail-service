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

## Local release gate — graduate from development tests

After both services are running, verify the **actual Linux process state**
instead of assuming tests mean the host is ready:

~~~bash
bash start.sh --full release --scope local
~~~

The release gate checks: all 1,000 private agent identities, protected
operator credentials, SQLite integrity for both communication databases,
at least 50 MiB free on the selected Linux/USB storage volume, the real
phone and MCP processes, and that the MCP refuses requests without
authentication. A successful report has `"ready": true` for
`"scope": "local"` and exits with code 0.

You can also request the **entire production** checklist:

~~~bash
bash start.sh --full release --scope all
~~~

This deliberately fails until outside-network HTTPS, delegated public
email/SMTP, and actual carrier phone routing have been verified. No
internal unit test can substitute for those live external dependencies.
Passing the *local* release gate does not turn a local inbox into a
working `@public-domain` address or allocate mobile telephone numbers.

## Optional automatic restart on real Linux

To keep the local services running after Linux login or a process crash,
first install dependencies and pass the local release gate. Then:

~~~bash
# Review the unit before writing any systemd configuration
python3 linux/autostart.py --dry-run

# Write an owner-only non-root user service and start it:
python3 linux/autostart.py --enable

# Inspect it using Linux's own service manager:
systemctl --user status monico-agent.service
journalctl --user -u monico-agent.service -n 50
~~~

For a fixed USB-backed path, pass `--state-dir "/your/USB/path"` to
both the initial install and the autostart script. A missing USB will
**not** cause Monico to generate replacement identities. For public
HTTPS autostart, the installer additionally requires both your actual
`--public-ip` and `--allow-public`; it will not automatically expose
services without your opt-in.

If your host does not run `systemd --user`, the autostart operation
reports an error; local startup remains available through `start.sh`.
A login-bound user systemd manager may stop at logout. True pre-login
autostart requires separately enabling systemd lingering on a native
Linux host, according to local OS policy. **Chromebook Crostini can
suspend or stop independently of any Linux watchdog.** Nothing in this
unit enables carrier SMS, public SMTP, or trusted public DNS.

---

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
