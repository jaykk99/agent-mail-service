"""Monico MCP prototype with HTTP bearer authentication; mail transport not implemented."""
import hmac
import os
from pathlib import Path
from fastmcp import FastMCP
from fastmcp.server.auth import StaticTokenVerifier
from monico_core import Registry

ADMIN_KEY = os.environ.get("MONICO_ADMIN_KEY")
if not ADMIN_KEY or len(ADMIN_KEY) < 32:
    raise RuntimeError("Set MONICO_ADMIN_KEY to a random secret of at least 32 characters")
DATA = Path(os.environ.get("MONICO_DATA", "/mnt/monico"))
DOMAIN = os.environ.get("MONICO_DOMAIN", "mail.example.invalid")
registry = Registry(DATA, DOMAIN)
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
    return {"email": registry.get_email(agent_id, agent_token), "transport_ready": False,
            "public_mcp_ready": False}

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

if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8787)
