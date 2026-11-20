# DNS / TLS pack — agent-mail-service + Calling-linux

## AgentMail DNS (the sending domain)

The 5 DNS records for `agents.errorinbox.qd.je` are the source of truth in
`~/workspace/agent-mail-outbound/dns-records.md` (AgentMail API, Nov 19).
They are NOT copied here so they cannot drift or be republished wrongly.
Publish them at DigitalPlat after Jay claims `errorinbox.qd.je`
(Turnstile human check, only he can click). Summary of what they are:

1. DKIM TXT `agentmail._domainkey.agents.errorinbox.qd.je` (selector
   `agentmail`, AgentMail's key).
2. MX `mail.agents.errorinbox.qd.je` -> Amazon SES feedback (priority 10).
3. SPF TXT on `mail.agents.errorinbox.qd.je` (`include:amazonses.com`).
4. DMARC TXT `_dmarc.agents.errorinbox.qd.je` (`p=reject`).
5. MX `*.agents.errorinbox.qd.je` -> Amazon SES inbound (priority 10).

After publishing, verify in the AgentMail console that the domain shows
verified. AgentMail both-directions send/receive was already verified live
Nov 19; reuse that evidence, do not send new test mail to prove it again.

## Self-hosted DNS (Postfix/Dovecot on Jay's Linux)

The installer (`linux/install-validate.sh`) generates a 2048-bit DKIM key
for the real domain and prints the TXT record to publish. Do NOT publish
the `test.local` key from the sandbox run: it was generated for a test
domain with a 2-day self-signed cert and means nothing in DNS.

Publish for the real domain (replace `agents.errorinbox.qd.je` with the
domain actually used):

| Type | Host | Value |
|---|---|---|
| TXT | `mail._domainkey.<domain>` | the DKIM record the installer prints (`v=DKIM1; h=sha256; k=rsa; p=...`) |
| TXT | `<domain>` | `v=spf1 mx -all` (self-hosted sending via the box's MX) |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=reject; rua=mailto:dmarc@agentmail.to` |
| MX | `<domain>` | the box's public hostname, priority 10 |
| A | `mx.<domain>` | the box's public IPv4 |

Verify:

```bash
dig TXT mail._domainkey.agents.errorinbox.qd.je
opendkim-testkey -d agents.errorinbox.qd.je -s mail -k /etc/opendkim/keys/agents.errorinbox.qd.je/mail.private
```

Notes:

- If both AgentMail and the self-hosted Postfix send for the same domain,
  the SPF record must cover both (`v=spf1 mx include:amazonses.com -all`
  on the sending subdomain actually used). Do not publish two different
  SPF records for the same host.
- The sandbox DKIM key check that passed here: `opendkim-genkey` output
  plus `openssl rsa -in mail.private -check -noout` -> "RSA key ok". The
  live DNS verification (`opendkim-testkey`) can only run after the real
  domain's TXT is published.

## TLS

- Dovecot (IMAP :993) and Postfix (SMTP :25) REQUIRE TLS in the shipped
  configs (`ssl = required` in dovecot.conf). The sandbox run used a
  2-day self-signed cert for `test.local` — that is a test artifact only.
- On the real box, get a real cert with certbot (Let's Encrypt, free, no
  card) for the mail hostname and point `ssl_cert` / `ssl_key` in
  dovecot.conf at it, plus Postfix `smtpd_tls_cert_file` /
  `smtpd_tls_key_file` in main.cf. Renewal is certbot's job (`certbot
  renew` in cron); the installer does not do this step because it needs
  the public DNS name to resolve to the box first.
- Until a real cert exists, do NOT relax `ssl = required` to get mail
  flowing; that would expose passwords in cleartext on :143/:993.
