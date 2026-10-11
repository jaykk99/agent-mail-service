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
| GET | `/health` | `{ ok, domain, storage, addresses }` (no auth) |
| POST | `/api/addresses` | `{ prefix }` -> `{ address }` |
| GET | `/api/inbox/:address` | email list (id/from/subject/date) |
| GET | `/api/inbox/:address/:id` | full email (subject, body, links) |
| GET | `/api/verify-link/:address?from=` | newest verification link for the address |
| DELETE | `/api/inbox/:address` | clear inbox |

## Environment

| Var | Required | Notes |
|---|---|---|
| `PORT` | no | API port (Render injects its own) |
| `SMTP_PORT` | no | SMTP listener, default 2525 |
| `AGENT_MAIL_TOKEN` | yes (prod) | long random Bearer token |
| `MAIL_DOMAIN` | yes (prod) | domain used when minting addresses |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | yes (prod) | persistent storage |

## Pending (needs Jay)

- **DNS/MX**: DigitalPlat free-domain registration + MX records pointing at
  this service so it can actually receive mail.
- **Mail env vars**: `AGENT_MAIL_TOKEN`, `MAIL_DOMAIN`, and the Supabase
  keys on the Render service.

Note: Render web services only expose the HTTP port publicly, so external
MX delivery on SMTP ports cannot reach Render directly — mail must be
forwarded/relayed to the service's SMTP listener by whatever receives the
MX traffic.
