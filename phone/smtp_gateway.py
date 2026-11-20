"""Minimal self-hosted SMTP ingress for LOCAL agent mailboxes (Python stdlib).

Default bind: 127.0.0.1:2526, never a public open SMTP relay.
Receives mail only for pre-existing internal agent inboxes. Optional
real-domain aliasing is INBOUND ONLY and needs independently managed DNS.
"""
from email import policy
from email.parser import BytesParser
import re
import socketserver

from internal_mail import INTERNAL_DOMAIN, MailError

MAX_DATA = 65536
MAX_RECIPIENTS = 10
MAX_LINE = 4096
ADDR = re.compile(r"^[^\s<>@]+@[A-Za-z0-9][A-Za-z0-9.-]{0,250}$")


def validate_public_domain(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError("mail domain must be a string")
    name = value.lower().strip().rstrip(".")
    if len(name) > 253 or not re.fullmatch(r"[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+", name):
        raise ValueError("mail domain must be a valid registered domain you control")
    if name.endswith((".invalid", ".localhost", ".test", ".example", ".local")) or name in ("example.com", "example.net", "example.org"):
        raise ValueError("public mail domain cannot use a reserved/testing domain")
    return name


class SMTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, router, public_domain=None):
        self.router = router
        self.public_domain = validate_public_domain(public_domain)
        super().__init__(address, SMTPHandler)

    def mapped_recipient(self, raw):
        if not isinstance(raw, str) or not ADDR.fullmatch(raw) or len(raw) > 254:
            return None
        local, sep, domain = raw.lower().rpartition("@")
        if domain == INTERNAL_DOMAIN:
            mapped = raw.lower()
        elif self.public_domain and domain == self.public_domain:
            mapped = local + "@" + INTERNAL_DOMAIN
        else:
            return None
        return mapped if self.router.has_address(mapped) else None


def extract_path(text, prefix):
    # Restrict SMTP envelope parsing to simple RFC5321 <mailbox> paths.
    if not text.upper().startswith(prefix):
        return None
    value = text[len(prefix):].strip()
    if not value.startswith("<") or ">" not in value:
        return None
    address, rest = value[1:].split(">", 1)
    if rest.strip() and not (prefix == "MAIL FROM:" and rest.strip().upper().startswith("SIZE=")):
        return None
    if not address and prefix == "MAIL FROM:":
        return ""
    return address if ADDR.fullmatch(address) and len(address) <= 254 else None


def parse_body(data):
    message = BytesParser(policy=policy.default).parsebytes(data)
    subject = str(message.get("subject", ""))[:200]
    if message.is_multipart():
        part = message.get_body(preferencelist=("plain",))
        body = part.get_content() if part else ""
    else:
        body = message.get_content()
    if not isinstance(body, str):
        body = ""
    body = body[:10000]
    if not body:
        body = "(No plain-text body)"
    return subject, body


class SMTPHandler(socketserver.StreamRequestHandler):
    def send(self, line):
        self.wfile.write((line + "\r\n").encode("ascii"))
        self.wfile.flush()

    def handle(self):
        self.connection.settimeout(30)
        self.send("220 agent-comms.local ESMTP ready")
        greeted = False
        sender = None
        recipients = []
        while True:
            try:
                line = self.rfile.readline(MAX_LINE + 1)
            except (TimeoutError, OSError):
                break
            if not line:
                break
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                self.send("500 SMTP command too long")
                break
            command = line.decode("utf-8", errors="replace").strip()
            upper = command.upper()
            if upper.startswith("EHLO ") or upper.startswith("HELO "):
                greeted, sender, recipients = True, None, []
                self.send("250-agent-comms.local")
                self.send(f"250 SIZE {MAX_DATA}")
            elif upper == "QUIT":
                self.send("221 Closing connection")
                break
            elif upper == "NOOP":
                self.send("250 OK")
            elif upper == "RSET":
                sender, recipients = None, []
                self.send("250 Reset")
            elif upper.startswith("MAIL FROM:"):
                if not greeted:
                    self.send("503 Send HELO/EHLO first")
                    continue
                address = extract_path(command, "MAIL FROM:")
                if address is None:
                    self.send("501 Invalid sender")
                    continue
                sender, recipients = address, []
                self.send("250 Sender accepted")
            elif upper.startswith("RCPT TO:"):
                if sender is None:
                    self.send("503 Send MAIL FROM first")
                    continue
                address = extract_path(command, "RCPT TO:")
                mapped = self.server.mapped_recipient(address)
                if not mapped:
                    self.send("550 Unknown or non-local recipient; relay denied")
                    continue
                if len(recipients) >= MAX_RECIPIENTS:
                    self.send("452 Too many recipients")
                    continue
                recipients.append(mapped)
                self.send("250 Recipient accepted")
            elif upper == "DATA":
                if sender is None or not recipients:
                    self.send("503 Valid sender and recipient required")
                    continue
                self.send("354 End data with <CRLF>.<CRLF>")
                body = bytearray()
                too_big = False
                ended = False
                while True:
                    try:
                        chunk = self.rfile.readline(MAX_LINE + 1)
                    except (OSError, TimeoutError):
                        break
                    if not chunk:
                        break
                    if chunk in (b".\r\n", b".\n"):
                        ended = True
                        break
                    if chunk.startswith(b".."):
                        chunk = chunk[1:]
                    if len(chunk) > MAX_LINE or len(body) + len(chunk) > MAX_DATA:
                        too_big = True
                    if not too_big:
                        body.extend(chunk)
                if not ended:
                    break
                if too_big:
                    self.send("552 Message exceeds maximum size")
                else:
                    try:
                        subject, text = parse_body(bytes(body))
                        for recipient in dict.fromkeys(recipients):
                            self.server.router.deliver_inbound(sender or "mailer-daemon@localhost",
                                                               recipient, subject, text)
                    except (MailError, OSError, UnicodeError, ValueError):
                        self.send("451 Local mailbox storage error")
                    else:
                        self.send("250 Queued in private agent inbox")
                sender, recipients = None, []
            elif upper == "STARTTLS":
                self.send("454 TLS unavailable on local-only SMTP interface")
            else:
                self.send("502 Command not implemented")
