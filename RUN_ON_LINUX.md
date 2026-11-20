# Run the wired stack on Linux

One box, three services, no cloud, no paid carrier, no API keys.

| Service | What it is | URL / ports |
| --- | --- | --- |
| Agent phone | internal extensions 2000-2999, internal mail | http://127.0.0.1:8765 |
| Agent mail API + SMTP | agent inboxes, verification-mail API | http://127.0.0.1:3000, SMTP :2525 |
| Calling-linux | carrier dashboard, SIP registrar, SMTP listener, IMAP sync | http://127.0.0.1:3001, SIP UDP :5060, SMTP :2526 |

Calling-linux runs on **:3001** (not :3000) and its embedded SMTP on **:2526**
(not :2525) so it never clashes with the mail API on the same box.

## Quick start (localhost, no domain needed)

```sh
git clone https://github.com/jaykk99/agent-mail-service.git
git clone https://github.com/jaykk99/Calling-linux.git
cd agent-mail-service
bash start-all.sh
bash start-all.sh --status
```

That starts all three in the background (logs in `logs/`, pids in `.run/`).
Stop everything with `bash start-all.sh --stop`.

Check the wiring live:

```sh
curl -s http://127.0.0.1:8765/health
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3001/api/system/capabilities | head -c 400
curl -s http://127.0.0.1:3001/api/agent-mail/status
```

The phone server's bridge endpoint needs an agent bearer token:

```sh
# token for extension 2000 lives in the phone state dir (identities.json)
curl -s http://127.0.0.1:8765/api/calling-linux/status \
  -H "Authorization: Bearer <agent-2000-apiToken>"
```

It reports `{live, sip, smtp, turn, imap, e2e}` from Calling-linux, or
`live: false` when the dashboard is down. Nothing is invented: when
Calling-linux is down the answer is `live: false`, not fake counts.

## What is wired

- **Live bridge** (`phone/calling_linux_bridge.py`): the phone server reads
  Calling-linux capabilities, fleet labels and its own e2e self-test over
  HTTP (`CALLING_LINUX_URL`, default `http://127.0.0.1:3001`). Down, slow
  or malformed replies surface as `live: false`.
- **Fleet labels**: Calling-linux display labels are the source of truth for
  agent display names (legacy ext 1-1000 map to Monico ext 2000-2999).
  Numbers, OTPs, counters, routes and credentials are never imported.
- **SIP identities**: `phone/provision.py` also writes
  `pjsip_calling_linux_map.conf`, a username-only map
  (Monico ext -> `did_1201555XXXX`). It contains no passwords, and
  Calling-linux's embedded SIP REGISTER handler refuses unauthenticated
  REGISTER unless `SIP_ALLOW_UNAUTH_REGISTER=1` is set explicitly.
- **Dovecot mailboxes**: `phone/calling_linux_mailboxes.py` generates real
  per-agent mailboxes from the provisioned identities: a `dovecot-users`
  passwd file with real SHA512-CRYPT hashes, a `credentials.json` for
  Calling-linux imap-sync, and a `make-maildirs.sh` that creates the
  shared Maildir tree `/var/mail/vhosts/<domain>/<local>/{cur,new,tmp}`.
  Same root and quota (512M) on both sides; see
  `monico-mail-usb/selfhost/generate_config.py`.
- **TURN**: one shared secret. `PHONE_TURN_SECRET` (Monico) and
  `TURN_SECRET` (Calling-linux) are aliases; the host comes from
  `PHONE_TURN_IP` or `TURN_URL`. Set it once in the shared EnvironmentFile.
- **Agent Mail panel**: the Calling-linux dashboard has an Agent Mail tab
  that proxies the mail API `/health` (`AGENT_MAIL_URL`, default
  `http://127.0.0.1:3000`) and shows real inbox/address counts, or
  `not live` when the mail service is down.

## systemd (persistent, survives reboot)

Units live in `monico-mail-usb/selfhost/systemd-combined/`. Copy them to
`/etc/systemd/system/`, edit the `User=`, `WorkingDirectory=` and
`EnvironmentFile=` lines, then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now agent-mail-phone agent-mail-api calling-linux
sudo systemctl status agent-mail-phone agent-mail-api calling-linux
```

Services run as an unprivileged user, never root. Secrets live in the
EnvironmentFile (mode 0600), never in the unit files.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAIL_DOMAIN` | `localhost` | mail API domain (real domain needed for internet mail) |
| `CALLING_LINUX_URL` | `http://127.0.0.1:3001` | where the phone server finds Calling-linux |
| `AGENT_MAIL_URL` | `http://127.0.0.1:3000` | where Calling-linux finds the mail API |
| `PORT` (Calling-linux) | `3001` in start-all.sh | dashboard/API port |
| `SIP_PORT` | `5060` | Calling-linux embedded SIP UDP |
| `SMTP_INBOUND_PORT` | `2526` in start-all.sh | Calling-linux embedded SMTP |
| `PHONE_TURN_SECRET` / `TURN_SECRET` | (unset) | shared Coturn static-auth-secret (>=32 chars) |
| `PHONE_TURN_IP` / `TURN_URL` | (unset) | public TURN host |
| `SIP_ALLOW_UNAUTH_REGISTER` | `0` | set `1` only on localhost to allow unauthenticated SIP REGISTER |

## Real internet mail and calls (not needed for localhost)

Localhost wiring proves the bridge, SIP OPTIONS, SMTP loopback and IMAP
sync. For the public internet you additionally need, on the Linux host:

- a public IPv4 and open ports 25 (SMTP), 5060 (SIP UDP), 3478 (TURN),
  993 (IMAPS)
- a domain with DNS/MX pointing at the host, plus PTR, SPF, DKIM, DMARC
- Dovecot/Postfix/Asterisk/Coturn installed (Calling-linux's Deployment
  tab generates the configs; its install-script provisioner needs root and
  must be reviewed before running, never run blindly)
- the mailbox provisioning step above (`calling_linux_mailboxes.py`), then
  copy `dovecot-users` to `/etc/dovecot/users` and `credentials.json` to
  `/etc/linux-carrier-1000/credentials.json`

## Honest limits

- No real phone numbers exist anywhere in this system. `+1 201-555-xxxx`
  values are demo identifiers; the public phone network will not route to them.
- No carrier SMS/calls without a SIP trunk or cellular modem.
- No internet email delivery without DNS/MX + routable SMTP + reputation.
- Calling-linux's seeded demo OTPs/counters were stripped; counts start at 0.
