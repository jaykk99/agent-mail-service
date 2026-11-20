"""Production-readiness gate regression tests; no fake public pass allowed."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("monico_release_gate", ROOT / "linux" / "release_gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
from provision import provision
from monico_core import Registry


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "agent-state"
        self.state.mkdir(mode=0o700)
        provision(self.state, 1000)
        with sqlite3.connect(self.state / "messages.sqlite3") as db:
            db.execute("CREATE TABLE demo(id INTEGER PRIMARY KEY)")
        mail = self.state / "monico"
        mail.mkdir(mode=0o700)
        Registry(mail, "mail.example.invalid")
        (mail / "linux-config.json").write_text(
            json.dumps({"schema": 1, "state_path": str(self.state),
                        "admin_key": "a" * 48, "bearer_token": "b" * 48}),
            encoding="utf-8")
        (mail / "linux-config.json").chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_not_ready_when_local_processes_offline(self):
        report = gate.check_local(self.state)
        self.assertFalse(report["ready"])
        by_name = {c["check"]: c["pass"] for c in report["checks"]}
        self.assertTrue(by_name["phone_agent_identities"])
        self.assertTrue(by_name["named_mailboxes_sqlite"])
        self.assertFalse(by_name["phone_process"])
        self.assertFalse(by_name["mail_mcp_process"])
        self.assertFalse(by_name["mail_mcp_denies_anonymous"])

    def test_healthy_local_stage_never_claims_internet(self):
        services = {"phone_online_local": True, "mcp_online_local": True,
                    "mailbox_count": 0}
        with patch.object(gate.manage, "do_status", return_value=services), patch.object(
            gate, "_unauthenticated_mcp_blocked", return_value=True
        ):
            local = gate.check_release(self.state)
            self.assertTrue(local["ready"], local)
            self.assertEqual(local["scope"], "local")
            for scope in ("public-web", "internet-mail", "carrier-phone", "all"):
                result = gate.check_release(self.state, scope)
                self.assertFalse(result["ready"])
                self.assertTrue(result["local_ready"])
                self.assertFalse(result["public_internet_email_verified"])
                self.assertFalse(result["public_pstn_sms_verified"])
                self.assertFalse(result["outside_network_browser_verified"])

    def test_private_config_permissions_mandatory(self):
        (self.state / "monico" / "linux-config.json").chmod(0o644)
        with patch.object(gate.manage, "do_status",
                          return_value={"phone_online_local": True,
                                        "mcp_online_local": True}), patch.object(
            gate, "_unauthenticated_mcp_blocked", return_value=True
        ):
            report = gate.check_local(self.state)
        self.assertFalse(report["ready"])
        self.assertFalse(next(row for row in report["checks"]
                              if row["check"] == "operator_credential_storage")["pass"])

    def test_corrupt_mail_sqlite_blocks_release(self):
        (self.state / "monico" / "agents.sqlite3").write_bytes(b"not a sqlite database")
        with patch.object(gate.manage, "do_status",
                          return_value={"phone_online_local": True,
                                        "mcp_online_local": True}), patch.object(
            gate, "_unauthenticated_mcp_blocked", return_value=True
        ):
            report = gate.check_local(self.state)
        self.assertFalse(next(row for row in report["checks"]
                              if row["check"] == "named_mailboxes_sqlite")["pass"])

    def test_invalid_scope_rejected(self):
        with self.assertRaises(ValueError):
            gate.check_release(self.state, "ignore_checks")

    def test_mail_credentials_not_leaked(self):
        report = gate.check_local(self.state)
        self.assertNotIn("aaaaaaaaaaaaaaaaaaaa", json.dumps(report))
        self.assertNotIn("bbbbbbbbbbbbbbbbbbbb", json.dumps(report))


if __name__ == "__main__":
    unittest.main()
