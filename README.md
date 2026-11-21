# Agent Mail Service

**Deployment status:** The Monico Linux mail transport has passed real Ubuntu
Postfix → Dovecot → IMAP integration tests. The public Internet host is **not
verified live**. The historical Render Node API returned repeated HTTP 503
responses and is a separate optional backend. See the
[verified deployment report](DEPLOYMENT_STATUS.md) and
[Render recovery guide](RENDER_RECOVERY.md). A green GitHub CI run is not a
public mail or telephone network connection.

## Run the complete LOCAL agent communication stack on Linux

The older `bash start.sh` launches the phone/internal-message service only.
To install and launch **both** the phone server and named-mail MCP server
on your own Debian/Ubuntu/Chromebook Linux:

```bash
bash linux/install.sh
# Or, when python3-venv is installed:
bash start.sh --full up --install

bash start.sh --full doctor
bash start.sh --full invites --count 5
bash start.sh --full claim --name research
```

The combined launcher keeps account credentials in private persistent Linux/USB
storage, starts the local dashboard on `127.0.0.1:8765` and mailbox MCP on
`127.0.0.1:8787/mcp`. Restart with `bash start.sh --full up`, check
`bash start.sh --full status`, and stop with `bash start.sh --full stop`.

To **opt in to self-hosted public HTTPS** for Monico browser users:

```bash
# Replace the example with your own genuinely routable public IPv4 address.
bash start.sh --public prepare --public-ip YOUR_ACTUAL_PUBLIC_IPV4
bash start.sh --public up --allow-public
bash start.sh --public doctor
```

Or start all three processes at once after installing dependencies:

```bash
bash start.sh --full up --public-ip YOUR_ACTUAL_PUBLIC_IPV4 --allow-public
```

External clients must trust the public CA certificate created by Monico,
and a router/ISP path must actually reach Linux TCP 8766. Use the included
independent-network `phone/probe_public.py` for a real reachability check.
**Local startup and GitHub CI do not establish a live internet URL.**
This HTTPS gateway does not enable ordinary public email or mobile SMS.

See [Linux installation and diagnostics](linux/README.md).
**This starts the local agent system, not public SMTP, public mobile SMS,
public telephone numbers, or a verified outside-network service.**

---

## Use the Calling-linux project

