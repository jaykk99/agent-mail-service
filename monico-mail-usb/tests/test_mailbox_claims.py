import tempfile
import unittest
from monico_core import Registry
from mailbox_claims import MailboxClaims


class AgentSelectedMailboxTests(unittest.TestCase):
    def setUp(self):
        self.usb = tempfile.TemporaryDirectory()
        self.registry = Registry(self.usb.name, "mail.example.invalid")
        self.claims = MailboxClaims(self.registry, capacity=1000)

    def tearDown(self):
        self.usb.cleanup()

    def test_agent_picks_own_name_and_receives_credentials(self):
        invite = self.claims.issue_invites()["codes"][0]
        assert self.claims.name_available("Research")["available"]
        account = self.claims.claim(invite, "Research")
        self.assertEqual(account["email"], "research@mail.example.invalid")
        self.assertTrue(account["agent_id"].startswith("mb_"))
        self.assertNotEqual(account["agent_token"], account["mail_password"])
        self.assertFalse(self.claims.name_available("research")["available"])
        self.assertEqual(self.registry.get_email(account["agent_id"], account["agent_token"]),
                         account["email"])
        with self.registry.connect() as db:
            mail = db.execute("SELECT password_hash FROM mail_accounts WHERE email=?",
                              (account["email"],)).fetchone()
        self.assertEqual(mail[0], self.registry.hash_token(account["mail_password"]))
        self.assertNotIn(account["mail_password"], str(mail))

    def test_no_reused_invites(self):
        invite = self.claims.issue_invites()["codes"][0]
        self.claims.claim(invite, "hello")
        with self.assertRaisesRegex(ValueError, "Invitation"):
            self.claims.claim(invite, "different")

    def test_duplicate_name_does_not_spend_invite(self):
        a, b = self.claims.issue_invites(count=2)["codes"]
        self.claims.claim(a, "sales")
        with self.assertRaisesRegex(ValueError, "already claimed"):
            self.claims.claim(b, "sales")
        self.assertEqual(self.claims.claim(b, "marketing")["email"],
                         "marketing@mail.example.invalid")

    def test_expired_invite_rejected(self):
        invite = self.claims.issue_invites()["codes"][0]
        with self.registry.connect() as db:
            db.execute("UPDATE mailbox_invites SET expires=0")
        with self.assertRaisesRegex(ValueError, "expired"):
            self.claims.claim(invite, "hello")

    def test_reject_missing_invite(self):
        with self.assertRaises(ValueError):
            self.claims.claim("this-is-not-a-real-invitation", "hello")

    def test_reject_reserved_and_unsafe_names(self):
        for name in ("admin", "postmaster", "root", "..", "foo..bar", "hello world",
                     "a@b", "/mail", "x" * 70):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.claims.name_available(name)

    def test_configured_capacity_and_pending_invites(self):
        service = MailboxClaims(self.registry, capacity=2)
        code = service.issue_invites(count=2)["codes"][0]
        with self.assertRaises(ValueError):
            service.issue_invites()
        service.claim(code, "alpha")
        self.assertEqual(service.slots()["registered"], 1)
        self.assertEqual(service.slots()["pending_invitations"], 1)
        with self.assertRaises(ValueError):
            service.issue_invites()
        self.assertEqual(service.slots()["unreserved_slots"], 0)

    def test_reserved_system_addresses_do_not_take_agent_invitations(self):
        self.registry.provision_system_mailbox("postmaster")
        self.registry.provision_system_mailbox("abuse")
        service = MailboxClaims(self.registry, capacity=2)
        self.assertEqual(service.slots()["registered"], 0)
        a, b = service.issue_invites(count=2)["codes"]
        self.assertEqual(service.claim(a, "research")["email"],
                         "research@mail.example.invalid")
        self.assertEqual(service.claim(b, "support")["email"],
                         "support@mail.example.invalid")
        self.assertEqual(service.slots()["registered"], 2)
        self.assertEqual(service.slots()["unreserved_slots"], 0)
        self.assertEqual(self.registry.total_mailbox_count(), 4)
        with self.assertRaises(ValueError):
            service.issue_invites()

    def test_invitation_quota_respects_registry_configuration(self):
        import os
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as location, patch.dict(
            os.environ, {"MONICO_MAX_MAILBOXES": "2"}
        ):
            small_registry = Registry(location, "mail.example.invalid")
            service = MailboxClaims(small_registry)
            self.assertEqual(service.capacity, 2)
            service.issue_invites(count=2)
            with self.assertRaises(ValueError):
                service.issue_invites()
            with self.assertRaises(ValueError):
                MailboxClaims(small_registry, capacity=1000)

    def test_restart_retains_claim_and_prevents_replay(self):
        code = self.claims.issue_invites()["codes"][0]
        account = self.claims.claim(code, "my.custom_name")
        restarted = MailboxClaims(Registry(self.usb.name, "mail.example.invalid"))
        self.assertFalse(restarted.name_available("my.custom_name")["available"])
        with self.assertRaises(ValueError):
            restarted.claim(code, "another")

    def test_batch_issuance_limits(self):
        with self.assertRaises(ValueError):
            self.claims.issue_invites(count=201)
        with self.assertRaises(ValueError):
            self.claims.issue_invites(days=31)


if __name__ == "__main__":
    unittest.main()
