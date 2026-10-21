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
| GET | `/health` | `{ ok, domain, storage, addresses, retentionDays, deadLetters, retryQueue }` (no auth) |
| POST | `/api/addresses` | `{ prefix }` -> `{ address }` (rate-limited, prefix max 64 chars) |
| GET | `/api/inbox/:address` | email list (id/from/subject/date/attachments count); `?limit=&offset=` pagination |
| GET | `/api/inbox/:address/:id` | full email (subject, body, links, attachment metadata) |
| GET | `/api/verify-link/:address?from=` | newest verification link for the address (immediate) |
| GET | `/api/verify-link/:address/wait?from=&timeoutMs=` | long-poll for a link (default 30s, max 120s) — no busy-polling |
| GET | `/api/dead-letters` | emails that exhausted store retries |
| DELETE | `/api/inbox/:address` | clear inbox |

Reliability: Supabase store failures are retried with exponential backoff +
jitter (up to 5 attempts) before landing in the dead-letter log, which is
visible via `/api/dead-letters` and the health endpoint. The SMTP session
still succeeds on a store failure so the sender never bounces a message the
service intends to deliver on retry. In-memory inboxes are pruned to the last
50 emails per address and to `RETENTION_DAYS` (default 7); for Supabase, run
the `delete` in `supabase-migration.sql` periodically. Inbox addresses are
validated (`local@domain` shape); bodies are capped at 50KB; address creation
is rate-limited (30/min per IP by default).

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

## Pending (needs Jay)

- **DNS/MX**: DigitalPlat free-domain registration + MX records pointing at
  this service so it can actually receive mail.
- **Mail env vars**: `AGENT_MAIL_TOKEN`, `MAIL_DOMAIN`, and the Supabase
  keys on the Render service.

Note: Render web services only expose the HTTP port publicly, so external
MX delivery on SMTP ports cannot reach Render directly — mail must be
forwarded/relayed to the service's SMTP listener by whatever receives the
MX traffic.
