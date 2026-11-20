"""Linux-only operation needs no DNS, TLS, SMTP or internet access."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from mailbox_claims import MailboxClaims
from monico_core import Registry
from private_mail import PRIVATE_DOMAIN, create_private_storage, demo, open_private

ROOT = Path(__file__).resolve().parents[1]


class LinuxOnlyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.storage = self.directory / "USB Drive"
        self.storage.mkdir()
        self.home = self.directory / "linux-home"
        self.home.mkdir()
        self.configuration = self.home / ".config" / "monico-mail-private" / "config.json"

    def tearDown(self):
        self.temp.cleanup()

    def install(self):
        return create_private_storage(data=str(self.storage),
                                      configuration=self.configuration)

    def test_demo_end_to_end_without_network(self):
        result = demo()
        self.assertEqual(result["sender"], "research@monico.test")
        self.assertEqual(result["recipient"], "support@monico.test")
        self.assertTrue(result["survived_database_reopen"])
        self.assertFalse(result["public_internet_delivery"])

    def test_create_private_storage_and_restart(self):
        cfg = self.install()
        self.assertEqual(cfg["domain"], PRIVATE_DOMAIN)
        self.assertEqual(cfg["data"], str(self.storage))
        self.assertEqual(self.configuration.stat().st_mode & 0o777, 0o600)
        registry = open_private(self.configuration)
        self.assertEqual(registry.mailbox_count(), 0)
        first = registry.register("my_agent", "my-name")
        reopened = open_private(self.configuration)
        self.assertEqual(reopened.get_email("my_agent", first["token"]),
                         "my-name@monico.test")
        self.assertEqual(reopened.mailbox_count(), 1)

    def test_local_invites_name_choices_and_inbox_isolation(self):
        self.install()
        registry = open_private(self.configuration)
        invite_service = MailboxClaims(registry)
        codes = invite_service.issue_invites(2)["codes"]
        alice = invite_service.claim(codes[0], "Research")
        bob = invite_service.claim(codes[1], "Support")
        self.assertEqual(alice["email"], "research@monico.test")
        self.assertEqual(bob["email"], "support@monico.test")
        with self.assertRaises(ValueError):
            invite_service.claim(codes[0], "other")
        delivery = registry.send_internal(alice["agent_id"], alice["agent_token"],
                                          bob["email"], "Private greeting", "Hello Bob")
        restarted = open_private(self.configuration)
        self.assertEqual(len(restarted.inbox(alice["agent_id"],
                                            alice["agent_token"])), 0)
        received = restarted.inbox(bob["agent_id"], bob["agent_token"])
        self.assertEqual(received[0]["subject"], "Private greeting")
        self.assertEqual(restarted.read_message(
            bob["agent_id"], bob["agent_token"], delivery["message_id"])["body"],
            "Hello Bob")
        with self.assertRaises(ValueError):
            restarted.read_message(alice["agent_id"], alice["agent_token"],
                                   delivery["message_id"])
        with self.assertRaises(ValueError):
            restarted.send_internal(alice["agent_id"], alice["agent_token"],
                                    "person@example.org", "no external delivery", "blocked")

    def test_refuse_domain_collision_with_public_database(self):
        Registry(self.storage, "actual-domain.net").register("agent_a", "sales")
        with self.assertRaisesRegex(RuntimeError, "Database belongs"):
            self.install()
        self.assertFalse(self.configuration.exists())

    def test_missing_usb_refused(self):
        with self.assertRaises(ValueError):
            create_private_storage(usb="NOT_PRESENT",
                                   removable=self.directory,
                                   configuration=self.configuration)
        self.assertFalse(self.configuration.exists())

    def test_cli_demo_and_send_inbox_no_mcp_dependency(self):
        env = dict(os.environ)
        env["HOME"] = str(self.home)
        demo_result = subprocess.run([sys.executable, str(ROOT / "private_mail.py"), "demo"],
                                     env=env, capture_output=True, text=True,
                                     timeout=15, cwd=ROOT)
        self.assertEqual(demo_result.returncode, 0, demo_result.stderr)
        self.assertFalse(json.loads(demo_result.stdout)["public_internet_delivery"])
        self.install()
        reg = open_private(self.configuration)
        alice = reg.register("agent_research", "research")
        bob = reg.register("agent_support", "support")
        env["MONICO_AGENT_TOKEN"] = alice["token"]
        sent = subprocess.run([sys.executable, str(ROOT / "private_mail.py"), "send",
                               "--agent-id", "agent_research", "--to", bob["email"],
                               "--subject", "hello", "--body", "body"],
                              env=env, capture_output=True, text=True, cwd=ROOT, timeout=15)
        self.assertEqual(sent.returncode, 0, sent.stderr)
        self.assertEqual(json.loads(sent.stdout)["transport"], "LOCAL_SQLITE_ONLY")
        env["MONICO_AGENT_TOKEN"] = bob["token"]
        received = subprocess.run([sys.executable, str(ROOT / "private_mail.py"), "inbox",
                                   "--agent-id", "agent_support"],
                                  env=env, capture_output=True, text=True,
                                  cwd=ROOT, timeout=15)
        self.assertEqual(received.returncode, 0, received.stderr)
        self.assertEqual(json.loads(received.stdout)[0]["subject"], "hello")


if __name__ == "__main__":
    unittest.main()
