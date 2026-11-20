"""Self-hosted SMTP/IMAP for registered Monico agents; no external email API.

Requires a *real* local Postfix/Dovecot installation with trusted TLS. A domain,
public reachability and DNS records are still required for internet delivery.
"""
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import parseaddr
import hmac
import imaplib
import re
import smtplib
import sqlite3
import ssl
import time

ADDRESS = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}\Z")
UID = re.compile(r"[1-9][0-9]{0,19}\Z")


class SelfHostedMail:
    def __init__(self, registry, host):
        self.registry = registry
        expected = "mail." + registry.domain
        if host.lower().strip(".") != expected:
            raise ValueError(f"Mail host must be {expected} (for TLS and anti-SSRF)")
        self.host = expected
        with registry.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS smtp_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
                attempted INTEGER NOT NULL
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS smtp_sent (
                id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
                recipient TEXT NOT NULL, subject TEXT NOT NULL, sent INTEGER NOT NULL
            )""")

    def authenticate(self, agent_id, agent_token, mail_password):
        address = self.registry.get_email(agent_id, agent_token)
        if not isinstance(mail_password, str) or not mail_password:
            raise ValueError("Mail password required")
        with self.registry.connect() as db:
            row = db.execute("SELECT password_hash FROM mail_accounts WHERE email=?",
                             (address,)).fetchone()
        if row is None or not hmac.compare_digest(
                self.registry.hash_token(mail_password), row[0]):
            raise ValueError("Invalid mailbox credentials")
        return address

    def _imap(self, address, password):
        client = imaplib.IMAP4_SSL(self.host, 993,
                                  ssl_context=ssl.create_default_context(), timeout=25)
        try:
            client.login(address, password)
            return client
        except Exception:
            client.logout()
            raise

    def send(self, agent_id, agent_token, mail_password, recipient, subject, body):
        address = self.authenticate(agent_id, agent_token, mail_password)
        if not isinstance(recipient, str) or len(recipient) > 254 or not ADDRESS.fullmatch(recipient):
            raise ValueError("One valid recipient email address is required")
        if not isinstance(subject, str) or len(subject) > 200 or "\r" in subject or "\n" in subject:
            raise ValueError("Invalid subject")
        if not isinstance(body, str) or not 0 < len(body.encode("utf-8")) <= 100_000:
            raise ValueError("Message body must be 1-100,000 bytes")
        now = int(time.time())
        # Reserve a quota slot *before* opening SMTP, including failed submissions.
        # This blocks repeated attempts; it does not guarantee mail provider acceptance.
        with self.registry.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("""SELECT COUNT(*) FROM smtp_attempts
                                  WHERE agent_id=? AND attempted>?""",
                               (agent_id, now - 3600)).fetchone()[0]
            all_count = db.execute("""SELECT COUNT(*) FROM smtp_attempts
                                     WHERE attempted>?""", (now - 3600,)).fetchone()[0]
            if count >= 10 or all_count >= 1000:
                raise ValueError("Hourly SMTP submission limit reached")
            db.execute("INSERT INTO smtp_attempts(agent_id, attempted) VALUES (?,?)",
                       (agent_id, now))
        msg = EmailMessage()
        msg["From"] = address
        msg["To"] = recipient
        msg["Subject"] = subject
        msg.set_content(body)
        with smtplib.SMTP(self.host, 587, timeout=25) as smtp:
            smtp.ehlo()
            smtp.starttls(context=ssl.create_default_context())
            smtp.ehlo()
            smtp.login(address, mail_password)
            smtp.send_message(msg)
        with self.registry.connect() as db:
            db.execute("INSERT INTO smtp_sent(agent_id,recipient,subject,sent) VALUES (?,?,?,?)",
                       (agent_id, recipient, subject, now))
        return {"submitted": True, "from": address, "to": recipient,
                "note": "Your own SMTP server accepted it; recipient delivery is not guaranteed"}

    @staticmethod
    def _response_bytes(items):
        return next((part[1] for part in items
                     if isinstance(part, tuple) and isinstance(part[1], bytes)), None)

    def inbox(self, agent_id, agent_token, mail_password, limit=20):
        address = self.authenticate(agent_id, agent_token, mail_password)
        if not isinstance(limit, int) or not 1 <= limit <= 50:
            raise ValueError("Limit must be 1-50")
        client = self._imap(address, mail_password)
        try:
            status, _ = client.select("INBOX", readonly=True)
            if status != "OK":
                raise RuntimeError("IMAP INBOX selection failed")
            status, data = client.uid("search", None, "ALL")
            if status != "OK":
                raise RuntimeError("IMAP inbox search failed")
            uids = (data[0] or b"").split()[-limit:][::-1]
            result = []
            for item in uids:
                uid = item.decode("ascii")
                if not UID.fullmatch(uid):
                    continue
                status, fetched = client.uid("fetch", uid, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                if status != "OK":
                    continue
                headers = self._response_bytes(fetched)
                if headers is None:
                    continue
                message = BytesParser(policy=policy.default).parsebytes(headers, headersonly=True)
                result.append({"uid": uid, "from": parseaddr(str(message.get("From", "")))[1],
                               "subject": str(message.get("Subject", ""))[:200],
                               "date": str(message.get("Date", ""))[:100]})
            return result
        finally:
            client.logout()

    def read(self, agent_id, agent_token, mail_password, uid):
        address = self.authenticate(agent_id, agent_token, mail_password)
        uid = str(uid)
        if not UID.fullmatch(uid):
            raise ValueError("Invalid IMAP message UID")
        client = self._imap(address, mail_password)
        try:
            status, _ = client.select("INBOX", readonly=True)
            if status != "OK":
                raise RuntimeError("IMAP INBOX selection failed")
            status, fetched = client.uid("fetch", uid, "(BODY.PEEK[])")
            if status != "OK":
                raise ValueError("IMAP message unavailable")
            raw = self._response_bytes(fetched)
            if not raw:
                raise ValueError("Message not found")
            if len(raw) > 2_000_000:
                raise ValueError("Message too large for MCP reader")
            msg = BytesParser(policy=policy.default).parsebytes(raw)
            plain = msg.get_body(preferencelist=("plain",))
            try:
                body = plain.get_content()[:100_000] if plain else "[No plain-text body]"
            except (LookupError, UnicodeError, ValueError):
                body = "[Unable to decode message body]"
            return {"uid": uid, "from": parseaddr(str(msg.get("From", "")))[1],
                    "to": address, "subject": str(msg.get("Subject", ""))[:200],
                    "body": body}
        finally:
            client.logout()

    def sent(self, agent_id, agent_token, limit=20):
        self.registry.get_email(agent_id, agent_token)
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Limit must be 1-100")
        with self.registry.connect() as db:
            rows = db.execute("""SELECT id, recipient, subject, sent FROM smtp_sent
                                 WHERE agent_id=? ORDER BY id DESC LIMIT ?""",
                              (agent_id, limit)).fetchall()
        return [{"id": i, "to": r, "subject": s, "submitted_at": t} for i, r, s, t in rows]
