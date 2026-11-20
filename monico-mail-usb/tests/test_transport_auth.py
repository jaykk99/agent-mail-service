"""Per-agent HTTP bearer verification tests; requires installed FastMCP 2.x."""
import asyncio
import tempfile
import unittest
from unittest.mock import patch

from mailbox_claims import MailboxClaims
from monico_core import Registry
from monico_auth import MonicoTokenVerifier, require_operator, require_agent, require_invitation


class TransportAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.registry = Registry(self.temp.name, "mail.example.invalid")
        self.claims = MailboxClaims(self.registry)
        self.operator = "operator_" + "A" * 50
        self.verifier = MonicoTokenVerifier(self.registry, self.operator)
        self.alice = self.registry.register("agent_alice", "alice")
        self.bob = self.registry.register("agent_bob", "bob")

    def tearDown(self):
        self.temp.cleanup()

    def verify(self, token):
        return asyncio.run(self.verifier.verify_token(token))

    def test_operator_is_not_an_agent(self):
        op = self.verify(self.operator)
        self.assertEqual(op.claims["role"], "operator")
        with patch("monico_auth.get_access_token", return_value=op):
            require_operator()
            with self.assertRaises(ValueError):
                require_agent("agent_alice", self.alice["token"])

    def test_agent_http_bearer_is_bound_to_own_mailbox(self):
        token = self.verify(self.alice["token"])
        self.assertEqual(token.claims["role"], "agent")
        self.assertEqual(token.claims["agent_id"], "agent_alice")
        with patch("monico_auth.get_access_token", return_value=token):
            require_agent("agent_alice", self.alice["token"])
            with self.assertRaises(ValueError):
                require_agent("agent_bob", self.bob["token"])
            with self.assertRaises(ValueError):
                require_agent("agent_alice", self.bob["token"])
            with self.assertRaises(ValueError):
                require_operator()
        self.assertIsNone(self.verify("nothing"))
        self.assertIsNone(self.verify("wrong" * 20))

    def test_invite_only_allows_matching_claim_and_expires_after_use(self):
        invite = self.claims.issue_invites()["codes"][0]
        session = self.verify(invite)
        self.assertEqual(session.claims["role"], "invite")
        with patch("monico_auth.get_access_token", return_value=session):
            require_invitation(invite)
            with self.assertRaises(ValueError):
                require_invitation("other-invite")
            with self.assertRaises(ValueError):
                require_agent("agent_alice", self.alice["token"])
            with self.assertRaises(ValueError):
                require_operator()
        claimed = self.claims.claim(invite, "supportdesk")
        self.assertEqual(claimed["email"], "supportdesk@mail.example.invalid")
        self.assertIsNone(self.verify(invite))
        self.assertEqual(self.verify(claimed["agent_token"]).claims["agent_id"],
                         claimed["agent_id"])

    def test_expired_invite_rejected(self):
        invite = self.claims.issue_invites()["codes"][0]
        with self.registry.connect() as db:
            db.execute("UPDATE mailbox_invites SET expires=0")
        self.assertIsNone(self.verify(invite))

    def test_revoking_agent_key_revokes_http_bearer(self):
        old = self.alice["token"]
        self.assertIsNotNone(self.verify(old))
        new = self.registry.rotate("agent_alice", old)
        self.assertIsNone(self.verify(old))
        self.assertEqual(self.verify(new).claims["agent_id"], "agent_alice")

    def test_missing_context_rejected(self):
        with patch("monico_auth.get_access_token", return_value=None):
            with self.assertRaises(ValueError):
                require_operator()
            with self.assertRaises(ValueError):
                require_agent("agent_alice", self.alice["token"])


if __name__ == "__main__":
    unittest.main()
