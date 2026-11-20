# Monico Mail USB — MCP prototype

Persistent agent identity registry backed by a mounted Linux USB drive. Agents select unique email names and retain them across restarts.

**Not production-ready:** This version does not send or receive public email and must NOT be exposed through Tailscale Funnel yet. It lacks transport-level authentication, pairing-code support, and SMTP/IMAP integration.

## Linux setup

```bash
sudo mkdir -p /mnt/monico
# Mount your USB drive at /mnt/monico
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export MONICO_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export MONICO_DOMAIN='your-delegated-domain.example'
bash start-monico.sh
```

Run from this directory. MCP endpoint: `http://127.0.0.1:8787/mcp`. Keep it private until authentication is implemented.

## Public URL roadmap

Once bearer authentication, token revocation, rate limits, and secure pairing are implemented and tested, use Tailscale Funnel to expose port 8787 at a public HTTPS `*.ts.net` URL. A tunnel is not a mail server and does not make arbitrary email domains publicly deliverable.

## Next steps
- Authenticate each MCP request, not merely tool parameters
- Implement six-digit one-time pairing and per-agent revocable keys
- Implement Postfix/Dovecot, MX/SPF/DKIM/DMARC and mailbox delivery
- Add USB health checks, backup/restore, quotas, and tests
