# Monico Mail USB — Chromebook Linux MCP prototype

Monico stores persistent agent identity records on a USB drive shared with ChromeOS Linux (Crostini). Agents can choose an available email name and keep the same assignment after restarts.

**Current limits:** This prototype does not send or receive real internet email, does not support six-digit pairing, and does not enforce transport-level MCP authentication. **Do not expose port 8787 to the internet yet.** See [CHROMEBOOK.md](CHROMEBOOK.md).

## 1. Install from your Chromebook Linux Terminal

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service/monico-mail-usb
bash chromebook-setup.sh
```

If you already cloned the repository, run `git pull` inside `agent-mail-service` instead of cloning again.

## 2. Find the USB drive shared with Linux

In ChromeOS Files, share the USB drive or its folder with Linux. Then run:

```bash
ls /mnt/chromeos/removable/
ls -la /mnt/chromeos/removable/
```

Find your actual USB drive name. Replace `YOUR_DRIVE` below with that name. If it contains spaces, keep the double quotes.

```bash
export MONICO_DATA="/mnt/chromeos/removable/YOUR_DRIVE/monico"
mkdir -p "$MONICO_DATA"
touch "$MONICO_DATA/.write-test"
rm "$MONICO_DATA/.write-test"
```

If the commands fail, verify the ChromeOS Files **Share with Linux** setting and the drive's actual path. Never point `MONICO_DATA` at your Chromebook's internal disk if you want USB persistence.

## 3. Start the private MCP prototype

From `agent-mail-service/monico-mail-usb`:

```bash
export MONICO_DATA="/mnt/chromeos/removable/YOUR_DRIVE/monico"
export MONICO_MCP_BEARER_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
export MONICO_DOMAIN="mail.example.invalid"
export MONICO_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
.venv/bin/python server.py
```

The private MCP endpoint is `http://127.0.0.1:8787/mcp`. Keep the admin key secret. It is not automatically persisted by this command; store it securely if you need it again.

## 4. Updating later

```bash
cd ~/agent-mail-service
git pull
cd monico-mail-usb
.venv/bin/python -m pip install -r requirements.txt
```

## Public URL and real mail — not yet implemented

A permanent HTTPS URL can be configured after per-request authentication, secure agent credentials, rate limiting, and pairing are built and tested. Tailscale Funnel compatibility with Crostini must be verified. An HTTPS tunnel does not provide public SMTP/IMAP mail delivery. Public email requires a delegated domain, DNS mail records, and a functioning mail transport.

Chromebooks may suspend Linux during sleep, lid closure, or system updates; 24/7 uptime is not guaranteed.

## Run the automated registry tests

From `agent-mail-service/monico-mail-usb`:

```bash
bash run-tests.sh
```

GitHub Actions also runs these tests on changes to this folder. These tests check persistent identity, unique email names, invalid credentials, key rotation, and missing USB directories. They **do not** validate actual SMTP delivery, remote MCP authentication, public HTTPS availability, or Chromebook uptime.

## Security notes

The admin key is currently passed as a tool argument and is **not suitable for exposure to remote/untrusted MCP clients**. Use the service only on the private Linux loopback interface. A production release needs authentication at the HTTP transport layer, secure onboarding, and audited mail delivery before publishing a URL.

## MCP HTTP bearer security

All MCP HTTP requests now require `Authorization: Bearer <MONICO_MCP_BEARER_TOKEN>`. Generate the separate bearer token as shown in step 3. Save it securely outside Git for later restarts. This is an operator-wide token, **not** an agent-specific token; never give it to untrusted agents. The admin registration tool also requires the separate `MONICO_ADMIN_KEY`.

**Not ready for public exposure:** individual agent transport authorization, pairing, rate limiting, live SMTP/IMAP, and public HTTPS deployment are still unimplemented. The bearer authentication code has not yet passed an end-to-end FastMCP integration test.
