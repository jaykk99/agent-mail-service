"""Local-only email routing for agent identities.

Addresses use the reserved .invalid TLD and are NOT routable on the internet.
This module intentionally has no SMTP, MX, or public mail delivery behavior.
"""
import re
import sqlite3

INTERNAL_DOMAIN = 'agents.invalid'
ALIAS_RE = re.compile(r'^[a-z][a-z0-9._-]{0,31}$')
MAX_ALIASES_PER_AGENT = 10


class MailError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class LocalMailRouter:
    def __init__(self, db_path, identities):
        self.db_path = db_path
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS local_mailboxes (
                    address TEXT PRIMARY KEY,
                    owner TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS local_mailboxes_owner
                    ON local_mailboxes(owner);
                CREATE TABLE IF NOT EXISTS local_emails (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender TEXT NOT NULL,
                    recipient TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    body TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS local_emails_recipient_id
                    ON local_emails(recipient, id);
            """)
            for extension, identity in identities.items():
                address = identity['agentId'] + '@' + INTERNAL_DOMAIN
                db.execute('INSERT OR IGNORE INTO local_mailboxes(address,owner) VALUES (?,?)',
                           (address, extension))

    def connection(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.execute('PRAGMA busy_timeout=10000')
        return db

    def has_address(self, address):
        with self.connection() as db:
            return db.execute('SELECT 1 FROM local_mailboxes WHERE address=?',
                              (address,)).fetchone() is not None

    def deliver_inbound(self, envelope_sender, recipient, subject, body):
        """Accept pre-routed SMTP mail for a LOCAL mailbox only.

        A remote envelope sender does not own an agent's From address, so
        this path is intentionally separate from authenticated local sends.
        Never forward to arbitrary recipient domains.
        """
        if not isinstance(envelope_sender, str) or len(envelope_sender) > 254:
            raise MailError('Invalid envelope sender')
        if not isinstance(recipient, str) or not recipient.endswith('@' + INTERNAL_DOMAIN):
            raise MailError('Recipient is not an internal mailbox', 550)
        if not isinstance(subject, str) or len(subject) > 200:
            raise MailError('Invalid subject')
        if not isinstance(body, str) or not (1 <= len(body) <= 10000):
            raise MailError('Invalid text body')
        with self.connection() as db:
            if not db.execute('SELECT 1 FROM local_mailboxes WHERE address=?',
                              (recipient,)).fetchone():
                raise MailError('Unknown internal mailbox', 550)
            cur = db.execute('INSERT INTO local_emails(sender,recipient,subject,body) VALUES (?,?,?,?)',
                             (envelope_sender, recipient, subject, body))
            return cur.lastrowid

    def addresses(self, owner):
        with self.connection() as db:
            return [r[0] for r in db.execute(
                'SELECT address FROM local_mailboxes WHERE owner=? ORDER BY address', (owner,))]

    def create_alias(self, owner, prefix):
        if not isinstance(prefix, str) or not ALIAS_RE.fullmatch(prefix):
            raise MailError('prefix must begin with a lowercase letter and use up to 32 lowercase letters, digits, dots, dashes, or underscores')
        address = prefix + '@' + INTERNAL_DOMAIN
        # IMMEDIATE locks across processes, making count/collision handling atomic.
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT owner FROM local_mailboxes WHERE address=?', (address,)).fetchone()
            if previous:
                if previous[0] == owner:
                    return address
                raise MailError('Email alias belongs to another agent', 409)
            count = db.execute('SELECT COUNT(*) FROM local_mailboxes WHERE owner=?', (owner,)).fetchone()[0]
            if count >= MAX_ALIASES_PER_AGENT:
                raise MailError('At most 10 internal email aliases per agent', 429)
            db.execute('INSERT INTO local_mailboxes(address,owner) VALUES (?,?)', (address, owner))
        return address

    def send(self, owner, sender, recipient, subject, body):
        if not isinstance(sender, str) or not isinstance(recipient, str):
            raise MailError('from and to must be email address strings')
        if not isinstance(subject, str) or len(subject) > 200:
            raise MailError('subject must be at most 200 characters')
        if not isinstance(body, str) or not (1 <= len(body) <= 10000):
            raise MailError('text must contain 1-10000 characters')
        with self.connection() as db:
            current = db.execute('SELECT owner FROM local_mailboxes WHERE address=?', (sender,)).fetchone()
            if current is None or current[0] != owner:
                raise MailError('from address not owned by this agent', 403)
            if db.execute('SELECT 1 FROM local_mailboxes WHERE address=?', (recipient,)).fetchone() is None:
                raise MailError('Unknown internal recipient; cannot deliver public internet email', 404)
            cur = db.execute('INSERT INTO local_emails(sender,recipient,subject,body) VALUES (?,?,?,?)',
                             (sender, recipient, subject, body))
            return cur.lastrowid

    def inbox(self, owner, after=0, limit=50):
        with self.connection() as db:
            rows = db.execute("""
                SELECT id,sender,recipient,subject,body,created_at FROM local_emails
                WHERE recipient IN (SELECT address FROM local_mailboxes WHERE owner=?)
                AND id>? ORDER BY id LIMIT ?
            """, (owner, after, limit)).fetchall()
        return [{'id': ident, 'from': sender, 'to': recipient, 'subject': subject,
                 'text': body, 'createdAt': created_at}
                for ident, sender, recipient, subject, body, created_at in rows]
