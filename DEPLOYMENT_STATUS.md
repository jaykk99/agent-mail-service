# Monico Agent Mail Service — Linux release status

Status: **LOCAL LINUX RELEASE GATE PASSED**.
Status: **PUBLIC INTERNET PRODUCTION DEPLOYMENT NOT YET VERIFIED**.

## Verified at the current code revision (November 20, 2026)

- 57 phone/network tests passed.
- 23 Linux service/release/autostart tests passed.
- 83 Monico mailbox/MCP tests passed on Python 3.11 and 3.13.
- Actual three-service Linux startup, authenticated MCP checks, local HTTPS
  service, storage protections, account persistence and restart passed.
- Linux systemd user-unit syntax verified with `systemd-analyze verify`.
- **Actual Ubuntu 24.04 mail protocol integration passed:** an agent
  registered with the real Monico SQLite registry, Postfix authenticated
  SMTP submission over TLS and accepted its test message, and Dovecot 2.3
  delivered it via LMTP and made it visible in the authenticated IMAP inbox.

Relevant GitHub Actions evidence:

- [Full Linux phone / local release gate](https://github.com/jaykk99/agent-mail-service/actions/runs/44789980593)
- [Mailbox and MCP tests](https://github.com/jaykk99/agent-mail-service/actions/runs/44789980590)
- [Real Postfix → Dovecot → IMAP test](https://github.com/jaykk99/agent-mail-service/actions/runs/44789980537)

The Postfix proxy-read map had been missing the required explicit
`proxy_read_maps` permission for the sender-login SQLite lookup. This
was fixed in the generated configuration and verified by the actual
SMTP/LMTP/IMAP integration, not a mock.

## Expanded real-mail validation (three independently named agents)

The [expanded real agent mail test](https://github.com/jaykk99/agent-mail-service/actions/runs/44796213179)
ran actual Ubuntu Postfix/Dovecot processes, not mocks. It verified
three independent mailbox logins over TLS, cross-agent SMTP delivery into
real IMAP inboxes, inbox isolation, blocked unauthorized SMTP, blocked
wrong passwords, blocked sender impersonation and immediate password
revocation after rotation. No outside mailbox provider was used. The latest successful run also
called Monico's own production `SelfHostedMail.send`, `inbox`, `read`
and `sent` methods against those running services, and verified
agent-token crossover is rejected. This exercises the application's
actual SMTP/IMAP integration, not just raw test-library clients.

These tests establish **real local Linux SMTP/LMTP/IMAP functionality**.
They do not prove public email to another domain, 1,000 simultaneous active
sessions, or availability from the user's Chromebook.

## Independent public internet test from a GitHub-hosted Linux runner

An explicit opt-in [outside-network probe workflow](https://github.com/jaykk99/agent-mail-service/actions/workflows/monico-external-network-probe.yml)
is available. It can verify your real server from a **different network**,
rather than trusting the host's own localhost test.

1. First deploy Monico's HTTPS gateway to a **genuinely routable IPv4** you
   control, with TCP 8766 forwarded and the generated public CA certificate
   installed or available. Run `bash start.sh --public status` on your host
   to locate the `public_ca_certificate` file.
2. On Linux, encode **only the public CA certificate**:
   `base64 -w0 /path/to/monico-ca.crt`. Never submit a private key,
   agent token, mailbox password or operator API key.
3. In GitHub Actions choose **Monico independent public network probe**
   → **Run workflow**, providing that public IP, port, and the base64 public
   CA. Optionally supply a real delegated mail domain for DNS/MX, public
   SMTP port 25, submission TLS 587 and IMAPS 993 checks.
4. Review the checks. The workflow fails closed on TLS mismatch, a
   private IP, an unreachable server, missing mail DNS or blocked ports.
   No mailbox credentials are sent to the runner.

This workflow **cannot be run meaningfully until the user's host actually
has a reachable address**; none has been supplied or verified yet.
The external mail probe never sends a message and cannot by itself certify
cross-domain delivery. Regular carrier phone calling still requires a real
telecom interconnect.

## 1,000-agent real HTTP load verification

The independent [Ubuntu Linux scale run](https://github.com/jaykk99/agent-mail-service/actions/runs/44799691874)
passed **all three GitHub Actions jobs**, including the actual 1,000-agent
HTTP messaging test. Against the real Python HTTP service and SQLite backend:

- 1,000 distinct agents authenticated through the HTTP API with their
  individual bearer tokens.
- 1,000 HTTP text messages were sent and routed to 1,000 different inboxes.
- 1,000 inboxes were read back, with expected sender and recipient data.
- SQLite contained 1,000 durable messages from 1,000 distinct senders
  to 1,000 distinct recipients.
- After a real server shutdown and restart, sampled inbox messages,
  agent identities, and credentials remained valid.
- An unauthenticated request was denied.
- With **16 client workers** on GitHub-hosted Ubuntu, measured execution
  was 1.27s for authentication, 2.15s to send, and 1.41s to read. These
  are runner-specific observations, not guaranteed production performance.

Scope limitation: this exercised actual HTTP and SQLite on a **loopback
test host**, not 1,000 simultaneously connected clients or external internet
mail delivery. The site is not marked publicly reachable by these results.

## Local Linux launch

```bash
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service
bash linux/install.sh
bash start.sh --full status
bash start.sh --full release --scope local
```

The release gate exits zero only if running services, anonymous MCP
access denial, protected storage, data integrity and local disk capacity
pass on the actual Linux host. This cannot be inferred from GitHub CI:
the host must execute the command itself.

Optional user-systemd restart on Linux with `systemd --user`:

```bash
python3 linux/autostart.py --dry-run
python3 linux/autostart.py --enable
systemctl --user status monico-agent.service
```

Chromebook Crostini may still suspend independently of systemd.

## Independent internet verification result — November 20, 2026

The repository's legacy Cloudflare Email Worker configuration references
`https://agent-mail-service.onrender.com/api/inbound`. We therefore tested
the historical Node backend's public `/health` endpoint from an unrelated
GitHub-hosted Linux runner, using normal HTTPS certificate validation and
no authentication secrets.

**Observed result:** HTTP **503 Service Unavailable** on **three attempts**.
The historical hosted Node API did **not** pass public availability
verification in this run. This is a point-in-time observation, not proof
that it can never recover or that a different Monico Linux host is offline.

- [External Linux probe run and response codes](https://github.com/jaykk99/agent-mail-service/actions/runs/44799802062)
- [The exact probe source](linux/probe_legacy_public.py)
- [The independently runnable check](.github/workflows/monico-historical-public-check.yml)

**Important:** That Render URL refers to the older Node API, not to the
new Postfix/Dovecot/MCP Linux server. The Linux server's real public URL/IP,
trusted CA and working network route have not been established in this repo,
so independent internet reachability for Monico Linux is **not verified**.

The separate [outside-network Linux mail/browser workflow](.github/workflows/monico-external-network-probe.yml)
can test an *actual user-controlled* public IPv4 and public CA certificate.
Never provide or commit the CA private key, mailbox password, or admin tokens.

## What still blocks public production approval

1. **Internet mail:** An actual domain controlled/delegated by its parent,
   working MX/A/AAAA, PTR, SPF, DKIM and DMARC, installed and permissioned
   Postfix/Dovecot with trusted TLS and successful external send and receive
   tests over public SMTP port 25. The actual integration test used only
   an isolated disposable Ubuntu runner, not the user's mail host.
   Dovecot 2.4 also needs separately validated installation.
2. **Public browser:** A real reachable IP, inbound route/firewall permissions,
   TLS trust on client devices, and successful outside-network tests using
   `phone/probe_public.py`. Local HTTPS tests are not enough.
3. **Voice:** SIP authentication, RTP/WebRTC real audio between unrelated
   networks, and operational TURN with appropriate ports and abuse limits
   still need live testing. Phone extensions are internal.
4. **Telephone carrier/SMS:** An authorized PSTN/SMS interconnect and real
   assigned numbers. Linux cannot make invented E.164 numbers globally
   routable without a carrier network.
5. **Reliability:** Persistent always-on host, secure off-host encrypted
   backups, monitoring, controlled service rollout and secret rotations,
   and an independent recovery test.

`bash start.sh --full release --scope all` deliberately fails until real
external checks are completed. Do not label this repo as delivering public
PSTN, public SMS or globally routable mail on Linux alone.
