"""Self-service selection of independent email names using one-time invitations.

An operator issues cryptographically random invitations. An agent uses ONE invitation
to claim its own unique mailbox name. This is local/private MCP onboarding only:
HTTP access controls and public service deployment are separate.
"""
import secrets
import sqlite3
import time

from monico_core import LOCAL_RE, RESERVED, AGENT_COUNT_SQL


class MailboxClaims:
    def __init__(self, registry, capacity=None):
        self.registry = registry
        if capacity is None:
            capacity = registry.capacity
        if not isinstance(capacity, int) or capacity < 1 or capacity > registry.capacity:
            raise ValueError("Capacity must be 1 through the registry's configured agent capacity")
        self.capacity = capacity
        with registry.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS mailbox_invites (
                code_hash TEXT PRIMARY KEY,
                created INTEGER NOT NULL,
                expires INTEGER NOT NULL,
                redeemed INTEGER,
                agent_id TEXT
            )""")

    @staticmethod
    def normalize_name(desired_name):
        if not isinstance(desired_name, str):
            raise ValueError("Name must be text")
        local = desired_name.strip().lower()
        if (not LOCAL_RE.fullmatch(local) or ".." in local
                or local in RESERVED or len(local) > 64):
            raise ValueError("Choose a different name: use letters, numbers, dots, - or _")
        return local

    def name_available(self, desired_name):
        local = self.normalize_name(desired_name)
        email = f"{local}@{self.registry.domain}"
        with self.registry.connect() as db:
            exists = db.execute("SELECT 1 FROM agents WHERE email=?", (email,)).fetchone()
        return {"requested_name": local, "email": email, "available": not bool(exists)}

    def issue_invites(self, count=1, days=7):
        """Operator-only entry point; raw codes are never persisted or retrievable."""
        if not isinstance(count, int) or not 1 <= count <= 200:
            raise ValueError("Issue between 1 and 200 codes at once")
        if not isinstance(days, int) or not 1 <= days <= 30:
            raise ValueError("Invitation lifespan must be between 1 and 30 days")
        now = int(time.time())
        codes = [secrets.token_urlsafe(24) for _ in range(count)]
        with self.registry.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                "SELECT COUNT(*) FROM mailbox_invites WHERE redeemed IS NULL AND expires>?",
                (now,)).fetchone()[0]
            mailboxes = db.execute(AGENT_COUNT_SQL).fetchone()[0]
            if active + mailboxes + count > self.capacity:
                raise ValueError("Not enough available mailbox slots; use or expire prior invitations")
            db.executemany(
                "INSERT INTO mailbox_invites(code_hash,created,expires) VALUES (?,?,?)",
                [(self.registry.hash_token(code), now, now + days * 86400) for code in codes])
        return {"codes": codes, "expires_at": now + days * 86400,
                "remaining_slots_after_issue": self.capacity - mailboxes - active - count}

    def claim(self, invite_code, desired_name):
        """An agent chooses its local-part. The invitation is consumed atomically."""
        local = self.normalize_name(desired_name)
        if not isinstance(invite_code, str) or len(invite_code) < 20:
            raise ValueError("Invalid invitation")
        code_hash = self.registry.hash_token(invite_code)
        now = int(time.time())
        email = f"{local}@{self.registry.domain}"
        with self.registry.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT expires,redeemed FROM mailbox_invites WHERE code_hash=?",
                (code_hash,)).fetchone()
            if row is None or row[0] <= now or row[1] is not None:
                raise ValueError("Invitation invalid, expired, or already used")
            mailboxes = db.execute(AGENT_COUNT_SQL).fetchone()[0]
            if mailboxes >= self.capacity:
                raise ValueError("Mailbox capacity reached")
            agent_id = "mb_" + secrets.token_hex(16)
            agent_token = secrets.token_urlsafe(32)
            mail_password = secrets.token_urlsafe(32)
            try:
                db.execute("INSERT INTO agents(agent_id,email,token_hash,created) VALUES (?,?,?,?)",
                           (agent_id, email, self.registry.hash_token(agent_token), now))
                db.execute("""INSERT INTO mail_accounts(email,password_hash,created)
                              VALUES (?,?,?)""",
                           (email, self.registry.hash_token(mail_password), now))
            except sqlite3.IntegrityError as error:
                raise ValueError("That email name is already claimed") from error
            db.execute(
                "UPDATE mailbox_invites SET redeemed=?,agent_id=? WHERE code_hash=? AND redeemed IS NULL",
                (now, agent_id, code_hash))
        return {"agent_id": agent_id, "email": email, "agent_token": agent_token,
                "mail_password": mail_password, "existing": False,
                "message": "Save both credentials securely; they will not be shown again"}

    def slots(self):
        now = int(time.time())
        with self.registry.connect() as db:
            used = db.execute(AGENT_COUNT_SQL).fetchone()[0]
            pending = db.execute(
                "SELECT COUNT(*) FROM mailbox_invites WHERE redeemed IS NULL AND expires>?",
                (now,)).fetchone()[0]
        return {"domain": self.registry.domain, "capacity": self.capacity,
                "registered": used, "pending_invitations": pending,
                "unreserved_slots": max(0, self.capacity - used - pending)}
