# Calling-linux → Agent Mail Service integration

This integration takes **real, useful self-hosted components** from
[jaykk99/Calling-linux](https://github.com/jaykk99/Calling-linux) while
keeping public-network claims honest.

## What's integrated

1. **Fleet metadata:** `phone/calling_linux_import.py` reads a local
   `Calling-linux/data/carrier-state.json` export and imports only 80-character
   validated display labels, mapping legacy extensions **1–1000** to Monico's
   persistent extensions **2000–2999**. It NEVER copies fake E.164 numbers,
   seeded OTPs, demo SMS history, delivery counters, unverified routes or
   credentials. The existing Monico API/SIP passwords do not change.
2. **Directory integration:** Authenticated `GET /api/me` and
   `GET /api/directory` return the imported `displayName` and
   `webPhoneNumber` for browser calling. Public PSTN/SMS routing remains
   explicitly `false`.
3. **Real SIP health probe:** `phone/sip_probe.py` adapts the
   `Calling-linux` SIP OPTIONS concept into a UDP packet exchange with a
   real server response and matching Call-ID. Unlike the source demo's seeded
   status, the probe only passes when a SIP peer actually answers.
4. **Existing Linux voice stack:** Monico already generates unique Asterisk
   PJSIP credentials and internal routing for extensions 2000–2999 in
   `phone/provision.py`. The separate public HTTPS gateway, WebRTC guest
   links, and optional Linux Coturn relay are described in
   [phone/PUBLIC_ACCESS.md](phone/PUBLIC_ACCESS.md).
5. **Independent mail service:** Monico's
   [monico-mail-usb/DEPLOYMENT.md](monico-mail-usb/DEPLOYMENT.md) stages
   Postfix/Dovecot for separately authenticated email addresses.
   `Calling-linux` simulated SMTP notifications were not imported.

## Live wiring (both servers on one Linux box)

The two projects are now wired together at runtime, not just by a one-off
label import. Full run book: [RUN_ON_LINUX.md](RUN_ON_LINUX.md).

- **One command:** `bash start-all.sh` brings up the phone server (:8765),
  the mail API + SMTP (:3000 / :2525) and Calling-linux (:3001, SIP :5060,
  SMTP :2526).
- **Live bridge:** `phone/calling_linux_bridge.py` reads Calling-linux
  capabilities, fleet labels and its e2e self-test over HTTP
  (`CALLING_LINUX_URL`, default `http://127.0.0.1:3001`). The phone
  server exposes `GET /api/calling-linux/status` (agent auth) and reports
  `callingLinux: {live, sip, smtp, turn, imap}` in `/health`; down means
  `live: false`, never invented counts.
- **Dovecot mailboxes:** `phone/calling_linux_mailboxes.py` generates real
  per-agent mailboxes from the provisioned identities: a `dovecot-users`
  passwd file with real SHA512-CRYPT hashes, a `credentials.json` for
  Calling-linux imap-sync, and a `make-maildirs.sh` for the shared
  Maildir root `/var/mail/vhosts/<domain>/<local>`.
- **SIP identities:** `phone/provision.py` also writes
  `pjsip_calling_linux_map.conf`, a username-only map (Monico ext ->
  `did_1201555XXXX`). No passwords in it.
- **TURN:** one shared secret, `PHONE_TURN_SECRET` (Monico) and
  `TURN_SECRET` (Calling-linux) are aliases; host from `PHONE_TURN_IP`
  or `TURN_URL`.
- **Agent Mail panel:** Calling-linux's dashboard has an Agent Mail tab
  backed by `GET /api/agent-mail/status`, which proxies the mail API
  `/health` (`AGENT_MAIL_URL`, default `http://127.0.0.1:3000`) and shows
  real counts or `not live`.
- **REGISTER gate:** Calling-linux's embedded SIP REGISTER handler refuses
  unauthenticated REGISTER (403) unless `SIP_ALLOW_UNAUTH_REGISTER=1` is
  set explicitly on localhost. OPTIONS still answers. Seeded demo OTPs,
  counters and the seeded message were stripped; counts start at 0.

## Linux setup and smoke tests

First run the agent application locally and create 1,000 real **private**
identities (no phone carrier involved):

```bash
cd ~/agent-mail-service
git pull
bash start.sh
```

Optionally clone your separate fleet repository into your home directory:

```bash
cd ~
git clone https://github.com/jaykk99/Calling-linux.git
cd ~/agent-mail-service
```

Review how many labels would be imported without modifying anything:

```bash
python3 phone/calling_linux_import.py \
  --source "$HOME/Calling-linux/data/carrier-state.json"
```

If correct, apply the import to the previously initialized, automatically
selected Monico storage volume (USB when securely supported):

```bash
python3 phone/calling_linux_import.py \
  --source "$HOME/Calling-linux/data/carrier-state.json" --apply
bash start.sh --stop
bash start.sh
```

If you use an explicit storage folder, include `--state-dir
/path/to/existing/monico-state`. Never point at an unfamiliar or
world-readable folder. Once imported, the mapping is stored in a private,
mode-0600 `calling-linux-labels.json` file. To change it, back it up and
review the new source; the importer refuses silent overwrite.

**Verify a real Linux SIP listener, if installed:** The existing Monico
`pjsip_agents.conf` and `extensions_agents.conf` are staged for a real
Asterisk install. Test the server's actual SIP response:

```bash
python3 phone/sip_probe.py --host 127.0.0.1 --port 5060
```

You can run this on a separate, authorized Linux machine against your
reachable SIP server to test network access. A SIP `401` challenge also
shows that SIP responded. This does **not** prove successful registration,
audio transport, a carrier-assigned number or public phone calls.
Calling-linux's demo SIP registrar refuses unauthenticated REGISTER by
default (`SIP_ALLOW_UNAUTH_REGISTER=0`); do not opt in on a public host.

For the public **Monico browser application**, follow
[phone/PUBLIC_ACCESS.md](phone/PUBLIC_ACCESS.md) to create an IP-address TLS
certificate, bind your host with deliberate authorization, configure the
router and test from an unrelated network with `phone/probe_public.py`.

## What remains impossible to fake

- The `+1 201-555-xxxx` values in Calling-linux are **demonstration
  identifiers**, not assigned mobile DIDs. Linux can create unlimited app IDs
  and SIP URIs, but a normal phone network will not route to them on that
  basis.
- Incoming carrier SMS and calls need a real, authorized connection to the
  telecom network, such as a carrier/SIP trunk or a cellular modem with
  active SIM service. Installing Asterisk alone is not enough.
- Internet email to ordinary mail providers requires delegated DNS/MX,
  publicly routable SMTP and a reputation/trust setup. A fake domain or a
  local-only SMTP listener will not replace this.
- The public HTTPS Monico app can operate at an IP address with no purchased
  domain, provided the machine is actually reachable. Browser trust may
  require a trusted CA; an own CA needs explicit installation by managed
  clients.
- Chromebook Linux sleep, ISP CGNAT, blocked ports and filesystem ownership
  are physical/network constraints, not code defects.

## Test status

Run `python3 -m unittest discover -s test -p 'test_phone*.py' -v` (includes
the bridge, mailbox and TURN-alias tests in `test_phone_calling_bridge.py`
and `test_phone_calling_mailboxes.py`).
GitHub Actions verifies metadata import and authenticated directory output
with no forged public numbers, and performs actual loopback UDP SIP OPTIONS
and HTTPS API tests. Public internet connectivity, telephone calls, SMS,
and external mail can only be verified when the corresponding live
infrastructure is available.
