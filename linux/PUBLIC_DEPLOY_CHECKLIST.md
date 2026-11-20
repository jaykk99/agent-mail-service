# Public deploy checklist — agent-mail-service + Calling-linux on Jay's Linux

One page: everything Jay (or the installer) must do to take this stack from
"works on loopback" to "real internet mail + calls". Nothing here needs a
signup by the agent, a card, or a secret the agent can see.

## 0. What is already done (no action needed)

- Wiring branch `feat/calling-linux-wiring-2026-11-20` on both repos.
- All test suites pass here: AMS 104/104, CL security 4/4, phone 72/73
  (1 pre-existing sandbox UDP-block failure), monico-mail-usb 82/82.
- Live loop verified here: SMTP -> Postfix virtual -> Maildir -> IMAP
  login/fetch (TLS :993), plus the stack's own SMTP loopback on :2525.
- Security gaps fixed fail-closed: unsigned inbound-SMS webhook -> 503,
  AMI without AMI_SECRET -> 503. Tests cover both.
- Postfix/Dovecot/Asterisk/coturn/OpenDKIM configs validated live; the
  three permission/config traps found are baked into `linux/config/`.

## 1. Jay-only prerequisites (only Jay can do these)

- [ ] Claim `errorinbox.qd.je` at dash.domain.digitalplat.org (Turnstile
      human check). Until this is done the domain is NXDOMAIN and no DNS
      record can be published. This is the ONLY hard blocker.
- [ ] A Linux box with a public IPv4 address (VPS or home server) and
      root/sudo. The sandbox has no public IPv4; nothing here can be
      tested from the internet until then.
- [ ] Open inbound ports on the box / firewall: 25 (SMTP), 993 (IMAPS),
      5060/UDP (SIP), 3478 TCP+UDP (TURN), 5061 if TLS SIP is used.
      Port 25 outbound must NOT be blocked by the host (some VPS
      providers block it by default; ask them to unblock it).
- [ ] Decide the carrier question (see `carrier-sms-pstn.md`): public
      SMS/calls need a carrier or SIP trunk. No signup is done for you;
      the doc lists exactly what to choose and what config it plugs into.

## 2. Install (on the Linux box, as root)

```bash
git clone https://github.com/jaykk99/agent-mail-service.git
git clone https://github.com/jaykk99/Calling-linux.git
cd agent-mail-service
git checkout feat/calling-linux-wiring-2026-11-20
cd ../Calling-linux
git checkout feat/calling-linux-wiring-2026-11-20
cd ../agent-mail-service
sudo bash linux/install-validate.sh agents.errorinbox.qd.je
```

The script installs the six packages, generates fresh random
CARRIER_HMAC_SECRET / AMI_SECRET / TURN_SECRET into
`/etc/linux-carrier-1000/env` (mode 600), installs the configs, generates
the DKIM key, validates everything, and starts the stack. It prints the
DKIM TXT record to publish (see `dns-tls-pack.md`).

## 3. DNS (after the domain is claimed)

Publish the 5 AgentMail records for `agents.errorinbox.qd.je` exactly as
listed in `~/workspace/agent-mail-outbound/dns-records.md` (that file is
the source of truth; the records are NOT copied here so they cannot drift).
Then publish the self-hosted records from `dns-tls-pack.md`: the DKIM TXT
the installer printed, plus SPF/DMARC for the domain. Verify with:

```bash
dig TXT agents.errorinbox.qd.je
opendkim-testkey -d agents.errorinbox.qd.je -s mail -k /etc/opendkim/keys/agents.errorinbox.qd.je/mail.private
```

## 4. Start + verify

```bash
bash start-all.sh            # phone :8765, mail :3000/:2525, Calling-linux :3001, SIP :5060
bash start-all.sh --status   # all three must say up
python3 phone/sip_probe.py --host 127.0.0.1 --port 5060   # expect 200
python3 linux/smtp-loopback-test.py                       # expect PASS
```

SIP registration gate check (expect 403 for an unauthenticated REGISTER):

```bash
python3 -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'REGISTER sip:127.0.0.1 SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:5099\r\nFrom: <sip:2000@127.0.0.1>\r\nTo: <sip:2000@127.0.0.1>\r\nCall-ID: probe1\r\nCSeq: 1 REGISTER\r\nContact: <sip:2000@127.0.0.1>\r\nContent-Length: 0\r\n\r\n', ('127.0.0.1', 5060)); print(s.recvfrom(2048)[0][:120])"
```

## 5. Go-live criteria (all must be true)

- [ ] `start-all.sh --status`: phone, mail-api, calling-linux all up.
- [ ] SIP probe returns 200; unauthenticated REGISTER returns 403.
- [ ] SMTP loopback test passes; a real message sent to an agent address
      arrives in its Maildir and is readable over IMAP :993.
- [ ] DKIM testkey passes; AgentMail domain shows verified in its console.
- [ ] `bash linux/backup.sh` produces a restorable tarball (mode 600).
- [ ] `linux/health-monitor.sh` is in cron (every 5 minutes).

## What runs here vs what needs the real box

| Check | Sandbox (this run) | Real Linux box |
|---|---|---|
| AMS unit + e2e tests (104) | PASS | re-run after checkout |
| CL security tests (4) | PASS | re-run after checkout |
| Postfix/Dovecot config + live mail loop | PASS (test.local) | re-run with the real domain |
| Stack SMTP loopback (:2525) | PASS | re-run |
| Asterisk AMI on :5038, PJSIP config load | AMI up, no endpoints (embedded SIP serves extensions) | add manager user via installer; SIP probe expect 200 |
| coturn :3478 TCP+UDP listen | PASS | re-run; open the port |
| SIP REGISTER / real call | BLOCKED (sandbox blocks UDP sendto) | run the probe above |
| DKIM sign + DNS verify | key generated, RSA ok | publish TXT, run testkey |
| External mail (port 25 out) | BLOCKED (no public IPv4) | send a real message, check receipt |
| AgentMail both directions | already verified Nov 19 (reuse that evidence) | re-verify after DNS publishes |

## Do not

- Do not merge the branches or open a PR (Jay's call).
- Do not publish the `test.local` DKIM key or the 2-day self-signed test
  cert; generate real ones on the box (the installer does).
- Do not put a real secret in any repo file; secrets live only in
  `/etc/linux-carrier-1000/env` (600) and the vault.
