"""Self-hosted WebPhone guest invitations: browser calling without carrier numbers.

No SIP trunk, SIM, public telephone identity, cloud service or 3rd-party API.
Invites are short-lived, single-use and scoped to one agent extension.
Only hashes of bearer secrets are persisted in SQLite.
"""
from contextlib import contextmanager
import hashlib
import secrets
import sqlite3
import time

MAX_ACTIVE_INVITES = 10
MAX_ACTIVE_GUESTS = 20
MAX_SESSION_SECONDS = 1800


class WebPhoneError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def token_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class WebPhone:
    def __init__(self, database):
        self.database = database
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS webphone_invites(
                    token_hash TEXT PRIMARY KEY,
                    owner TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    used INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS webphone_invites_owner
                    ON webphone_invites(owner, expires_at, used);
                CREATE TABLE IF NOT EXISTS webphone_sessions(
                    id TEXT PRIMARY KEY,
                    invite_hash TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    owner TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS webphone_sessions_owner
                    ON webphone_sessions(owner, expires_at);
            """)

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.database, timeout=10)
        connection.execute("PRAGMA busy_timeout=10000")
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def create_invite(self, owner, ttl_minutes=30):
        if type(ttl_minutes) is not int or not 5 <= ttl_minutes <= 120:
            raise WebPhoneError("ttlMinutes must be a whole number from 5 to 120")
        now = int(time.time())
        token = secrets.token_urlsafe(32)
        token_digest = token_hash(token)
        expires = now + ttl_minutes * 60
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM webphone_sessions WHERE expires_at<=?", (now,))
            db.execute("DELETE FROM webphone_invites WHERE expires_at<=?", (now,))
            pending = db.execute(
                "SELECT COUNT(*) FROM webphone_invites WHERE owner=? AND used=0 AND expires_at>?",
                (owner, now)
            ).fetchone()[0]
            if pending >= MAX_ACTIVE_INVITES:
                raise WebPhoneError("Too many outstanding guest links", 429)
            db.execute(
                "INSERT INTO webphone_invites(token_hash,owner,expires_at,created_at) VALUES(?,?,?,?)",
                (token_digest, owner, expires, now)
            )
        return {"extension": owner, "webNumber": "web:" + owner,
                "path": "/call/" + token, "expiresAt": expires,
                "singleUse": True, "carrierPhoneNumber": False}

    def open_session(self, link_token):
        if not isinstance(link_token, str) or len(link_token) > 128 or len(link_token) < 24:
            raise WebPhoneError("Invalid call invitation", 404)
        now = int(time.time())
        identity = "wg_" + secrets.token_urlsafe(12)
        bearer = secrets.token_urlsafe(32)
        hashed = token_hash(link_token)
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            invitation = db.execute(
                "SELECT owner,expires_at,used FROM webphone_invites WHERE token_hash=?",
                (hashed,)
            ).fetchone()
            if invitation is None or invitation[1] <= now or invitation[2]:
                raise WebPhoneError("Call invitation expired or already used", 410)
            owner, invite_expires, _ = invitation
            active = db.execute(
                "SELECT COUNT(*) FROM webphone_sessions WHERE owner=? AND expires_at>?",
                (owner, now)
            ).fetchone()[0]
            if active >= MAX_ACTIVE_GUESTS:
                raise WebPhoneError("This extension has too many active callers", 429)
            db.execute("UPDATE webphone_invites SET used=1 WHERE token_hash=?", (hashed,))
            expires = min(invite_expires, now + MAX_SESSION_SECONDS)
            db.execute(
                "INSERT INTO webphone_sessions(id,invite_hash,token_hash,owner,expires_at) "
                "VALUES(?,?,?,?,?)", (identity, hashed, token_hash(bearer), owner, expires)
            )
        return {"sessionId": identity, "token": bearer, "extension": owner,
                "webNumber": "web:" + owner, "expiresAt": expires, "carrierCall": False}

    def authenticate_guest(self, authorization):
        if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
            return None
        token = authorization[7:]
        if not 24 <= len(token) <= 128:
            return None
        now = int(time.time())
        with self.db() as db:
            session = db.execute(
                "SELECT id,owner,expires_at FROM webphone_sessions "
                "WHERE token_hash=? AND expires_at>?",
                (token_hash(token), now)
            ).fetchone()
        if not session:
            return None
        return {"id": session[0], "address": "guest:" + session[0],
                "owner": session[1], "expiresAt": session[2]}

    def can_agent_reply(self, owner, guest_address):
        if not isinstance(guest_address, str) or not guest_address.startswith("guest:"):
            return False
        if len(guest_address) > 64:
            return False
        now = int(time.time())
        with self.db() as db:
            return db.execute(
                "SELECT 1 FROM webphone_sessions WHERE id=? AND owner=? AND expires_at>?",
                (guest_address[6:], owner, now)
            ).fetchone() is not None
