# Agent City Mail — Cloudflare-native backend (optional, not deployed)

This is a **real email server-side API** built on **Cloudflare Email Service**, **Email Workers**, and **D1**. It does not rely on the older AgentMail provider, third-party SMTP relays, an unverified Render URL, or the local Linux SMTP listener.

It can securely register named agent addresses (e.g. `aurora-art@YOUR_DOMAIN`), store incoming email, retrieve each agent's inbox, and request outbound delivery from the Cloudflare Email Service binding.

**It is not currently online or verified externally.** Cloudflare account access, a real domain you control, an onboarded sending domain, and a working Email Routing rule are required. The Worker does not provide cellular phone numbers or SMS.

## Deploy (Cloudflare account operator)

1. In Cloudflare, onboard a **domain you own** to Email Service, configure the MX/SPF/DKIM records, and verify outbound sending permissions and plan limits. Use Cloudflare Email Routing to deliver incoming mail to this Worker (catch-all or explicit routing).
2. From this folder, run `npm install`, then `npx wrangler d1 create agent-city-mail` and copy the **real D1 database ID** into the commented binding in `wrangler.toml`; uncomment all four binding lines.
3. Run `npx wrangler d1 execute agent-city-mail --remote --file=./schema.sql`.
4. Set both secrets with Wrangler: `npx wrangler secret put MAIL_DOMAIN` (your verified domain) and `npx wrangler secret put BRIDGE_TOKEN` (random secret, **at least 32 characters**; do not put it in git or in a browser).
5. Run `npx wrangler deploy` and configure the Email Routing action to deliver **to this Worker**. Check the actual domain's MX records and Worker routing.
6. In **Agent City's Cloudflare Pages project**, bind this Worker as a service named `AGENT_CITY_MAIL_SERVICE` and set `AGENT_CITY_MAIL_BRIDGE_TOKEN` to the same secret (Pages secret, server-side). Alternatively set `AGENT_CITY_MAIL_SERVICE_URL` to the Worker HTTPS URL and the same bridge token. Set `AGENT_CITY_OPERATOR_TOKEN` (distinct long secret) to authorize provisioning, inbox reads and sends. No client must receive these values.
7. Use Agent City's authenticated `POST /api/mail/create-inbox` with `{"agentId":23,"slug":"aurora-art"}` to claim a unique name. This is real only after the backend returns the claimed address; the game should never mint imaginary verified mailboxes.
8. Verify **from an outside provider** that a message to that address arrives in the correct D1 inbox; then verify an allowed recipient actually receives an outbound message. Inspect bounces and the provider activity log. Only then mark public delivery verified in your operational records.

## API (all `/v1` paths require `Authorization: Bearer BRIDGE_TOKEN`)

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Public health: bindings/database readiness, **not** proof of external delivery |
| GET | `/v1/status` | Authorized readiness and count |
| POST | `/v1/agents/:id/claim` | Claim a unique human-chosen username |
| GET | `/v1/agents/:id/identity` | Get the actual claimed address, or 404 |
| GET | `/v1/agents/:id/inbox?limit=20` | Read persisted incoming email |
| POST | `/v1/agents/:id/send` | Send through Email Service; 5 emails/day/agent limit |

The Worker keeps an audit of outgoing messages and rejects unknown incoming aliases. Incoming attachments are not persisted. All sender addresses come **only from claimed D1 records**; clients cannot override the `From` header.

Do not make bridge credentials public, let browsers provision mailboxes with an anonymous API, or expose `/v1/agents/:id/inbox` without authentication.

For the original independent Postfix/Dovecot/Linux stack, continue using `monico-mail-usb` and its release gate. It is separate from this Cloudflare email provider, and its local protocol tests do not prove public mail.

## Local verification

```bash
npm install
npm test
npx wrangler dev
```

A passing test means the code's validation rules passed, not that an actual domain can receive or send email. You must also perform outside-network delivery tests after deploying.
