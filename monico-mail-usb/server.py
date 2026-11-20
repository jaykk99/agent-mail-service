"""Private-only Monico MCP prototype. Do not publish without transport authentication."""
import hmac
import os
from pathlib import Path
from fastmcp import FastMCP
from monico_core import Registry

ADMIN_KEY = os.environ.get("MONICO_ADMIN_KEY")
if not ADMIN_KEY or len(ADMIN_KEY) < 32:
    raise RuntimeError("Set MONICO_ADMIN_KEY to a random secret of at least 32 characters")
DATA = Path(os.environ.get("MONICO_DATA", "/mnt/monico"))
DOMAIN = os.environ.get("MONICO_DOMAIN", "mail.example.invalid")
registry = Registry(DATA, DOMAIN)
mcp = FastMCP("Monico Mail")

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

if __name__ == "__main__":
    mcp.run(transport="http", host="127.0.0.1", port=8787)
