"""Self-hosted mailbox identity and credentials; public SMTP deployment is separate."""
import hashlib
import hmac
import re
import secrets
import sqlite3
import time
from pathlib import Path

AGENT_RE = re.compile(r"[A-Za-z0-9_-]{3,128}\Z")
LOCAL_RE = re.compile(r"[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\Z")
RESERVED = {"admin", "postmaster", "abuse", "hostmaster", "webmaster", "security", "root"}

class Registry:
    def __init__(self, directory, domain):
        self.directory = Path(directory).resolve()
        if not self.directory.is_dir():
            raise RuntimeError("USB data directory missing; refusing to use internal disk")
        if not isinstance(domain, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,252}", domain):
            raise ValueError("Invalid mailbox domain")
        self.domain = domain
        self.db = self.directory / "agents.sqlite3"
        with self.connect() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                token_hash TEXT NOT NULL,
                created INTEGER NOT NULL
            )""")
            c.execute("""CREATE TABLE IF NOT EXISTS config (
                name TEXT PRIMARY KEY, value TEXT NOT NULL
            )""")
            stored = c.execute("SELECT value FROM config WHERE name='domain'").fetchone()
            if stored:
                if stored[0] != domain:
                    raise RuntimeError(
                        f"Database belongs to domain {stored[0]}, not {domain}. "
                        "Refusing silent email address changes.")
            else:
                # Existing installs may have accounts predating domain locking.
                domains = {email.rsplit("@", 1)[-1] for (email,) in
                           c.execute("SELECT email FROM agents")}
                if domains and domains != {domain}:
                    raise RuntimeError("Existing account domains do not match MONICO_DOMAIN")
                c.execute("INSERT INTO config(name,value) VALUES ('domain',?)", (domain,))
            c.execute("""CREATE TABLE IF NOT EXISTS mail_accounts (
                email TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                created INTEGER NOT NULL
            )""")
            c.execute("""CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)""")

    def connect(self):
        c = sqlite3.connect(self.db, timeout=20)
        c.execute("PRAGMA busy_timeout=20000")
        return c

    @staticmethod
    def hash_token(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def register(self, agent_id, desired_name):
        if not AGENT_RE.fullmatch(agent_id):
            raise ValueError("Invalid agent ID")
        if not LOCAL_RE.fullmatch(desired_name) or ".." in desired_name or desired_name in RESERVED:
            raise ValueError("Invalid or reserved email name")
        with self.connect() as c:
            old = c.execute("SELECT email FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
            if old:
                return {"email": old[0], "agent_id": agent_id, "existing": True}
            token = secrets.token_urlsafe(32)
            mail_password = secrets.token_urlsafe(32)
            email = f"{desired_name}@{self.domain}"
            try:
                c.execute("INSERT INTO agents VALUES (?,?,?,?)",
                          (agent_id, email, self.hash_token(token), int(time.time())))
                c.execute("INSERT INTO mail_accounts VALUES (?,?,?)",
                          (email, self.hash_token(mail_password), int(time.time())))
            except sqlite3.IntegrityError as e:
                raise ValueError("Email name already claimed") from e
        return {"email": email, "agent_id": agent_id, "token": token,
                "mail_password": mail_password, "existing": False}

    def get_email(self, agent_id, token):
        if not token or not agent_id:
            raise ValueError("Unauthorized")
        with self.connect() as c:
            row = c.execute("SELECT email, token_hash FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
        if row is None or not hmac.compare_digest(self.hash_token(token), row[1]):
            raise ValueError("Unauthorized")
        return row[0]

    def rotate(self, agent_id, token):
        self.get_email(agent_id, token)
        new = secrets.token_urlsafe(32)
        with self.connect() as c:
            c.execute("UPDATE agents SET token_hash=? WHERE agent_id=? AND token_hash=?",
                      (self.hash_token(new), agent_id, self.hash_token(token)))
            if c.total_changes != 1:
                raise ValueError("Credential was already rotated")
        return new

    def send_internal(self, agent_id, token, recipient, subject, body):
        """Deliver locally only to another registered Monico identity."""
        sender = self.get_email(agent_id, token)
        if not isinstance(recipient, str) or not isinstance(subject, str) or not isinstance(body, str):
            raise ValueError("Invalid message fields")
        if len(subject) > 200 or len(body) > 100000:
            raise ValueError("Message exceeds size limit")
        with self.connect() as c:
            found = c.execute("SELECT 1 FROM agents WHERE email=?", (recipient,)).fetchone()
            if not found:
                raise ValueError("Recipient is not a registered local Monico mailbox")
            cur = c.execute("INSERT INTO messages(sender,recipient,subject,body,created) VALUES(?,?,?,?,?)",
                            (sender, recipient, subject, body, int(time.time())))
            return {"message_id": cur.lastrowid, "from": sender, "to": recipient, "delivered_locally": True}

    def inbox(self, agent_id, token, limit=20):
        email = self.get_email(agent_id, token)
        if not isinstance(limit, int) or not 1 <= limit <= 100:
            raise ValueError("Limit must be 1-100")
        with self.connect() as c:
            rows = c.execute("SELECT id,sender,subject,created FROM messages WHERE recipient=? ORDER BY id DESC LIMIT ?",
                             (email, limit)).fetchall()
        return [{"id": mid, "from": sender, "subject": subject, "created": created}
                for mid, sender, subject, created in rows]

    def read_message(self, agent_id, token, message_id):
        email = self.get_email(agent_id, token)
        with self.connect() as c:
            row = c.execute("SELECT id,sender,recipient,subject,body,created FROM messages WHERE id=? AND recipient=?",
                            (message_id, email)).fetchone()
        if not row:
            raise ValueError("Message not found")
        return dict(zip(("id", "from", "to", "subject", "body", "created"), row))

    def rotate_mail_password(self, agent_id, token):
        """Issue a fresh independent IMAP/SMTP password; shown only once."""
        email = self.get_email(agent_id, token)
        password = secrets.token_urlsafe(32)
        with self.connect() as c:
            c.execute("""INSERT INTO mail_accounts(email,password_hash,created) VALUES (?,?,?)
                         ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,
                         created=excluded.created""", (email, self.hash_token(password), int(time.time())))
        return {"email": email, "mail_password": password}

    def mailbox_count(self):
        with self.connect() as c:
            return c.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