I've integrated the **safe, self-hosted** parts of
[jaykk99/Calling-linux](https://github.com/jaykk99/Calling-linux):
fleet display labels from its 1,000 extensions and an actual SIP OPTIONS
connectivity test. Monico retains its own permanent identities and credentials.

```bash
# Optional: separately clone your Calling-linux reference app
git clone https://github.com/jaykk99/Calling-linux.git ~/Calling-linux

# From inside ~/agent-mail-service, inspect then apply the label mapping:
python3 phone/calling_linux_import.py \
  --source "$HOME/Calling-linux/data/carrier-state.json"
python3 phone/calling_linux_import.py \
  --source "$HOME/Calling-linux/data/carrier-state.json" --apply

# Verify a real local Asterisk/SIP server is responding:
python3 phone/sip_probe.py --host 127.0.0.1 --port 5060
```

See [CALLING_LINUX_INTEGRATION.md](CALLING_LINUX_INTEGRATION.md)
for prerequisites, safe migration, and limitations. Calling-linux's
generated `+1 201-555-...` records are demonstration values;
**they are not assigned public carrier numbers**. Public Monico browser
access is a separate feature, explained below.

---

## Public browser access (self-hosted Linux, no purchased domain)

The Monico application can serve its **1,000 internal agent extensions**
over HTTPS to clients outside your local network. This is a real HTTPS
gateway for Monico browser sessions, **not** 1,000 mobile/PSTN numbers or
carrier SMS, and does not make `@agents.invalid` deliverable from Gmail.

On the Linux server, after configuring an actual publicly routable IPv4
address and router/firewall access to TCP 8766:

```bash
sudo apt-get install -y openssl
python3 phone/public_gateway.py --public-ip YOUR_PUBLIC_IPV4 --prepare
python3 phone/public_gateway.py --public-ip YOUR_PUBLIC_IPV4 --serve --allow-public
```

Your managed client devices must trust the generated **public CA certificate**
(or use an independently issued trusted IP TLS certificate). Never share
the private key. The service can then be reached at
`https://YOUR_PUBLIC_IPV4:8766` **only if** the network route actually works.

Verify from an **external network** using:

```bash
python3 phone/probe_public.py \
  --url https://YOUR_PUBLIC_IPV4:8766 \
  --ca-cert /path/to/monico-ca.crt
```

For browser calls between separate networks, the repo also includes
self-hosted Coturn configuration; this also requires publicly reachable
ports. Without a public route, an external relay/network would be needed.
Chromebook Linux's local port forwarding alone does not provide such a route.

See [phone/PUBLIC_ACCESS.md](phone/PUBLIC_ACCESS.md) for details and security
constraints. **Passing offline tests doesn't mean your public address is live.**

---

## Carrier-free WebPhone numbers for every agent

Agents can now use self-hosted WebPhone IDs `web:2000` through `web:2999`.
From the Linux dashboard (`http://localhost:8765`), sign in to an agent and
choose **Create a one-time guest calling link**. Anyone who can reach your
Linux server through that link can exchange private messages and place a
browser-based WebRTC call without a SIM or paid telephony API. Links expire,
are single-use and are restricted to the invited agent. The agent can also
create guest links using MCP tool `webphone_guest_invite` and read their ID
using `webphone_number`.

These IDs are **not** real cellular numbers. To access a link remotely,
the Linux service requires a reachable address and trusted HTTPS. A link
containing localhost only works on the same device; public accessibility
and cross-NAT voice are not automatic. For more information see
[WebPhone setup](phone/README.md).

## Public agent network from Linux (without buying a domain)

The 1,000-agent local messaging/phone application can now be exposed to
remote Monico clients using either your own **public-IP HTTPS server** or
an **optional public Tor .onion service** when you lack inbound public IP
routing. Public IP HTTPS requires a route/port-forward and TLS trust.
Tor requires Tor-capable clients and depends on the volunteer Tor network.
Neither route creates normal carrier phone numbers, carrier SMS, or
publicly deliverable email addresses.

See [public Linux deployment choices](phone/PUBLIC_ACCESS.md).
The local Linux server continues to work with no internet connection.

---

## Zero-setup Linux mode: 1,000 internal phones, email and messaging

The free **private agent network** runs entirely on Linux using Python 3's
standard library and SQLite, with no phone provider, cloud API, npm or pip:

~~~sh
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service
bash start.sh
~~~

After the first clone, \`cd agent-mail-service && git pull && bash start.sh\`
updates and starts the same installation. The launcher runs in the background
and the dashboard opens at **http://localhost:8765**.

- \`bash start.sh --list-usb\`: discover all USB folders Linux can access.
- \`bash start.sh --status\` / \`bash start.sh --stop\`: check or stop local service.
- \`bash start.sh --mcp 2000\`: run an agent's stdio MCP connector.
- **Private domain:** \`agents.localhost\` (when supported by OS/browser).
- **Agent email:** \`agent-0001@agents.invalid\` through
  \`agent-1000@agents.invalid\`, with additional aliases via MCP.
- **Agent phones:** internal extensions \`2000\`–\`2999\`; internal SMS-style
  texts and private call signaling. No carrier connection.

USB storage is automatically selected **only if** one accessible drive can
enforce private Linux file permissions; otherwise data stays safely inside
Linux. The chosen location and 1,000 credentials are preserved across
restarts. See **[Linux setup and limitations](phone/README.md)**.

**This is not a public email or mobile phone provider.** Public domains, MX
routing and deliverability require DNS and an internet-reachable mail server.
Real SMS/calls and real telephone numbers require a SIM/carrier-connected
modem or telecom provider. None of those public services can be conjured
from a USB storage device or a Linux script alone.

---

A free, self-hosted mail domain for AI agents. Each agent signs up by itself,
gets its own API key and its own addresses on your domain, receives real
internet mail over SMTP (provider signups, verification codes, magic links)
and reads it back through a small REST API — no Gmail, no temp-mail, no
per-seat cost. One deployment serves thousands of agents: inboxes are
namespaced per account, API keys are stored hashed, and outbound mail is
DKIM-signed so it is deliverable.

## Architecture

- **`server.js`** — the whole service:
  - **SMTP server** (default port 2525) receives incoming mail and parses it
    with `mailparser`, extracting subject, text body, URLs, and attachment
    metadata. Messages over 10 MB are rejected.
  - **HTTP inbound** (`POST /api/inbound`) accepts parsed mail as JSON
    `{ to, from, subject, text, html }` from an optional HTTPS forwarder.
    This is the path internet mail actually takes in production: Render web
    services cannot expose the SMTP port publicly, so Cloudflare Email
    Routing receives at the MX and the worker delivers over HTTPS. Auth is
    `Bearer $AGENT_MAIL_INBOUND_SECRET` (falling back to the API token when
    the secret is unset); both stores land in the same inbox store.
- **`cloudflare/email-worker/`** — ready-made Cloudflare Email Worker for
  that path: catch-all Email Routing, `postal-mime` parsing, code/link
  extraction, delivery to `/api/inbound`, and an optional agent webhook. See
  [Catch-all receiving](#catch-all-receiving-with-cloudflare-email-workers-free).
  - **REST API** (default port 3000, Bearer-token auth, 50 KB request-body
    cap) lists inboxes, fetches full emails, polls or long-polls for
    verification links, and clears inboxes. Requests are logged as
    structured JSON lines with a per-request id.
  - **Accounts (multi-tenant)**: `POST /api/accounts` mints a free account
    and exactly one API key (only its SHA-256 hash is stored). An account key
    sees only the addresses that account created and can only send `From`
    them; the master token sees everything. This is what lets one deployment
    serve thousands of independent agents.
  - **Storage**: Supabase tables `agent_emails` (mail), `agent_accounts` and
    `agent_addresses` (accounts + address ownership) when `SUPABASE_URL` and
    `SUPABASE_SERVICE_KEY` are set, otherwise in-memory Maps (local dev only —
    data is lost on restart). See `supabase-migration.sql`.
- **`render.yaml`** — declarative Render web service config (the Railway
  trial expired; production deploys from here).
- **`supabase-migration.sql`** — one-time, idempotent SQL for the
  `agent_emails` table (including the `attachments` metadata column).

## Run locally

```sh
npm install
npm test     # unit tests, then local e2e tests (in-memory storage, no network)
npm run check
npm start    # API on PORT (3000), SMTP on SMTP_PORT (2525)
```

Default token is `dev-token-change-me` — the server warns at boot if it is
still the default. Set `AGENT_MAIL_TOKEN` to a long random token.

## API

`GET /health`, `GET /dashboard`, `GET /api/dns` and `POST /api/accounts`
(free signup) are open. Everything else requires a Bearer credential: either
the master token `AGENT_MAIL_TOKEN`, or an account API key from
`POST /api/accounts`. The master key is admin (every address, every account);
an account key is scoped to the addresses that account created. Address path
parameters are validated (`local@domain` shape, max 254 chars); malformed
ones get a 400, and another account's address answers 404.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | `{ ok, domain, storage, addresses, relay, outbound, outboundConfigured, webhook, addressTtlHours, retentionDays, deadLetters, retryQueue }` (no auth) |
| POST | `/api/accounts` | free signup: `{ name? }` -> `{ account, apiKey }` (key shown once) |
| GET | `/api/me` | caller identity + usage (account key, or master summary) |
| GET | `/api/quota` | quota usage for the caller: per-address send/receive buckets, address-creation bucket, global daily send cap (account-scoped; master sees all) |
| GET | `/api/quota/:address` | quota usage for one address (`sendPerHour`, `receivePerHour`, each `{ limit, used, remaining, resetAt }`) |
| GET | `/api/accounts` | every account with usage counts (master only) |
| GET | `/api/dns` | MX/SPF/DKIM/DMARC records to publish (no auth) |
| POST | `/api/inbound` | Worker delivery only: `{ to, from, subject, text, html, messageId?, date? }` -> `{ ok, stored, id?, duplicate? }` (Bearer inbound secret) |
| POST | `/api/addresses` | `{ prefix }` -> `{ address }` (rate limited, prefix max 64 chars) |
| GET | `/api/addresses` | known addresses with inbox counts + created/last-seen |
| POST | `/api/send` | `{ from, fromName?, to, subject, text, html? }` -> `{ messageId, provider }` (From must be an address this service created; sent via the SMTP relay or a Resend/Brevo API key) |
| GET | `/api/inbox/:address` | paginated, searchable email list (see below) |
| GET | `/api/inbox/:address/:id` | full email (subject, body, links, attachment metadata) |
| GET | `/api/wait/:address?since=&from=&timeoutMs=` | **one call does it all**: waits for the next email and returns it in full with `code` (best one-time code), `link` (best action link), `email.codes`, `email.bestLinks` |
| GET | `/api/code/:address?from=&since=` | newest one-time code (immediate): `{ code, codes, emailId, subject, from }` |
| GET | `/api/code/:address/wait?from=&since=&timeoutMs=` | long-poll for a code |
| GET | `/api/verify-link/:address?from=&since=` | best verification link of the newest email that has one (immediate) |
| GET | `/api/verify-link/:address/wait?from=&since=&timeoutMs=` | long-poll for a link (default 30s, max 120s) — no busy-polling |
| GET | `/api/dead-letters` | emails that exhausted store retries (last 50) |
| DELETE | `/api/inbox/:address` | clear inbox |
| GET | `/dashboard` | local browser UI for addresses + inboxes (no auth page; token stays in sessionStorage) |

### Codes, links and waiting

- **One-time codes** are pulled from the subject and body: `483921`,
  `123 456`, `123-456`, a code alone on the line after "Your code is:", and
  6-8 character codes like `K7Q2M9`. Phone numbers, years, prices and URLs
  are ignored. Codes are worked out when mail is read, so older mail has
  them too and no database change is needed.
- **Links** come from `href` values in the HTML as well as the text (many
  verification links exist only behind a "Verify email" button), with
  `&amp;` decoded. `links` keeps arrival order; `bestLinks` ranks them so
  the action link is first and logos, tracking pixels, social and
  unsubscribe links are last. `verify-link` never returns one of those.
- **`since=<ISO time>`** on `inbox`, `code`, `verify-link` and `wait` hides
  mail stored before that moment. Record the time, trigger the email, then
  wait with `since` so an older message is never mistaken for the new one.
- **Waiting is instant**: long-polls wake the moment mail is stored instead
  of on the next 2-second poll.
- **Duplicates**: a delivery retried with the same `messageId` (HTTP
  inbound) or `Message-ID` header (SMTP) is acknowledged and stored once.
- **Addresses survive restarts**: with Supabase, accounts and address
  ownership are stored in `agent_accounts`/`agent_addresses`, so an agent
  keeps its inbox, its quota usage and its ability to send after a restart
  (or after a free Render instance sleeps and wakes).

### Inbox pagination + search

Both pagination styles are supported; when `limit`/`offset` are present
they take precedence, otherwise `page`/`per_page` are used:

- `?page=1&per_page=20` — 1-based pages; response carries `total`, `page`,
  `perPage`, `pages` (per_page capped at 100).
- `?limit=50&offset=0` — response also echoes `limit` and `offset`.

Search params (combine with either pagination style): `q=` matches
subject/sender/body substrings, `from=` matches the sender substring.

List items are summaries only — `{ id, from, subject, date, receivedAt,
codes, linkCount, preview, attachments, attachmentCount }`, where the last two are the same attachment count
(number) kept under both names for compatibility. Full attachment metadata
(filename, content type, size) is on the single-email endpoint; attachment
*content* is never stored or exposed.

## Accounts: one free, isolated inbox per agent

Signing up costs one HTTP call and needs no email address:

```sh
curl -s -X POST https://your-domain/api/accounts \
  -H 'content-type: application/json' -d '{"name":"my-agent"}'
# -> { "ok": true, "apiKey": "am_...", "account": { "id": "acct_...", ... } }
```

The API key is shown **once** and only its SHA-256 hash is stored. Use it
where the master token used to go — the same endpoints now return only that
agent's world:

```sh
KEY=am_...
curl -s -X POST https://your-domain/api/addresses \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"prefix":"signup-42"}'        # -> signup-42@your-domain
curl -s "https://your-domain/api/code/signup-42@your-domain/wait?timeoutMs=60000" \
  -H "authorization: Bearer $KEY"
```

What an account key can and cannot do:

- It sees **only** the addresses it created. `GET /api/addresses`,
  `/api/inbox/...`, `/api/code`, `/api/verify-link`, `/api/wait`,
  `DELETE /api/inbox/...` and `/api/dead-letters` are all scoped to it, and
  another account's address answers **404** so keys cannot enumerate.
- It can only send `From` an address it owns (403 otherwise).
- Creating an address another account owns answers 409; a prefix is claimed
  once.
- `POST /api/accounts` is open by default (this is a free service).
  `SIGNUP_OPEN=0` makes signup master-token-only; `SIGNUP_PER_IP_PER_HOUR`
  and `SIGNUP_MAX_PER_HOUR` bound abuse, and `ADDRESS_QUOTA_PER_ACCOUNT`
  (default 25) caps how many addresses one agent holds.
- Address creation is rate-limited **per account** with
  `ADDRESS_CREATE_MAX_PER_HOUR`, so one agent's traffic never throttles the
  rest of the fleet.

`AGENT_MAIL_TOKEN` remains the admin key: it sees every address, creates
unlimited addresses, sends from any address, and is the only key that can
list accounts (`GET /api/accounts`). Addresses it creates are owned by
`master` and stay invisible to accounts.

With Supabase configured, accounts and ownership live in `agent_accounts`
and `agent_addresses`, so a restart keeps every agent's inbox and its ability
to send. Without it everything is in memory and lost on restart.

## Reliability

- **Store retry queue**: Supabase store failures are retried with
  exponential backoff + jitter (1s, 2s, 4s, 8s, 16s, capped at 60s; up to 5
  attempts) before landing in the dead-letter log, visible via
  `/api/dead-letters` and the `deadLetters`/`retryQueue` health fields. The
  SMTP session still succeeds on a store failure so the sender never
  bounces a message the service intends to deliver on retry.
- **Retention**: in-memory inboxes are pruned to the last 50 emails per
  address and to `RETENTION_DAYS` (default 7) on each store. For Supabase,
  run the `delete` in `supabase-migration.sql` periodically.

## Address lifecycle, rate limits, webhooks

- **TTL cleanup**: addresses idle longer than `ADDRESS_TTL_HOURS` (default
  72) are purged by a sweep running every `ADDRESS_SWEEP_MS` (default
  30 min). On Supabase, old `agent_emails` rows are deleted by `created_at`.
  Set `ADDRESS_TTL_HOURS=0` to disable.
- **Rate limits** — both creation schemes apply; a creation must pass
  both, and either can return 429 with `Retry-After`:
  - `RATE_LIMIT_PER_MINUTE` (default 30) — per-IP address-creation budget
    per minute.
  - `ADDRESS_CREATE_MAX_PER_HOUR` (default 20; 0 disables) — global
    address-creation quota per rolling hour.
  - `EMAILS_PER_ADDRESS_PER_HOUR` (default 100; 0 disables) — excess
    inbound mail for one address is dropped with a warning.
  - **Quota reporting**: `GET /api/quota` (all of the caller's addresses)
    and `GET /api/quota/:address` report each bucket as `{ limit, used,
    remaining, resetAt }` — `remaining` is `null` when that limit is
    disabled (unlimited), `resetAt` is when the oldest hit ages out. Reading
    quota never consumes any of it, so agents can check before they send
    instead of discovering a 429 after the fact.
- **Incoming-mail webhook**: set `INCOMING_WEBHOOK_URL` (and optionally
  `INCOMING_WEBHOOK_SECRET`) to receive a JSON POST per email. When the
  secret is set the body carries `X-AgentMail-Signature:
  sha256=<hmac>` and the event name in `X-AgentMail-Event: mail.received`.
  Delivery is fire-and-forget with a configurable timeout
  (`INCOMING_WEBHOOK_TIMEOUT_MS`); failures are logged, never retried, and
  never block SMTP acceptance.
- **Outbound send** (`POST /api/send`,
  `{ from, fromName?, to, subject, text, html? }`): an agent sends mail from
  its own address through either the SMTP relay (`SMTP_RELAY_*`) or a
  provider HTTP API (`OUTBOUND_PROVIDER=resend|brevo`). The `from` address
  must have been created by this service — foreign From values get 403, so
  the service can never send mail as someone else. `fromName` is sanitized
  and formatted as `"Marcus Vance" <marcus@…>`. Sends are rate-limited per
  From address (`SEND_MAX_PER_HOUR`, default 100) and optionally globally
  per day (`SEND_MAX_PER_DAY`). Unconfigured outbound -> 503, provider 429 ->
  429 with `Retry-After`, other failures -> 502. Config is validated at boot
  and reported in `/health` as `outbound` / `outboundConfigured` (plus the
  legacy `relay` status).

## Outbound through Brevo or Resend (free tiers)

SMTP relays work, but free-tier providers also expose an HTTP API where one
API key can send as any address at a verified domain. Point the service at
one and every account keeps sending with its own From:

```bash
export OUTBOUND_PROVIDER=resend      # or brevo; smtp keeps the relay path
export RESEND_API_KEY=re_...         # BREVO_API_KEY=xkeysib-... for Brevo
export SEND_MAX_PER_DAY=100          # stay under the plan's daily allowance
```

`POST /api/send` then takes
`{ from, fromName?, to, subject, text, html? }`; `from` must still be an
address this service minted for the caller (403 otherwise), and `fromName`
lets an agent send as `Marcus Vance <marcus.vance@yourdomain.com>` without a
separate mailbox. The provider request is shaped per API: Resend gets
`from`/`to`/`subject`/`text`/`html` at `POST /emails`; Brevo gets
`sender`/`to`/`subject`/`textContent`/`htmlContent` at
`POST /v3/smtp/email`.

**Provider setup (account-specific values):**

- Resend: Dashboard -> Domains -> add the domain, then publish exactly the
  DKIM/SPF records it shows (TXT, or MX/CNAME where offered). Once verified,
  any local part at that domain can be a From address — no per-address setup.
- Brevo: Senders & Domains -> authenticate the domain, then publish the Brevo
  code, DKIM record(s) and the DMARC record it shows. SPF/MX are only needed
  here for a dedicated IP, not for domain authentication.
- DNS is account-specific, so copy the provider's values rather than guessing.
  Keep exactly one SPF record and one DMARC record: if this service also
  publishes `v=spf1 a mx ~all`, merge includes into that single TXT (for
  example `v=spf1 a mx include:<provider include> ~all`), and keep the DKIM
  selectors distinct (this service's `mail._domainkey` vs the provider's).

**Practical limits when 1,000 agents share one domain:**

- **Warm up**: a fresh domain sending hundreds of signups on day one looks
  like abuse. Stagger agent signups over days/weeks and raise volume slowly;
  free tiers are small anyway (Resend ~100/day, Brevo 300/day), and
  `SEND_MAX_PER_DAY` enforces the ceiling this deployment promises.
- **Platform rules**: banks, social networks and major clouds often require a
  unique phone number/CAPTCHA and forbid automated account creation. Email
  alone will not get through, and circumventing those rules is out of scope.
- **Subdomain isolation**: send agent mail from a subdomain (e.g.
  `mail.yourdomain.com` or `agents.yourdomain.com`) so complaints and
  reputation damage stay off the root domain. Set `MAIL_DOMAIN` and
  `DKIM_DOMAIN` to that subdomain and verify it at the provider.

**Status:** this path is implemented and tested against a local fake provider
over real HTTP (`test/outbound.test.js`: display-name formatting, wire shape,
429/502 mapping, ownership rejection), but **no provider key or verified
domain exists in this workspace, so no live email has been sent through
Resend or Brevo yet**. That step needs the account owner's provider key and
DNS control.

## Environment

| Var | Required | Notes |
|---|---|---|
| `PORT` | no | API port (Render injects its own) |
| `SMTP_PORT` | no | SMTP listener, default 2525 |
| `AGENT_MAIL_TOKEN` | yes (prod) | long random Bearer token |
| `AGENT_MAIL_INBOUND_SECRET` | yes (prod) | Bearer secret for `POST /api/inbound`; same value as error-inbox's `AGENT_MAIL_INBOUND_SECRET` and the worker's `INBOUND_SECRET` |
| `MAIL_DOMAIN` | yes (prod) | domain used when minting addresses |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | yes (prod) | persistent storage |
| `RETENTION_DAYS` | no | in-memory mail older than this is pruned (default 7) |
| `RATE_LIMIT_PER_MINUTE` | no | address-creation budget per IP per minute (default 30) |
| `ADDRESS_TTL_HOURS` / `ADDRESS_SWEEP_MS` | no | address auto-cleanup (see above) |
| `ADDRESS_CREATE_MAX_PER_HOUR` | no | default 20 (global, per rolling hour) |
| `EMAILS_PER_ADDRESS_PER_HOUR` | no | default 100 |
| `INCOMING_WEBHOOK_URL` / `INCOMING_WEBHOOK_SECRET` | no | signed incoming-mail webhook |
| `INCOMING_WEBHOOK_TIMEOUT_MS` | no | webhook delivery timeout, default 8000 |
| `SMTP_RELAY_HOST` / `SMTP_RELAY_PORT` / `SMTP_RELAY_USER` / `SMTP_RELAY_PASS` | no | outbound relay for POST /api/send (unset = sends answer 503) |
| `SEND_MAX_PER_HOUR` | no | outbound sends per From address per rolling hour (default 100) |
| `OUTBOUND_PROVIDER` | no | `smtp` (default), `resend`, or `brevo`; unset auto-selects a configured provider key |
| `RESEND_API_KEY` / `BREVO_API_KEY` | no | provider API key for `/api/send` (free tiers: Resend 3,000/month, Brevo 300/day) |
| `RESEND_API_BASE` / `BREVO_API_BASE` | no | override provider base URL (tests or a proxy) |
| `SEND_MAX_PER_DAY` | no | global outbound sends per day across all agents (0 disables) |
| `SIGNUP_OPEN` | no | `1` (default) allows free `POST /api/accounts`; `0` = master-token only |
| `SIGNUP_PER_IP_PER_HOUR` / `SIGNUP_MAX_PER_HOUR` | no | signup abuse caps (default 5 per IP, 500 global) |
| `ADDRESS_QUOTA_PER_ACCOUNT` | no | addresses one account may own (default 25; master unlimited) |
| `DKIM_DOMAIN` / `DKIM_SELECTOR` | no | signing domain (default `MAIL_DOMAIN`) and selector (default `mail`) |
| `DKIM_PRIVATE_KEY` | no | PEM RSA key; unset = outbound mail is not signed |
| `DMARC_POLICY` | no | DMARC policy advertised by `/api/dns` (default `none`) |
| `MX_HOST` | no | host the MX record should point at (default `MAIL_DOMAIN`) |

## Free self-hosted deployment (no Cloudflare, nothing paid)

Mail arrives straight at this service's own SMTP listener. You need a
machine with a public IP that accepts inbound port 25, plus a free domain.

1. **Host (free)**: an Oracle Cloud "Always Free" VM, or any box/VPS/home
   server with a public IP. Open inbound TCP **25, 80, 443** in the cloud
   firewall/security list *and* the OS firewall. (Outbound 25 may be
   blocked by hosts; irrelevant, this service only receives.) Render/Railway
   free web tiers cannot work: they only expose HTTP.
2. **Domain (free)**: register a subdomain at [duckdns.org](https://www.duckdns.org),
   e.g. `myagentmail.duckdns.org`, pointed at the host's public IP. No MX
   record is needed: when a domain has no MX, sending servers deliver to its
   A record (RFC 5321). With a DNS host that supports MX (e.g. FreeDNS),
   you can add `MX 10 <your-hostname>` instead.
3. **Run**:
   ```sh
   cp .env.example .env     # set MAIL_DOMAIN=myagentmail.duckdns.org and AGENT_MAIL_TOKEN
   docker compose up -d     # SMTP on :25, HTTPS API on :443 (free Let's Encrypt cert)
   ```
   Without Docker: `SMTP_PORT=25 node server.js` as root (or
   `setcap cap_net_bind_service=+ep $(which node)`), with the API on `PORT`.
4. **Test**: check the service health endpoint, create an
   address via `POST /api/addresses`, send it a mail from any account, then
   `GET /api/verify-link/<address>/wait`.

### DNS, DKIM and deliverability

`GET /api/dns` prints the exact records to publish for `MAIL_DOMAIN`,
including the DKIM record derived from `DKIM_PRIVATE_KEY` — so the signing
key and the DNS record can never drift apart:

```sh
curl -s https://your-domain/api/dns
```

| Type | Name | Value | Why |
|---|---|---|---|
| MX | your domain | `10 <MX_HOST>` | internet mail arrives at this host |
| A | `<MX_HOST>` | your host's public IP | the MX target must resolve |
| TXT | your domain | `v=spf1 a mx ~all` | only this host may send as the domain |
| TXT | `mail._domainkey.<DKIM_DOMAIN>` | `v=DKIM1; k=rsa; p=<public key>` | verifies outbound DKIM signatures |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=none; rua=mailto:dmarc@<domain>` | DMARC policy + reports |

Generate the signing key once and keep it out of git:

```sh
openssl genrsa -out dkim.pem 2048
# then set DKIM_PRIVATE_KEY in .env (literal newlines, or \n escapes)
```

On a free subdomain (DuckDNS and similar) you control the DNS, so all of the
above is still $0. Leave `DMARC_POLICY=none` until `/api/dns` reports
`dkim: configured` and a test message shows `dkim=pass`, then raise it to
`quarantine`. Outbound mail is handed to the relay (`SMTP_RELAY_*`) already
signed, so relays and receivers can authenticate it.

Notes:
- The SMTP listener only accepts recipients `@MAIL_DOMAIN` (550 otherwise),
  so it is not an open relay. `SMTP_ACCEPT_ANY_DOMAIN=1` disables that
  check (dev only). `SMTP_HOST` sets the bind address (default `0.0.0.0`).
- Some sites block signups from free/shared domains. If a provider rejects
  the DuckDNS address, switch `MAIL_DOMAIN` to another free domain; nothing
  else changes.
- `POST /api/inbound` remains as an optional HTTPS delivery path for any
  forwarder (e.g. an Email Worker) but is not needed for this setup.
- Persistence: set `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (free tier) or
  accept in-memory storage, which is lost on restart.

### Catch-all receiving with Cloudflare Email Workers (free)

Cloudflare Email Routing accepts mail for the domain at Cloudflare's MX and
hands every message to a Worker, so no host of your own needs port 25. The
worker in `cloudflare/email-worker/` parses the raw message with
`postal-mime`, extracts the best one-time code and action link, POSTs the
full message to `/api/inbound` (so it lands in that address's inbox), and
optionally POSTs `{ to, from, subject, code, link }` to your own agent
webhook for memory/database writes.

1. Add the domain to Cloudflare (free plan) and change its nameservers at the
   registrar. Cloudflare then hosts DNS, so the MX/SPF records below are in
   the same place as your DKIM/DMARC records.
2. Dashboard -> Email -> Email Routing -> Enable. Cloudflare creates the MX
   and SPF records for the domain automatically.
3. Deploy the worker with an API token — `wrangler login` is not needed:

   ```bash
   cd cloudflare/email-worker
   npm install
   export CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit, Zone:Email Routing:Edit
   export CLOUDFLARE_ACCOUNT_ID=...
   npm run deploy                    # npm run deploy:dry bundles without uploading
   ```

   `scripts/deploy.mjs` refuses to run without `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` and names the missing one, so CI can gate on it.
   Set `INBOUND_URL` in `wrangler.toml` to your service's `/api/inbound`
   first; set `AGENT_WEBHOOK_URL` there too for the optional agent push.
   `INBOUND_SECRET` (= `AGENT_MAIL_INBOUND_SECRET`) and the optional
   `AGENT_WEBHOOK_SECRET` are Worker secrets: add them under Workers &
   Pages -> `agent-mail-inbound` -> Settings -> Variables, or with
   `npx wrangler secret put NAME` after exporting the token.
4. Dashboard -> Email Routing -> Routes -> Catch-all address -> Send to
   Worker -> `agent-mail-inbound`. Every address at the domain, including
   ones created after this step, now reaches the worker.
5. On the service set `MAIL_DOMAIN=yourdomain.com` and the same
   `AGENT_MAIL_INBOUND_SECRET`. `POST /api/accounts` and
   `POST /api/addresses` then mint `@yourdomain.com` addresses.
6. Test: create an account and an address, sign that address up somewhere,
   then `GET /api/code/<address>` (or `/api/wait/<address>`) with the
   account key. The worker delivers in seconds; the reply is the code.

Delivery failures from `/api/inbound` make the worker throw, so Cloudflare
retries the message instead of dropping a verification email. Keep
`DMARC_POLICY=none` until `/api/dns` reports `dkim: configured` and a test
message shows `dkim=pass`, then raise it to `quarantine`.

`npm test` includes a loopback version of this exact path
(`delivery.integration.test.js`): real Worker handler, real HTTP to a spawned
`/api/inbound`, real webhook listener, no mocked transport.

**Deployment status:** the worker code, its real-HTTP delivery test and the
bundle path are verified locally, but **no Worker has been deployed, no DNS
or Email Routing change has been made, and no real internet email has
traversed this path yet** — those need the domain owner's Cloudflare
account. The hosted backend is also still blocked: Render suspended
`agent-mail-service` with "Free Tier Usage Exceeded", so `INBOUND_URL` must
point at a live `/api/inbound` (upgraded Render, a VPS, or another host)
before any mail can be stored.


## 1,000-agent self-hosted phone network (Linux)

**Start both internal agent email and private phone routing with one command:**

```sh
bash start.sh
```

Open `http://localhost:8765` on the Chromebook; launch any agent's MCP
process with `python3 phone/start.py --mcp 2000` (change 2000 to
another extension). The launcher creates 1,000 stable internal email
addresses and phone extensions, local inbox delivery, a dashboard, and
agent-facing MCP tools with no pip or npm installation.

The optional **[Agent Phone module](phone/README.md)** runs on a Chromebook's
Linux environment using Python's standard library, without any third-party
phone provider or cloud API. It provides 1,000 permanent **internal**
extensions, agent-to-agent text messages, WebRTC peer call signaling, a browser
interface, local SQLite storage, and a stdio MCP bridge.

Start it with:

```sh
python3 phone/server.py --state-dir "$HOME/agent-phone-private" --count 1000
```

Then open `http://localhost:8765` on the Chromebook. This does **not**
provide carrier-assigned public phone numbers or SMS, and voice/audio is not
guaranteed outside a compatible private network. See the module README for
MCP setup, security and testing details.
