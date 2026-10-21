# Agent Mail Service

Self-hosted email for AI agents. Receives provider verification/signup emails
via SMTP and exposes them through a simple REST API, so the Error Inbox MCP
can poll for verification codes and links without depending on Gmail or
temp-mail services.

## Architecture

- **`server.js`** — the whole service:
  - **SMTP server** (default port 2525) receives incoming mail and parses it
    with `mailparser`, extracting subject, text body, and URLs.
  - **REST API** (default port 3000, Bearer-token auth) lists inboxes,
    fetches full emails, polls for verification links, and clears inboxes.
  - **Storage**: Supabase table `agent_emails` when `SUPABASE_URL` and
    `SUPABASE_SERVICE_KEY` are set, otherwise an in-memory Map (local dev
    only — data is lost on restart). See `supabase-migration.sql`.
- **`render.yaml`** — declarative Render web service config (the Railway
  trial expired; production deploys from here).
- **`supabase-migration.sql`** — one-time SQL for the `agent_emails` table.

## Run locally

```sh
npm install
npm test     # runs the local test suite (in-memory storage, no network)
npm start    # API on PORT (3000), SMTP on SMTP_PORT (2525)
```

Default token is `dev-token-change-me` — the server warns at boot if it is
still the default. Set `AGENT_MAIL_TOKEN` to a long random token.

## API

All endpoints except `GET /health` require
`Authorization: Bearer <AGENT_MAIL_TOKEN>`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | `{ ok, domain, storage, addresses, relay, webhook, addressTtlHours }` (no auth) |
| POST | `/api/addresses` | `{ prefix }` -> `{ address }` (rate limited) |
| GET | `/api/addresses` | known addresses with inbox counts + created/last-seen |
| GET | `/api/inbox/:address?page=&per_page=&q=&from=` | paginated, searchable email list (id/from/subject/date/attachmentCount) |
| GET | `/api/inbox/:address/:id` | full email (subject, body, links, attachment metadata) |
| GET | `/api/verify-link/:address?from=` | newest verification link for the address |
| DELETE | `/api/inbox/:address` | clear inbox |
| GET | `/dashboard` | local browser UI for addresses + inboxes (no auth page; token stays in sessionStorage) |

Attachment metadata (filename, content type, size) is stored and returned;
attachment *content* is never stored or exposed.

## Address lifecycle, rate limits, webhooks

- **TTL cleanup**: addresses idle longer than `ADDRESS_TTL_HOURS` (default 72)
  are purged by a sweep running every `ADDRESS_SWEEP_MS` (default 30 min).
  On Supabase, old `agent_emails` rows are deleted by `created_at`. Set
  `ADDRESS_TTL_HOURS=0` to disable.
- **Rate limits** (per rolling hour, `0` disables):
  `ADDRESS_CREATE_MAX_PER_HOUR` (default 20) — excess creations get 429 with
  `Retry-After`; `EMAILS_PER_ADDRESS_PER_HOUR` (default 100) — excess inbound
  mail for one address is dropped with a warning.
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
| `ADDRESS_TTL_HOURS` / `ADDRESS_SWEEP_MS` | no | address auto-cleanup (see above) |
| `ADDRESS_CREATE_MAX_PER_HOUR` | no | default 20 |
| `EMAILS_PER_ADDRESS_PER_HOUR` | no | default 100 |
| `INCOMING_WEBHOOK_URL` / `INCOMING_WEBHOOK_SECRET` | no | signed incoming-mail webhook |
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
