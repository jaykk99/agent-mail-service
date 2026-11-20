# Validation record — "test the rest and do the rest" (2026-11-20)

Branch: `feat/calling-linux-wiring-2026-11-20` (AMS @ 194f5644, CL @ 24e50984
at start of this run). All work below is on that branch; nothing merged,
no PR. Run by the resumption subagent after Jay's 13:05 EST "Yes, go ahead
anyway" lifted the execution-risk flag for this work.

## Environment notes (read first)

- A VM replacement mid-run wiped /tmp AND the apt-installed packages
  (postfix/dovecot/asterisk/coturn/opendkim) and the dead-mirror removal.
  The security-test background run was interrupted with an empty log
  (outcome unknown at the time). Everything was rebuilt from the surviving
  repo state: packages reinstalled, dead mirror removed again, /tmp
  validation env rebuilt, security test re-run clean. Nothing in this
  record relies on the interrupted run.
- The sandbox has no systemd, no public IPv4, and blocks UDP sendto even
  on loopback. Services were started directly (setsid) instead of via
  systemd. That is a sandbox property, not a product gap.

## Test counts (final, re-verified this run)

| Suite | Result |
|---|---|
| AMS `npm test` (unit + e2e + deploy) | 104 ok, 0 fail (exit 0) |
| CL `npm test` (security.test.mjs) | 4 pass, 0 fail, 7.2 s (exit 0) |
| monico-mail-usb | 82/82 OK (verified before the VM wipe; code untouched since) |
| AMS phone suite | 72/73 (1 failure is the known pre-existing sandbox UDP-block test `test_probe_actual_sip_udp_response_not_public_call`, untouched, not faked) |
| Calling-linux `tsc --noEmit` / `npm run build` | PASS / PASS (fresh bundle `index-BgXlt4bt.js`) |
| Mailbox provisioning (test run) | 1,000 extensions, 1,000 dovecot-users entries (real SHA512-CRYPT), 1,000 credentials.json accounts, 0 placeholders |

## Live validation (this run, sandbox)

- Postfix 3.8.6 `postfix check` OK; Dovecot 2.3.21 `dovecot -n` OK;
  OpenDKIM 2.11.0 key generated, `openssl rsa -check` OK; coturn 4.6.1
  listening on 127.0.0.1:3478 TCP+UDP; Asterisk 20.6.0 daemon starts,
  AMI enabled on 127.0.0.1:5038, `pjsip show endpoints` -> no objects
  (stock config has no endpoints; extensions are served by the CL
  embedded SIP on :5060, UDP bound and verified).
- Full mail loop PASS: SMTP :25 accept -> virtual delivery to a real
  Maildir -> IMAP login over TLS :993 -> fetch (subject + body present).
- Stack SMTP loopback PASS (`linux/smtp-loopback-test.py`): account ->
  address -> SMTP :2525 accept -> inbox API returns the message.
- `start-all.sh` smoke test PASS: phone :8765, mail :3000/:2525,
  Calling-linux :3001 (SIP :5060 UDP bound) all up; `--stop` killed all
  listeners (0 left); restart brought all three back up; `--status` all up.
- SIP probe / REGISTER gate: NOT runnable here (sandbox blocks UDP
  sendto). Exact commands for Jay's Linux are in
  PUBLIC_DEPLOY_CHECKLIST.md (probe expect 200, unauthenticated REGISTER
  expect 403).
- External mail attempt: NOT attempted and NOT claimed. Direct port-25
  delivery needs a public IPv4, which the sandbox does not have. Reuse
  the Nov 19 AgentMail both-directions evidence instead.

## Bugs found and fixed during validation (all in-repo, committed)

