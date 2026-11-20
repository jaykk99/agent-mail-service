import os
import sqlite3
import secrets
import hashlib
import hmac
import time
import re
from pathlib import Path
from fastmcp import FastMCP

ROOT = Path(os.environ.get("MONICO_DATA", "/mnt/monico")).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
DB = ROOT / "agents.sqlite3"
DOMAIN = os.environ.get("MONICO_DOMAIN", "mail.example.invalid")
ADMIN_KEY = os.environ.get("MONICO_ADMIN_KEY")
if not ADMIN_KEY:
    raise RuntimeError("Set MONICO_ADMIN_KEY to a strong random secret")

mcp = FastMCP("Monico Mail")

def conn():
    c = sqlite3.connect(DB)
    c.execute("CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL, created INTEGER NOT NULL)")
    return c

def digest(s):
    return hashlib.sha256(s.encode()).hexdigest()

def identity(agent_id, token):
    with conn() as c:
        row = c.execute("SELECT email, token_hash FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
    if not row or not hmac.compare_digest(digest(token), row[1]):
        raise ValueError("Unauthorized")
    return row[0]

@mcp.tool()
def register_agent(admin_key: str, agent_id: str, desired_name: str) -> dict:
    """Admin-provision a permanent agent identity; returns token once."""
    if not hmac.compare_digest(admin_key, ADMIN_KEY):
        raise ValueError("Unauthorized")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,62}", desired_name):
        raise ValueError("Invalid mailbox name")
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,128}", agent_id):
        raise ValueError("Invalid agent ID")
    with conn() as c:
        old = c.execute("SELECT email FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
        if old:
            return {"email": old[0], "existing": True}
        token = secrets.token_urlsafe(32)
        email = f"{desired_name}@{DOMAIN}"
        try:
            c.execute("INSERT INTO agents VALUES (?,?,?,?)", (agent_id, email, digest(token), int(time.time())))
        except sqlite3.IntegrityError:
            raise ValueError("Email already claimed")
    return {"email": email, "agent_id": agent_id, "token": token, "existing": False}

@mcp.tool()
def get_my_email(agent_id: str, agent_token: str) -> str:
    """Return the same assigned address on every connection."""
    return identity(agent_id, agent_token)

@mcp.tool()
def get_mail_status(agent_id: str, agent_token: str) -> dict:
    """Check registration status; public mail transport is not implemented."""
    return {"email": identity(agent_id, agent_token), "transport_ready": False}

if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8787)
