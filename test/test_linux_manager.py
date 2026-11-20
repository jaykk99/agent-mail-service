"""Linux-wide lifecycle tests: secure persistence and named mailbox integration.

No external network, no requirement to install FastMCP to execute these tests.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monico_linux_manage", ROOT / "linux" / "manage.py")
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class LinuxManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"
        self.state.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def test_persistent_operator_secrets_and_db_domain(self):
        config, mail, registry = manager.registry(self.state, "mail.example.invalid", create=True)
        self.assertEqual(config["domain"], "mail.example.invalid")
        self.assertTrue(len(config["admin_key"]) >= 32)
        self.assertNotEqual(config["admin_key"], config["bearer_token"])
        stored = mail / "linux-config.json"
        self.assertEqual(stored.stat().st_mode & 0o777, 0o600)
        existing_config, mail2, again = manager.registry(self.state, create=True)
        self.assertEqual(config, existing_config)
        self.assertEqual(mail, mail2)
        self.assertEqual(again.mailbox_count(), 0)
        self.assertEqual(again.domain, "mail.example.invalid")

    def test_invite_and_custom_email_use_same_usb_database(self):
        config, mail, registry = manager.registry(self.state, "mail.example.invalid", create=True)
        invitation = manager.MailboxClaims(registry).issue_invites()["codes"][0]
        account = manager.MailboxClaims(registry).claim(invitation, "my_shop")
        self.assertEqual(account["email"], "my_shop@mail.example.invalid")
        with self.assertRaises(ValueError):
            manager.MailboxClaims(registry).claim(invitation, "another")
        again = manager.Registry(mail, config["domain"])
        self.assertEqual(again.mailbox_count(), 1)
        self.assertEqual(again.get_email(account["agent_id"], account["agent_token"]),
                         account["email"])

    def test_refuses_domain_migration_and_unsecured_secrets(self):
        manager.registry(self.state, "my-real-domain.org", create=True)
        with self.assertRaises(RuntimeError):
            manager.registry(self.state, "another-domain.net", create=True)
        cfg = self.state / "monico" / "linux-config.json"
        os.chmod(cfg, 0o644)
        with self.assertRaisesRegex(RuntimeError, "permissions"):
            manager.load_config(self.state)

    def test_check_pid_fails_closed_for_wrong_script_and_json(self):
        manager.registry(self.state, create=True)
        folder = self.state / "monico"
        self.assertFalse(manager.inspect_mcp(folder))
        (folder / "mcp.pid").write_text(json.dumps({"pid": os.getpid()}))
        self.assertFalse(manager.inspect_mcp(folder))
        self.assertFalse(manager.mcp_status(folder))
        self.assertEqual(manager.stop_mcp(folder), "not running")

    def test_status_and_doctor_never_claim_public_delivery(self):
        manager.registry(self.state, create=True)
        with patch.object(manager, "inspect_phone", return_value=True), patch.object(
            manager, "inspect_mcp", return_value=True
        ):
            status = manager.do_status(self.state)
        self.assertTrue(status["internal_network_usable"])
        self.assertFalse(status["public_internet_mail_verified"])
        self.assertFalse(status["public_pstn_sms_verified"])
        self.assertEqual(status["mailbox_count"], 0)

    def test_cli_status_no_installation_required(self):
        proc = subprocess.run(
            ["bash", str(ROOT / "start.sh"), "--full", "status",
             "--state-dir", str(self.state)],
            capture_output=True, text=True, cwd=str(ROOT), timeout=15
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        status = json.loads(proc.stdout)
        self.assertFalse(status["phone_online_local"])
        self.assertFalse(status["mcp_online_local"])
        self.assertIsNone(status["mailbox_domain"])

    def test_refuses_fake_dependency_ready(self):
        with patch.object(manager, "_mcp_python",
                          return_value=Path(self.temp.name) / "not-installed"):
            self.assertFalse(manager.dependency_ready())

    def test_install_is_not_needed_for_phone_only_startup(self):
        content = (ROOT / "start.sh").read_text(encoding="utf-8")
        self.assertIn('if [ "\${1-}" = "--full" ]', content)
        self.assertIn('exec python3 phone/start.py --daemon', content)


if __name__ == "__main__":
    unittest.main()