1. **Postfix smtpd died on every connection** (no banner, connections
   piled in the accept queue). Root cause: `compatibility_level` unset
   made the default `smtpd_relay_restrictions` empty, and no explicit
   restrictions were set, so smtpd exited fatal ("specify at least one
   working instance of: reject_unauth_destination ..."). Fix: set
   `compatibility_level = 3.6` and explicit relay/recipient restrictions
   in the config template (`linux/config/postfix-main.cf`).
2. **Virtual delivery "Permission denied" opening the map.** Root cause:
   the long-lived virtual daemon caches a failed map open, and the map
   dir was under a 770 root-only parent. Fix: traversable perms
   (documented in the config template); a `postfix stop` + `start` is
   required after a permission fix (reload is not enough).
3. **Maildir delivery "Permission denied" creating the file.** Root
   cause: `/var/mail/vhosts` was 2770 root:root, blocking uid 5000
   traversal. Fix: 755 on the vhosts base (installer does this).
4. **IMAP login "[UNAVAILABLE] Temporary authentication failure".**
   Root cause: passwd-file lookups run as the auth worker (`dovenull`),
   not root; the users file lived under a 700 root-only dir. Fix: file
   readable by the auth worker (640 root:dovecot), documented in
   `linux/config/dovecot.conf`.
5. **Inbox API 400 on `@localhost` addresses.** Root cause:
   `validAddressParam` required a dotted domain, so the default local
   domain could receive mail (SMTP accepted it) but never be read back.
   Fix: allow bare `localhost` in `server.js` (one-line regex change).
   Production domains are dotted, so this only affects loopback testing.
6. **AMS e2e test port collision with the running stack.** Root cause:
   the e2e main server used SMTP :2526, the same port Calling-linux
   binds when the stack is up, so the suite failed whenever the stack
   was running. Fix: main test SMTP port moved to 2529 (2527/2528 are
   used by sub-servers inside the same test file).
7. **CL security test never exited.** Root cause: `after()` killed only
   the tsx wrapper; the node server it spawned survived as an orphan
   holding the stdio pipes, so `node --test` hung (4/4 tests had passed;
   the file still failed after 753 s). Fix: spawn detached, kill the
   whole process group in `after()`. Re-run: 4/4 pass in 7.2 s.

## Security gaps fixed (the two from the brief)

1. Inbound-SMS webhook (`cl/server.ts`): returns 503 when no HMAC secret
   is configured (set `CARRIER_HMAC_SECRET` or
   `/etc/apex-carrier.secret` to enable), with a length-safe
   `timingSafeEqual` compare. Verified by test 1 (503 unsigned, no
   secret) and test 3 (200 valid HMAC, 401 bad/missing).
2. Asterisk AMI client (`cl/server.ts`): no hardcoded fallback secret;
   originate returns fail-closed 503 when `AMI_SECRET` is unset.
   Verified by test 2 (503, error names AMI_SECRET) and test 4 (503
   "not running" with a configured secret and no Asterisk).
   Also verified by hand: the old default literal no longer appears in
   `server.ts` (0 fallback lines) or in `src/` (0 references); the
   installer template in `server.ts` generates fresh random secrets
   into `/etc/linux-carrier-1000/env` (600). The stale frontend bundle
   that still contained the old string was rebuilt (`npm run build`,
   new hash `index-BgXlt4bt.js`); `dist/` is untracked.

## What still needs Jay's Linux (not runnable here)

- SIP probe expect 200 / REGISTER gate expect 403 (UDP blocked here).
- DKIM live DNS verification (`opendkim-testkey`) after the TXT publishes.
- Real external mail (needs public IPv4 + unblocked port 25).
- Dovecot/Coturn/Postfix under systemd (no systemd in the sandbox).
- The domain claim (`errorinbox.qd.je`, DigitalPlat Turnstile, Jay only).
- The carrier choice (see `carrier-sms-pstn.md`).

## Files added this run

- `ams/linux/config/` — postfix-main.cf, dovecot.conf, turnserver.conf,
  asterisk-manager.conf (validated templates, placeholders only).
- `ams/linux/install-validate.sh` — one-command install + validate.
- `ams/linux/backup.sh` — timestamped restorable backup (mode 600).
- `ams/linux/health-monitor.sh` — 5-minute cron health check + restart.
- `ams/linux/smtp-loopback-test.py` — :2525 loopback test (PASS here).
- `ams/linux/PUBLIC_DEPLOY_CHECKLIST.md`, `dns-tls-pack.md`,
  `carrier-sms-pstn.md`, `VALIDATION.md` (this file).
- `cl/test/security.test.mjs` — 4 fail-closed security tests.
