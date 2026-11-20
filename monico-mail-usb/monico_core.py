"""Persistent mailbox identity registry; no public email transport."""
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
        self.domain = domain
        self.db = self.directory / "agents.sqlite3"
        with self.connect() as c:
            c.execute("""CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                email TEXT UNIQUE NOT NULL,
                token_hash TEXT NOT NULL,
                created INTEGER NOT NULL
            )""")

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
            email = f"{desired_name}@{self.domain}"
            try:
                c.execute("INSERT INTO agents VALUES (?,?,?,?)",
                          (agent_id, email, self.hash_token(token), int(time.time())))
            except sqlite3.IntegrityError as e:
                raise ValueError("Email name already claimed") from e
        return {"email": email, "agent_id": agent_id, "token": token, "existing": False}

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
