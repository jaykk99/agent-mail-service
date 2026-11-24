"""USB/domain setup tests use temporary folders, never a real USB or DNS."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from mailbox_claims import MailboxClaims
from monico_core import Registry
from setup_monico import setup


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.mount = self.root / "removable"
        self.mount.mkdir()
        (self.mount / "USB Drive").mkdir()
        self.private = self.home / ".config" / "monico-mail"

    def tearDown(self):
        self.temp.cleanup()

    def test_custom_domain_and_agent_selected_name(self):
        result = setup("my-owned-domain.org", usb_name="USB Drive",
                       config_dir=self.private, removable=self.mount)
        self.assertEqual(result["domain"], "my-owned-domain.org")
        self.assertEqual(result["data"], str(self.mount / "USB Drive" / "monico"))
        self.assertFalse(result["public_domain_verified"])
        self.assertEqual((self.private / "domain.env").read_text(),
                         "export MONICO_DOMAIN=my-owned-domain.org\n")
        self.assertIn("USB Drive", (self.private / "storage.env").read_text())
        self.assertEqual((self.private / "domain.env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.private / "storage.env").stat().st_mode & 0o777, 0o600)
        registry = Registry(result["data"], result["domain"])
        claims = MailboxClaims(registry)
        invitation = claims.issue_invites()["codes"][0]
        mailbox = claims.claim(invitation, "Your.Custom_Name")
        self.assertEqual(mailbox["email"], "your.custom_name@my-owned-domain.org")
        self.assertTrue(mailbox["agent_token"])
        self.assertTrue(mailbox["mail_password"])

        # No manual source/export required for mailbox CLI after initial setup.
        environment = dict(os.environ)
        environment["HOME"] = str(self.home)
        environment.pop("MONICO_DATA", None)
        environment.pop("MONICO_DOMAIN", None)
        proc = subprocess.run([sys.executable, str(PROJECT_ROOT / "mailbox_admin.py"), "status"],
                              cwd=PROJECT_ROOT, env=environment, capture_output=True,
                              text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        status = json.loads(proc.stdout)
        self.assertEqual(status["domain"], "my-owned-domain.org")
        self.assertEqual(status["registered"], 1)

    def test_missing_usb_is_rejected_without_creating_fake_drive(self):
        with self.assertRaises(ValueError):
            setup("my-owned-domain.org", usb_name="NOT CONNECTED",
                  config_dir=self.private, removable=self.mount)
        self.assertFalse((self.mount / "NOT CONNECTED").exists())
        self.assertFalse((self.private / "domain.env").exists())

    def test_domain_change_refused_after_accounts_exist(self):
        result = setup("my-owned-domain.org", usb_name="USB Drive",
                       config_dir=self.private, removable=self.mount)
        Registry(result["data"], "my-owned-domain.org").register("agent_101", "sales")
        with self.assertRaisesRegex(ValueError, "Existing accounts use"):
            setup("new-owned-domain.net", usb_name="USB Drive",
                  config_dir=self.private, removable=self.mount)
        self.assertEqual((self.private / "domain.env").read_text(),
                         "export MONICO_DOMAIN=my-owned-domain.org\n")

    def test_invalid_domain_is_not_configured(self):
        for domain in ("mail.example.invalid", "example.com", "myfake.test",
                       "agents.local", "mail.local", "foo.onion"):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                setup(domain, usb_name="USB Drive", config_dir=self.private,
                      removable=self.mount)

    def test_setup_requires_an_explicit_domain(self):
        # setup() is the real-install path: no local default may silently
        # slip through the delegable-domain gate.
        with self.assertRaisesRegex(ValueError, "Pass --domain"):
            setup(usb_name="USB Drive", config_dir=self.private, removable=self.mount)
        self.assertFalse((self.private / "domain.env").exists())
        environment = dict(os.environ)
        environment["HOME"] = str(self.home)
        proc = subprocess.run([sys.executable, str(PROJECT_ROOT / "setup_monico.py"),
                               "--usb", "USB Drive"],
                              cwd=PROJECT_ROOT, env=environment, capture_output=True,
                              text=True, timeout=15)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--domain", proc.stderr)

    def test_path_traversal_is_rejected(self):
        for name in ("../other", "/tmp", "..", ".", "a/b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                setup("my-owned-domain.org", usb_name=name,
                      config_dir=self.private, removable=self.mount)


if __name__ == "__main__":
    unittest.main()
