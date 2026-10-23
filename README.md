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
| POST | `/api/addresses` | `{ prefix }` -> `{ address }` (rate limited, prefix max 64 chars) |
| GET | `/api/addresses` | known addresses with inbox counts + created/last-seen |
| GET | `/api/inbox/:address` | paginated, searchable email list (see below) |
| GET | `/api/inbox/:address/:id` | full email (subject, body, links, attachment metadata) |
| GET | `/api/verify-link/:address?from=` | newest verification link for the address (immediate) |
| GET | `/api/verify-link/:address/wait?from=&timeoutMs=` | long-poll for a link (default 30s, max 120s) — no busy-polling |
| GET | `/api/dead-letters` | emails that exhausted store retries (last 50) |
| DELETE | `/api/inbox/:address` | clear inbox |
| GET | `/dashboard` | local browser UI for addresses + inboxes (no auth page; token stays in sessionStorage) |

### Inbox pagination + search

Both pagination styles are supported; when `limit`/`offset` are present
they take precedence, otherwise `page`/`per_page` are used:

- `?page=1&per_page=20` — 1-based pages; response carries `total`, `page`,
  `perPage`, `pages` (per_page capped at 100).
- `?limit=50&offset=0` — response also echoes `limit` and `offset`.

Search params (combine with either pagination style): `q=` matches
subject/sender/body substrings, `from=` matches the sender substring.

List items are summaries only — `{ id, from, subject, date, attachments,
attachmentCount }`, where the last two are the same attachment count
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
- **SMTP relay config** (`SMTP_RELAY_HOST/PORT/USER/PASS`) is validated at
  boot and reported in `/health` as `unconfigured`, `configured`, or
  `misconfigured` (misconfig prints loud warnings). The service never sends
  mail today; validation exists so a future relay or typo fails loudly.

## Environment

| Var | Required | Notes |
|---|---|---|
| `PORT` | no | API port (Render injects its own) |
| `SMTP_PORT` | no | SMTP listener, default 2525 |
| `AGENT_MAIL_TOKEN` | yes (prod) | long random Bearer token |
| `MAIL_DOMAIN` | yes (prod) | domain used when minting addresses |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | yes (prod) | persistent storage |
| `RETENTION_DAYS` | no | in-memory mail older than this is pruned (default 7) |
| `RATE_LIMIT_PER_MINUTE` | no | address-creation budget per IP per minute (default 30) |
| `ADDRESS_TTL_HOURS` / `ADDRESS_SWEEP_MS` | no | address auto-cleanup (see above) |
| `ADDRESS_CREATE_MAX_PER_HOUR` | no | default 20 (global, per rolling hour) |
| `EMAILS_PER_ADDRESS_PER_HOUR` | no | default 100 |
| `INCOMING_WEBHOOK_URL` / `INCOMING_WEBHOOK_SECRET` | no | signed incoming-mail webhook |
| `INCOMING_WEBHOOK_TIMEOUT_MS` | no | webhook delivery timeout, default 8000 |
| `SMTP_RELAY_HOST` / `SMTP_RELAY_PORT` / `SMTP_RELAY_USER` / `SMTP_RELAY_PASS` | no | validated at boot, no mail sent |

## Pending (needs Jay)

- **DNS/MX**: DigitalPlat free-domain registration + MX records pointing at
  this service so it can actually receive mail.
- **Mail env vars**: `AGENT_MAIL_TOKEN`, `MAIL_DOMAIN`, and the Supabase
  keys on the Render service.

Note: Render web services only expose the HTTP port publicly, so external
MX delivery on SMTP ports cannot reach Render directly — mail must be
forwarded/relayed to the service's SMTP listener by whatever receives the
MX traffic.
