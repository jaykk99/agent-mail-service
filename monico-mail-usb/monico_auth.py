"""Self-hosted FastMCP bearer authentication with no third-party identity provider.

Operator, registered mailbox agents and unredeemed invitations each have their
own HTTP bearer credentials, validated from the existing USB SQLite registry.
"""
import hmac
import time

from fastmcp.server.auth import AccessToken, TokenVerifier
from fastmcp.server.dependencies import get_access_token


class MonicoTokenVerifier(TokenVerifier):
    def __init__(self, registry, operator_token):
        super().__init__()
        self.registry = registry
        self.operator_token = operator_token

    async def verify_token(self, token: str) -> AccessToken | None:
        if not isinstance(token, str) or len(token) < 20:
            return None
        if hmac.compare_digest(token, self.operator_token):
            return AccessToken(
                token=token, client_id="monico-operator",
                scopes=["operator"], expires_at=None,
                claims={"role": "operator"}
            )
        digest = self.registry.hash_token(token)
        with self.registry.connect() as db:
            agent = db.execute(
                "SELECT agent_id FROM agents WHERE token_hash=?",
                (digest,)
            ).fetchone()
            if agent:
                return AccessToken(
                    token=token, client_id="monico-agent:" + agent[0],
                    scopes=["agent"], expires_at=None,
                    claims={"role": "agent", "agent_id": agent[0]}
                )
            invite_table = db.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_invites'"
            ).fetchone()
            if invite_table:
                invitation = db.execute(
                    """SELECT expires FROM mailbox_invites
                       WHERE code_hash=? AND redeemed IS NULL""", (digest,)
                ).fetchone()
                if invitation and invitation[0] > int(time.time()):
                    return AccessToken(
                        token=token, client_id="monico-invite:" + digest[:24],
                        scopes=["invite"], expires_at=invitation[0],
                        claims={"role": "invite"}
                    )
        return None


def _access():
    token = get_access_token()
    if token is None:
        raise ValueError("Missing HTTP bearer authentication")
    return token


def require_operator():
    """Prevent calling admin tools with an agent or invitation bearer."""
    if _access().claims.get("role") != "operator":
        raise ValueError("Operator HTTP bearer required")


def require_invitation(invitation_code):
    """One-time bearer used during self-service mailbox name selection."""
    token = _access()
    if (token.claims.get("role") != "invite" or
            not isinstance(invitation_code, str) or
            not hmac.compare_digest(token.token, invitation_code)):
        raise ValueError("Matching invitation HTTP bearer required")


def require_agent(agent_id, agent_token):
    """Bind an agent's HTTP identity to their tool request and own mailbox."""
    token = _access()
    if (token.claims.get("role") != "agent" or
            token.claims.get("agent_id") != agent_id or
            not isinstance(agent_token, str) or
            not hmac.compare_digest(token.token, agent_token)):
        raise ValueError("The HTTP bearer must match this agent's identity")
