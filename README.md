# Self-Hosted Linux Agent Mail & Phone Service

A plug-and-play, 100% self-hosted communication stack for **1,000 agent email addresses** and **1,000 phone extensions** on Linux — with **zero third-party API keys**, **zero secret environment variables**, and **zero required domains**.

## Quick Start (Plug and Play)

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

## Tests

```bash
npm run check
npm test
```
