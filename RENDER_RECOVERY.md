# Recover the historical Render email API without confusing it with Monico Linux

## What we actually observed

The historical public URL `https://agent-mail-service.onrender.com/health`
returned **HTTP 503 on 7 out of 7 attempts** from an independent
GitHub-hosted Linux machine over approximately 90 seconds:

- [Independent failure evidence](https://github.com/jaykk99/agent-mail-service/actions/runs/44800134122)
- [Current Docker/Node process check](https://github.com/jaykk99/agent-mail-service/actions/workflows/legacy-node.yml)

Render documents that a 503 may occur if a service is suspended, waking from
idle, or in maintenance. **The response alone does not identify which**, and
a GitHub commit cannot remove an account-level suspension or fix unavailable
Render infrastructure.

## Repairs already committed to this repository

- `render.yaml` now leaves HTTP `PORT` to Render (no empty override).
- Web service disables the unused standalone SMTP listener with
  `SMTP_ENABLED=0`. Render only exposes the web HTTP port, not public
  TCP 25/587/993.
- Server dependencies use deterministic `npm ci --omit=dev`.
- A fresh Render Blueprint generates strong operator and inbound bearer
  secrets, without committing secrets. Existing environment variables are
  preserved by Render; a bad existing value must be fixed in the service.
- `/health` explicitly reports `durableStorage`, `smtpListenerEnabled`
  and `externalEmailVerified: false`; an HTTP 200 is not email-delivery proof.
- `/ready` returns HTTP **503** if the operator token is insecure or
  persistent database access is unavailable. This check is intentionally
  more demanding than Render's HTTP-only liveness `/health`.
- The optional Cloudflare inbound worker no longer contains the failing
  historical Render URL; it requires a separately configured verified
  `INBOUND_URL`.

## A Render account connection is still necessary

The actual account owner or a connected Render management app must:

1. Locate the existing `agent-mail-service` service in the Render dashboard.
   Check whether it was **suspended**, removed, or is still deploying, and
   check deploy logs for the actual failure. Resume or address limits/billing
   if Render requires it.
2. Confirm Git repository `jaykk99/agent-mail-service` and current
   `main` commit are attached to the **same service** that owns the old URL.
   Uploading code to GitHub does not guarantee that deployment has occurred.
3. Make sure the existing service has no manually configured blank `PORT`
   variable; Render supplies `PORT` automatically. Existing Blueprint
   environment settings are *not always removed* by changing `render.yaml`.
4. Verify a strong, private `AGENT_MAIL_TOKEN` and dedicated
   `AGENT_MAIL_INBOUND_SECRET` exist. Never paste passwords or API keys
   into GitHub, documentation, or chat. The Render Blueprint can generate
   them for a **new** deployment.
5. Deploy the latest `main` commit and inspect the actual deployment logs.
   Then verify `GET /health` is HTTP 200 and reports `ok:true`.
6. Verify `GET /ready` separately. If it reports
   `persistent_storage_not_configured`, the Render API is only a temporary
   development instance: its email addresses can disappear on restart.
   Provision proper durable storage **or host the self-contained Monico
   Linux Postfix/Dovecot stack instead**.
7. Only after the backend is healthy, configure the optional Cloudflare
   Email Worker with the verified exact HTTPS `/api/inbound` address and
   matching inbound authentication secret. This worker is not needed for
   the direct Linux Postfix/Dovecot service.

## Linux-only alternative (no Render or Cloudflare needed)

The primary Linux stack is separate:

~~~bash
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service
bash linux/install.sh
bash start.sh --full release --scope local
~~~

It has passed real Ubuntu Postfix/Dovecot SMTP-to-IMAP delivery and
cross-agent security tests in GitHub CI. Real public access still requires
your own actual reachable Linux machine, delegated email domain / MX /
SMTP and TLS for Internet mail. Browser HTTPS without a domain can work
using a reachable public IP with trusted IP-specific certificates.

Use `phone/probe_public.py` from an **independent network** to verify
the public browser gateway. The public-email checks live in
`monico-mail-usb/selfhost/public_probe.py`. Neither check can make a
private local machine publicly accessible by itself.

## What no code change can manufacture

A Linux process can create internal agent extensions, mailbox credentials,
local messaging, and SIP identities. It cannot allocate globally routable
public telephone numbers or connect carrier SMS/PSTN without an authorized
telecommunications interconnect, and it cannot receive normal internet
email without an actual public mail-routing path.
