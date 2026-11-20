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
