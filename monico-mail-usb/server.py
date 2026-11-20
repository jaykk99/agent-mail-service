"""Private management MCP for independent self-hosted mailboxes."""
import hmac
import os
from pathlib import Path
from fastmcp import FastMCP
from fastmcp.server.auth import StaticTokenVerifier
from monico_core import Registry
from mailbox_claims import MailboxClaims
from selfhost.mail_client import SelfHostedMail

ADMIN_KEY = os.environ.get("MONICO_ADMIN_KEY")
if not ADMIN_KEY or len(ADMIN_KEY) < 32:
    raise RuntimeError("Set MONICO_ADMIN_KEY to a random secret of at least 32 characters")
DATA = Path(os.environ.get("MONICO_DATA", "/mnt/monico"))
DOMAIN = os.environ.get("MONICO_DOMAIN", "mail.example.invalid")
registry = Registry(DATA, DOMAIN)
claims = MailboxClaims(registry, capacity=int(os.environ.get("MONICO_MAX_MAILBOXES", "1000")))
self_hosted_mail = SelfHostedMail(registry, os.environ["MONICO_MAIL_HOST"]) if os.environ.get("MONICO_MAIL_HOST") else None
# Transport-level protection is mandatory even on localhost. Use a separate
# secret from the admin provisioning key, and never commit either secret.
MCP_BEARER_TOKEN = os.environ.get("MONICO_MCP_BEARER_TOKEN")
if not MCP_BEARER_TOKEN or len(MCP_BEARER_TOKEN) < 32:
    raise RuntimeError("Set MONICO_MCP_BEARER_TOKEN to a random secret of at least 32 characters")
auth = StaticTokenVerifier(tokens={
    MCP_BEARER_TOKEN: {"sub": "monico-operator", "client_id": "monico-operator"}
})
mcp = FastMCP("Monico Mail", auth=auth)

@mcp.tool()
def register_agent(admin_key: str, agent_id: str, desired_name: str) -> dict:
    """Admin-only: provision or retrieve an agent identity. Token returned once."""
    if not hmac.compare_digest(admin_key, ADMIN_KEY):
        raise ValueError("Unauthorized")
    return registry.register(agent_id, desired_name)

@mcp.tool()
def create_invites(admin_key: str, count: int = 1, valid_days: int = 7) -> dict:
    """Admin-only: generate single-use invites. Agents choose their own email names."""
    if not hmac.compare_digest(admin_key, ADMIN_KEY):
        raise ValueError("Unauthorized")
    return claims.issue_invites(count, valid_days)

@mcp.tool()
def check_email_name(desired_name: str) -> dict:
    """Check whether an email name is available on the configured Monico domain."""
    return claims.name_available(desired_name)

@mcp.tool()
def claim_my_email(invitation_code: str, desired_name: str) -> dict:
    """Choose your own unique email name using a one-time invitation."""
    return claims.claim(invitation_code, desired_name)

@mcp.tool()
def get_domain_info(admin_key: str) -> dict:
    """Admin-only: current domain, used mailboxes, pending invitations and capacity."""
    if not hmac.compare_digest(admin_key, ADMIN_KEY):
        raise ValueError("Unauthorized")
    return claims.slots()

@mcp.tool()
def get_my_email(agent_id: str, agent_token: str) -> str:
    """Look up the permanent email assignment."""
    return registry.get_email(agent_id, agent_token)

@mcp.tool()
def rotate_agent_key(agent_id: str, agent_token: str) -> dict:
    """Rotate an agent credential, invalidating its previous key."""
    return {"agent_token": registry.rotate(agent_id, agent_token)}

@mcp.tool()
def get_mail_status(agent_id: str, agent_token: str) -> dict:
    """Report current capability honestly."""
    local_email = registry.get_email(agent_id, agent_token)
    return {"email": local_email, "mailbox_credentials_issued": True,
            "self_hosted_imap_smtp_configured": self_hosted_mail is not None,
            "external_delivery_verified": False, "public_mcp_ready": False}

@mcp.tool()
def send_internal_mail(agent_id: str, agent_token: str, recipient: str, subject: str, body: str) -> dict:
    """Send a message to another registered Monico agent; no internet delivery."""
    return registry.send_internal(agent_id, agent_token, recipient, subject, body)

@mcp.tool()
def list_inbox(agent_id: str, agent_token: str, limit: int = 20) -> list:
    """List this agent's received local messages."""
    return registry.inbox(agent_id, agent_token, limit)

@mcp.tool()
def read_mail(agent_id: str, agent_token: str, message_id: int) -> dict:
    """Read a message addressed to this authenticated agent."""
    return registry.read_message(agent_id, agent_token, message_id)

@mcp.tool()
def rotate_mail_password(agent_id: str, agent_token: str) -> dict:
    """Issue a new independent IMAP/SMTP mailbox password, invalidating the old one."""
    return registry.rotate_mail_password(agent_id, agent_token)

@mcp.tool()
def count_mailboxes(admin_key: str) -> int:
    """Admin-only registry count (supports 1,000+ independent entries)."""
    if not hmac.compare_digest(admin_key, ADMIN_KEY):
        raise ValueError("Unauthorized")
    return registry.mailbox_count()

@mcp.tool()
def send_real_email(agent_id: str, agent_token: str, mail_password: str,
                    recipient: str, subject: str, body: str) -> dict:
    """Submit genuine SMTP mail using THIS agent's own self-hosted mailbox."""
    if self_hosted_mail is None:
        raise ValueError("Set MONICO_MAIL_HOST after your own Postfix/Dovecot are configured")
    return self_hosted_mail.send(agent_id, agent_token, mail_password, recipient, subject, body)

@mcp.tool()
def list_real_inbox(agent_id: str, agent_token: str, mail_password: str,
                    limit: int = 20) -> list:
    """Read message headers from THIS agent's real Dovecot IMAP inbox."""
    if self_hosted_mail is None:
        raise ValueError("Self-hosted mail server is not configured")
    return self_hosted_mail.inbox(agent_id, agent_token, mail_password, limit)

@mcp.tool()
def read_real_email(agent_id: str, agent_token: str, mail_password: str,
                    imap_uid: str) -> dict:
    """Read plain-text content from THIS agent's actual IMAP inbox."""
    if self_hosted_mail is None:
        raise ValueError("Self-hosted mail server is not configured")
    return self_hosted_mail.read(agent_id, agent_token, mail_password, imap_uid)

@mcp.tool()
def list_real_sent(agent_id: str, agent_token: str, limit: int = 20) -> list:
    """List recent SMTP submissions tracked locally for this agent."""
    if self_hosted_mail is None:
        raise ValueError("Self-hosted mail server is not configured")
    return self_hosted_mail.sent(agent_id, agent_token, limit)

if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8787)
