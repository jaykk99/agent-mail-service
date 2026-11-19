# Agent Mail Service

Self-hosted email for AI agents. Receives provider verification/signup emails
via SMTP and exposes them through a simple REST API, so the Error Inbox MCP
can poll for verification codes and links without depending on Gmail or
temp-mail services.

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
  - **REST API** (default port 3000, Bearer-token auth, 50 KB request-body
    cap) lists inboxes, fetches full emails, polls or long-polls for
    verification links, and clears inboxes. Requests are logged as
    structured JSON lines with a per-request id.
  - **Storage**: Supabase table `agent_emails` when `SUPABASE_URL` and
    `SUPABASE_SERVICE_KEY` are set, otherwise an in-memory Map (local dev
    only — data is lost on restart). See `supabase-migration.sql`.
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

All endpoints except `GET /health` and `GET /dashboard` require
`Authorization: Bearer <AGENT_MAIL_TOKEN>`. Address path parameters are
validated (`local@domain` shape, max 254 chars); malformed ones get a 400.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | `{ ok, domain, storage, addresses, relay, webhook, addressTtlHours, retentionDays, deadLetters, retryQueue }` (no auth) |
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
- **Addresses survive restarts**: with Supabase, `GET /api/addresses` and
  `/health` are rebuilt from stored mail, so the list is not empty after a
  free Render instance sleeps and wakes.

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
