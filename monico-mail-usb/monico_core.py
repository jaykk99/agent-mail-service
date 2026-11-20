"""Self-hosted mailbox identity and credentials; public SMTP deployment is separate."""
import hashlib
from contextlib import contextmanager
import hmac
import re
import secrets
import sqlite3
import time
from pathlib import Path

AGENT_RE = re.compile(r"[A-Za-z0-9_-]{3,128}\Z")
LOCAL_RE = re.compile(r"[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\Z")
RESERVED = {"admin", "postmaster", "abuse", "hostmaster", "webmaster", "security", "root"}
# System mailboxes are additional operational inboxes, not agent quota slots.
SYSTEM_AGENT_IDS = ("system_postmaster", "system_abuse")
AGENT_COUNT_SQL = "SELECT COUNT(*) FROM agents WHERE agent_id NOT IN ('system_postmaster','system_abuse')"

class Registry:
    def __init__(self, directory, domain):
        self.directory = Path(directory).resolve()
        if not self.directory.is_dir():
            raise RuntimeError("USB data directory missing; refusing to use internal disk")
        if not isinstance(domain, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,252}", domain):
            raise ValueError("Invalid mailbox domain")
        self.domain = domain
        self.capacity = int(__import__("os").environ.get("MONICO_MAX_MAILBOXES", "1000"))
        if self.capacity < 1:
            raise ValueError("MONICO_MAX_MAILBOXES must be positive")
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

    @contextmanager
    def connect(self):
        """Commit or roll back the operation and always close the SQLite handle."""
        c = sqlite3.connect(self.db, timeout=20)
        try:
            c.execute("PRAGMA busy_timeout=20000")
            with c:
                yield c
        finally:
            c.close()

    @staticmethod
    def hash_token(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def register(self, agent_id, desired_name):
        if not AGENT_RE.fullmatch(agent_id) or agent_id in SYSTEM_AGENT_IDS:
            raise ValueError("Invalid or system-reserved agent ID")
        if not LOCAL_RE.fullmatch(desired_name) or ".." in desired_name or desired_name in RESERVED:
            raise ValueError("Invalid or reserved email name")
        with self.connect() as c:
            c.execute("BEGIN IMMEDIATE")
            old = c.execute("SELECT email FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
            if old:
                return {"email": old[0], "agent_id": agent_id, "existing": True}
            now = int(time.time())
            used = c.execute(AGENT_COUNT_SQL).fetchone()[0]
            table_exists = c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_invites'"
            ).fetchone()
            pending = (c.execute(
                "SELECT COUNT(*) FROM mailbox_invites WHERE redeemed IS NULL AND expires>?",
                (now,)).fetchone()[0] if table_exists else 0)
            if used + pending >= self.capacity:
                raise ValueError("Mailbox capacity reached or all remaining slots are reserved")
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

    def provision_system_mailbox(self, local_name):
        """Locally provision mandatory abuse/postmaster inboxes, not claimable by agents."""
        if local_name not in ("postmaster", "abuse"):
            raise ValueError("Only postmaster and abuse may be provisioned as system inboxes")
        agent_id = "system_" + local_name
        email = f"{local_name}@{self.domain}"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM agents WHERE email=?", (email,)).fetchone():
                return {"email": email, "agent_id": agent_id, "existing": True}
            agent_token = secrets.token_urlsafe(32)
            mail_password = secrets.token_urlsafe(32)
            now = int(time.time())
            db.execute("INSERT INTO agents(agent_id,email,token_hash,created) VALUES(?,?,?,?)",
                       (agent_id, email, self.hash_token(agent_token), now))
            db.execute("INSERT INTO mail_accounts(email,password_hash,created) VALUES(?,?,?)",
                       (email, self.hash_token(mail_password), now))
        return {"email": email, "agent_id": agent_id, "token": agent_token,
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
        """Number of ordinary agent slots used (system inboxes are additional)."""
        with self.connect() as c:
            return c.execute(AGENT_COUNT_SQL).fetchone()[0]

    def total_mailbox_count(self):
        """Total on-disk mailboxes including postmaster and abuse."""
        with self.connect() as c:
            return c.execute("SELECT COUNT(*) FROM agents").fetchone()[0]
