"""Optional real-email bridge: one authorized SMTP/IMAP account, plus-address aliases.

Agents get routing aliases under ONE real mailbox. This does not create independent
Gmail accounts or an independently owned mail domain. Never commit credentials.
"""
from dataclasses import dataclass
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses, parseaddr
import imaplib
import os
import re
import smtplib
import ssl
import time


ADDRESS_RE = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}\Z")


@dataclass(frozen=True)
class MailSettings:
    address: str
    password: str
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 465
    imap_host: str = "imap.gmail.com"
    imap_port: int = 993

    @classmethod
    def from_env(cls):
        address = os.environ.get("MONICO_MAIL_ACCOUNT", "").strip().lower()
        password = os.environ.get("MONICO_MAIL_APP_PASSWORD", "")
        if not address and not password:
            return None
        if not address or not password:
            raise RuntimeError("Set both MONICO_MAIL_ACCOUNT and MONICO_MAIL_APP_PASSWORD")
        if not ADDRESS_RE.fullmatch(address) or "+" in address.split("@", 1)[0]:
            raise RuntimeError("MONICO_MAIL_ACCOUNT must be a plain, valid mailbox address without + tagging")
        return cls(address, password, os.getenv("MONICO_SMTP_HOST", "smtp.gmail.com"),
                   int(os.getenv("MONICO_SMTP_PORT", "465")),
                   os.getenv("MONICO_IMAP_HOST", "imap.gmail.com"),
                   int(os.getenv("MONICO_IMAP_PORT", "993"))


class MailGateway:
    """SMTP outgoing and IMAP polling, with strict per-agent inbox routing."""

    def __init__(self, registry, settings):
        self.registry = registry
        self.settings = settings
        with self.registry.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS remote_seen (
                source TEXT NOT NULL, uidvalidity TEXT NOT NULL, uid TEXT NOT NULL,
                PRIMARY KEY (source, uidvalidity, uid))""")
            db.execute("""CREATE TABLE IF NOT EXISTS external_send_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
                recipient TEXT NOT NULL, at INTEGER NOT NULL)""")
            db.execute("""CREATE TABLE IF NOT EXISTS external_sent (
                id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
                recipient TEXT NOT NULL, subject TEXT NOT NULL,
                body TEXT NOT NULL, at INTEGER NOT NULL)""")

    def alias(self, agent_id, agent_token):
        identity = self.registry.get_email(agent_id, agent_token)
        local = identity.split("@", 1)[0]
        account_local, domain = self.settings.address.split("@", 1)
        if len(account_local) + len(local) + 1 > 64:
            raise ValueError("Agent name too long for this public plus-address alias")
        return f"{account_local}+{local}@{domain}"

    def _local_target(self, address):
        address = address.strip().lower()
        base, at, domain = address.partition("@")
        acct, _, acct_domain = self.settings.address.partition("@")
        if not at or domain != acct_domain or not base.startswith(acct + "+"):
            return None
        tag = base[len(acct) + 1:]
        if not tag or tag in (".", ".."):
            return None
        email = f"{tag}@{self.registry.domain}"
        with self.registry.connect() as db:
            row = db.execute("SELECT 1 FROM agents WHERE email=?", (email,)).fetchone()
        return email if row else None

    def send(self, agent_id, agent_token, recipient, subject, body):
        alias = self.alias(agent_id, agent_token)
        if not isinstance(recipient, str) or not ADDRESS_RE.fullmatch(recipient):
            raise ValueError("Recipient must be a single valid email address")
        if not isinstance(subject, str) or not isinstance(body, str):
            raise ValueError("Invalid subject or body")
        if len(subject) > 200 or len(body) > 100_000 or "\r" in subject or "\n" in subject:
            raise ValueError("Message exceeds limits or has invalid subject")
        if len(body.strip()) == 0:
            raise ValueError("Body must not be blank")
        now = int(time.time())
        # Conservative abuse controls: no bulk recipient lists; 5 per hour per
        # agent, 30 per hour per configured mailbox. Record attempts first.
        with self.registry.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            per_agent = db.execute("SELECT COUNT(*) FROM external_send_log WHERE agent_id=? AND at>=?",
                                   (agent_id, now - 3600)).fetchone()[0]
            global_count = db.execute("SELECT COUNT(*) FROM external_send_log WHERE at>=?",
                                      (now - 3600,)).fetchone()[0]
            if per_agent >= 5 or global_count >= 30:
                raise ValueError("External mail hourly limit reached")
            db.execute("INSERT INTO external_send_log(agent_id,recipient,at) VALUES (?,?,?)",
                       (agent_id, recipient, now))
        message = EmailMessage()
        message["From"] = self.settings.address  # no sender spoofing
        message["To"] = recipient
        message["Reply-To"] = alias
        message["Subject"] = subject
        message.set_content(body)
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(self.settings.smtp_host, self.settings.smtp_port,
                              context=context, timeout=25) as smtp:
            smtp.login(self.settings.address, self.settings.password)
            smtp.send_message(message)
        with self.registry.connect() as db:
            db.execute("""INSERT INTO external_sent(agent_id,recipient,subject,body,at)
                          VALUES(?,?,?,?,?)""", (agent_id, recipient, subject, body, now))
        return {"sent_via_smtp": True, "from": self.settings.address,
                "reply_to": alias, "to": recipient,
                "note": "SMTP accepted message; final delivery is not guaranteed"}

    def sent(self, agent_id, agent_token, limit=20):
        self.registry.get_email(agent_id, agent_token)
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Limit must be 1-100")
        with self.registry.connect() as db:
            rows = db.execute("""SELECT id,recipient,subject,at FROM external_sent
                                WHERE agent_id=? ORDER BY id DESC LIMIT ?""",
                              (agent_id, limit)).fetchall()
        return [{"id": mid, "to": recipient, "subject": subject, "created": at}
                for mid, recipient, subject, at in rows]

    def _ingest(self, raw, uid, uidvalidity):
        """Safely route one IMAP message. Returns number of agents delivered to."""
        source = self.settings.address
        with self.registry.connect() as db:
            if db.execute("SELECT 1 FROM remote_seen WHERE source=? AND uidvalidity=? AND uid=?",
                          (source, uidvalidity, uid)).fetchone():
                return 0
        if len(raw) > 2_000_000:
            # Mark oversized mail checked rather than endlessly re-fetching it.
            targets, sender, subject, body = set(), "", "", ""
        else:
            msg = BytesParser(policy=policy.default).parsebytes(raw)
            header_values = []
            for name in ("To", "Cc", "Delivered-To", "X-Original-To", "Envelope-To"):
                header_values.extend(str(v) for v in msg.get_all(name, []))
            targets = set()
            for _, addr in getaddresses(header_values):
                target = self._local_target(addr)
                if target:
                    targets.add(target)
            targets = set(sorted(targets)[:10])
            sender = parseaddr(str(msg.get("From", "")))[1] or "unknown"
            subject = str(msg.get("Subject", ""))[:200]
            part = msg.get_body(preferencelist=("plain",))
            try:
                body = part.get_content()[:100_000] if part else "[No plain-text content]"
            except (LookupError, ValueError, UnicodeError):
                body = "[Could not decode text content]"
        now = int(time.time())
        with self.registry.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM remote_seen WHERE source=? AND uidvalidity=? AND uid=?",
                          (source, uidvalidity, uid)).fetchone():
                return 0
            for target in targets:
                db.execute("""INSERT INTO messages(sender,recipient,subject,body,created)
                              VALUES(?,?,?,?,?)""", (sender, target, subject, body, now))
            db.execute("INSERT INTO remote_seen VALUES (?,?,?)", (source, uidvalidity, uid))
        return len(targets)

    def sync_once(self, max_scan=500):
        """Poll most recent IMAP INBOX messages without marking them read."""
        if not isinstance(max_scan, int) or not 1 <= max_scan <= 2000:
            raise ValueError("max_scan must be between 1 and 2000")
        delivered = 0
        with imaplib.IMAP4_SSL(self.settings.imap_host, self.settings.imap_port,
                              ssl_context=ssl.create_default_context(), timeout=30) as imap:
            imap.login(self.settings.address, self.settings.password)
            status, _ = imap.select("INBOX", readonly=True)
            if status != "OK":
                raise RuntimeError("Unable to select IMAP INBOX")
            _, response = imap.response("UIDVALIDITY")
            uidvalidity = response[0].decode("ascii", errors="replace") if response and response[0] else "unknown"
            status, result = imap.uid("search", None, "ALL")
            if status != "OK":
                raise RuntimeError("IMAP UID search failed")
            uids = (result[0] or b"").split()[-max_scan:]
            for raw_uid in uids:
                uid = raw_uid.decode("ascii")
                with self.registry.connect() as db:
                    already = db.execute("SELECT 1 FROM remote_seen WHERE source=? AND uidvalidity=? AND uid=?",
                                         (self.settings.address, uidvalidity, uid)).fetchone()
                if already:
                    continue
                status, parts = imap.uid("fetch", uid, "(RFC822)")
                if status != "OK":
                    continue
                raw = next((item[1] for item in parts
                            if isinstance(item, tuple) and isinstance(item[1], bytes)), None)
                if raw is not None:
                    delivered += self._ingest(raw, uid, uidvalidity)
        return {"agents_delivered_to": delivered, "uids_scanned": len(uids)}


def configured_gateway(registry):
    settings = MailSettings.from_env()
    return MailGateway(registry, settings) if settings else None
