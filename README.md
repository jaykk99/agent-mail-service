# Self-Hosted Linux Agent Mail & Phone Service

A plug-and-play, 100% self-hosted communication stack for **1,000 agent email addresses** and **1,000 phone extensions** on Linux — with **zero third-party API keys**, **zero secret environment variables**, and **zero required domains**.

## One-command Linux + offline Android (recommended)

For a new Debian/Ubuntu/Chromebook Linux installation, copy and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/jaykk99/agent-mail-service/main/install.sh | bash
```

This installs and starts the **Linux Agent Mail services** on ports
`8765` (dashboard), `8787` (MCP), and **Lin-2-Mux** on `8767`.
USB storage is auto-detected. The installer prints a fresh pairing
code and Linux's direct address: Termux can connect with no mobile
data when it has a local WiFi/hotspot connection or an **authorized
ADB USB connection**. No config edits or paid APIs required.
A Linux USB connection can also serve the Termux installer locally:

```bash
curl -fsSL http://127.0.0.1:8767/install-termux.sh | bash -s -- http://127.0.0.1:8767
```

Run that line on **Termux** only after Linux has configured ADB reverse
and the Termux `bash`, `curl` and `python3` packages are installed.
The browser is local-only by default; public email requires a
registered/delegated domain, SMTP reachability and real external tests.
A Linux HTTP proxy can share Linux internet with proxy-aware Termux
commands, **not with every Android app**. See [Linux/Android details](linux/README.md).

## Alternative legacy Node local app


```bash
bash start.sh
# or
npm install && npm start
```

Open **http://localhost:3000** in your browser. No login token, API key, or secret configuration is required.

At startup, the server automatically provisions on local disk (`./data/`):
- **1,000 Mailboxes**: `agent-0001@agents.local` through `agent-1000@agents.local` (plus free custom aliases via the UI or `POST /api/addresses`)
- **1,000 Phone Extensions**: `2000` through `2999` (`web:2000`–`web:2999`, `sip:2000`–`sip:2999`)
- **Built-in SMTP Receiver**: listening on `0.0.0.0:2525`
- **Auto-generated Local DKIM Key**: stored locally in `./data/dkim.pem` (no secret env vars needed)
- **Generated Linux Telephony & Mail Configs**: written to `./data/linux-configs/` (`pjsip_agents.conf`, `extensions_agents.conf`, `dongle.conf`, `sim-modem-bridge.sh`, `postfix-main.cf`, `setup-linux-host.sh`)

## Free Domain Support

By default, the service uses `agents.local` with no configuration needed. You can switch to any free local or custom domain (`home.lan`, `localhost`, DuckDNS, or your own domain) from the top bar in the web UI or via `POST /api/domain`.

## Real Linux Phone & Email Capabilities

- **Instant Local Email & SMTP**: All 1,000 mailboxes send and receive immediately via the built-in router and SMTP listener (`:2525`), with automatic OTP verification code and link extraction.
- **Browser Voice Calls & SMS**: All 1,000 extensions (`2000`–`2999`) support real-time SMS-style messaging, peer-to-peer WebRTC voice calls, and one-time guest call links (`/call/<token>`).
- **Linux Hardware / SIP Bridge (No 3rd-Party APIs)**: Use the generated `./data/linux-configs/` files to attach local **Asterisk PJSIP** (`:5060`), **Postfix**, or a **USB GSM/4G SIM card modem** (`chan_dongle` / ModemManager `sim-modem-bridge.sh`) for real cellular calls and SMS directly from Linux.
  - Note: Public cellular calling/SMS requires a SIM-card hardware modem or SIP trunk, and direct public internet email delivery requires open port 25 and DNS MX records.

## Relay health, quota & retention (API)

- `GET /api/relay` — outbound relay health. Runs a live SMTP EHLO handshake
  against the configured path and sends no mail: local Postfix is probed
  directly; direct-MX mode resolves the MX of `RELAY_PROBE_DOMAIN`
  (default `gmail.com`) and handshakes with it, which is the check that
  catches outbound port 25 being blocked. Answers 200 when usable, 503
  when unconfigured (local-only mode) or the probe fails.
- `GET /api/quota` — global + per-address usage: sends per address (hourly
  and last-24h buckets), receives last 24h, stored inbox counts, and
  address creations per hour. `GET /api/quota/:address` reports one
  address (400 bad format, 404 unknown address). Reads never consume quota.
  Counters are in-memory and reset on restart; stored inbox counts survive
  restarts on disk. Limits are env-configured and `0` means unlimited
  (reporting only, nothing enforces them yet):
  `SEND_MAX_PER_ADDRESS_PER_HOUR`, `SEND_MAX_PER_ADDRESS_PER_DAY`,
  `ADDRESS_CREATE_MAX_PER_HOUR`, `RELAY_PROBE_TIMEOUT_MS` (default 10000),
  `RELAY_PROBE_DOMAIN` (default `gmail.com`).
- Retention: mail older than `RETENTION_DAYS` (default 30) is pruned by
  server-side arrival time (`receivedAt`), not the sender-supplied Date
  header, on every store and on boot. The dashboard shows relay health and
  the selected mailbox's quota.
- Address validation: the TLD must be 2–63 alpha characters, so numeric or
  single-character TLDs (`user@host.123`) are rejected at send, inbox-read,
  and quota time.

## Tests

```bash
npm run check
npm test
```
