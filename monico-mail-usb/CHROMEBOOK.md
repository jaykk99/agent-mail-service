# Monico Mail on stock Chromebook Linux (Crostini)

This is a prototype, **not** a working public email service. Do not publish the MCP endpoint yet: MCP request authentication, public SMTP/IMAP and six-digit pairing are not implemented.

## Install
Open ChromeOS Terminal > Linux, then:
```bash
git clone https://github.com/jaykk99/agent-mail-service.git
cd agent-mail-service/monico-mail-usb
bash chromebook-setup.sh
```

## USB drive
In ChromeOS Files, right-click the USB drive or a folder on it and select **Share with Linux**. Verify the path with `ls /mnt/chromeos/removable`. Use a directory on the shared drive for `MONICO_DATA`. ChromeOS USB sharing is not equivalent to raw USB device access. Ensure the shared path is present before starting.

## Start (private testing only)
```bash
export MONICO_DATA="/mnt/chromeos/removable/YOUR_DRIVE/monico"
mkdir -p "$MONICO_DATA"
export MONICO_DOMAIN="mail.example.invalid"
export MONICO_ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
.venv/bin/python server.py
```
The MCP endpoint is bound to 127.0.0.1:8787 inside the Linux container. Keep it private until proper bearer-token authentication is added. Admin credentials must not be passed to untrusted agents.

## Public access
A real public URL requires a secure tunnel and a hostname. Crostini can restrict Tailscale's networking; test compatibility before selecting Funnel. A tunnel exposes MCP HTTP traffic only; it does not automatically provide internet email or MX/SMTP delivery.

## Always-on warning
ChromeOS can suspend Linux when the device sleeps, closes its lid, or updates. Test uptime and set appropriate power behavior. No guarantee of uninterrupted 24/7 hosting.
