# Agent Mail Service

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
| GET | `/health` | `{ ok, domain, storage, addresses, relay, webhook, addressTtlHours, retentionDays, deadLetters, retryQueue }` (no auth) |
| POST | `/api/accounts` | free signup: `{ name? }` -> `{ account, apiKey }` (key shown once) |
| GET | `/api/me` | caller identity + usage (account key, or master summary) |
| GET | `/api/accounts` | every account with usage counts (master only) |
| GET | `/api/dns` | MX/SPF/DKIM/DMARC records to publish (no auth) |
| POST | `/api/inbound` | Worker delivery only: `{ to, from, subject, text, html, messageId?, date? }` -> `{ ok, stored, id?, duplicate? }` (Bearer inbound secret) |
| POST | `/api/addresses` | `{ prefix }` -> `{ address }` (rate limited, prefix max 64 chars) |
| GET | `/api/addresses` | known addresses with inbox counts + created/last-seen |
| POST | `/api/send` | `{ from, to, subject, text, html? }` -> `{ messageId }` (From must be an address this service created; sent via the SMTP relay) |
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
- **Incoming-mail webhook**: set `INCOMING_WEBHOOK_URL` (and optionally
  `INCOMING_WEBHOOK_SECRET`) to receive a JSON POST per email. When the
  secret is set the body carries `X-AgentMail-Signature:
  sha256=<hmac>` and the event name in `X-AgentMail-Event: mail.received`.
  Delivery is fire-and-forget with a configurable timeout
  (`INCOMING_WEBHOOK_TIMEOUT_MS`); failures are logged, never retried, and
  never block SMTP acceptance.
- **Outbound send** (`POST /api/send`, `{ from, to, subject, text, html? }`):
  an agent sends mail from its own address through the SMTP relay
  (`SMTP_RELAY_HOST/PORT/USER/PASS`). The `from` address must have been
  created by this service — foreign From values get 403, so the service
  can never send mail as someone else. Sends are rate-limited per From
  address (`SEND_MAX_PER_HOUR`, default 100). Relay unconfigured -> 503,
  relay failure -> 502. Relay config is validated at boot and reported in
  `/health` as `unconfigured`, `configured`, or `misconfigured`
  (misconfig prints loud warnings).

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
3. Deploy the worker:

   ```bash
   cd cloudflare/email-worker
   npm install
   npx wrangler login
   npx wrangler secret put INBOUND_SECRET   # = AGENT_MAIL_INBOUND_SECRET
   npx wrangler deploy
   ```

   Set `INBOUND_URL` in `wrangler.toml` to your service's `/api/inbound`
   first. For the optional agent push, also set `AGENT_WEBHOOK_URL` there and
   `AGENT_WEBHOOK_SECRET` via `wrangler secret put`.
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
