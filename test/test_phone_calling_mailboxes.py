"""Calling-linux mailbox provisioning + shared TURN secret naming."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]
                       / "monico-mail-usb" / "selfhost"))
from calling_linux_mailboxes import mailbox_entries, write_outputs
from generate_config import render_calling_linux_dovecot_users
from provision import provision
from turn_relay import client_ice_config


class MailboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "monico-state"
        provision(self.state, 1000)
        self.out = self.root / "generated"

    def tearDown(self):
        self.temp.cleanup()

    def test_entries_map_to_calling_linux_legacy_numbers(self):
        entries, accounts = mailbox_entries(self.state, "mail.carrier.local")
        self.assertEqual(len(entries), 1000)
        self.assertEqual(entries[0][0], "12015550001")
        self.assertEqual(entries[999][0], "12015551000")
        self.assertEqual(accounts[0]["email"], "12015550001@mail.carrier.local")
        self.assertEqual(accounts[0]["extension"], "2000")
        self.assertEqual(accounts[0]["legacyExtension"], 1)
        # Real SHA512-CRYPT hashes, never placeholders.
        self.assertTrue(all(h.startswith("$6$") for _, h, _ in entries))
        self.assertNotIn("$REPLACE_WITH_DOVEADM_PW_HASH",
                         "".join(h for _, h, _ in entries))

    def test_outputs_are_private_and_complete(self):
        result = write_outputs(self.state, "mail.carrier.local", self.out)
        self.assertEqual(result["mailboxes"], 1000)
        users = (self.out / "dovecot-users").read_text()
        self.assertIn("12015550001@mail.carrier.local:{SHA512-CRYPT}$6$",
                      users)
        self.assertIn("/var/mail/vhosts/mail.carrier.local/12015550001",
                      users)
        self.assertIn("userdb_quota_rule=*:bytes=512M", users)
        self.assertNotIn("REPLACE_WITH", users)
        creds_path = self.out / "credentials.json"
        self.assertEqual(stat.S_IMODE(creds_path.stat().st_mode), 0o600)
        creds = json.loads(creds_path.read_text())
        self.assertEqual(len(creds["accounts"]), 1000)
        self.assertEqual(creds["accounts"][0]["password"],
                         json.loads((self.state / "identities.json")
                                    .read_text())["extensions"]["2000"]["sipPassword"])
        script = (self.out / "make-maildirs.sh").read_text()
        self.assertIn("mkdir -p /var/mail/vhosts/mail.carrier.local/12015550001/cur",
                      script)
        self.assertIn("chown -R 5000:5000", script)

    def test_renderer_refuses_placeholder_hashes(self):
        with self.assertRaises(ValueError):
            render_calling_linux_dovecot_users(
                "mail.carrier.local",
                [("12015550001", "$REPLACE_WITH_DOVEADM_PW_HASH", 512)])


class TurnAliasTests(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in
                      ("PHONE_TURN_SECRET", "PHONE_TURN_IP", "PHONE_TURN_PORT",
                       "TURN_SECRET", "TURN_PASSWORD", "TURN_URL")}
        for key in self.saved:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_calling_linux_aliases_work(self):
        os.environ["TURN_SECRET"] = "a" * 32
        os.environ["TURN_URL"] = "turn:8.8.8.8:3478"
        config = client_ice_config("2000")
        self.assertTrue(config["turnConfigured"])
        self.assertEqual(config["iceServers"][0]["urls"][0],
                         "turn:8.8.8.8:3478?transport=udp")
        self.assertTrue(config["iceServers"][0]["username"].endswith(":2000"))

    def test_no_turn_configured_when_unset(self):
        self.assertEqual(client_ice_config("2000"),
                         {"iceServers": [], "turnConfigured": False})

    def test_monico_names_take_precedence(self):
        os.environ["PHONE_TURN_SECRET"] = "b" * 32
        os.environ["PHONE_TURN_IP"] = "8.8.4.4"
        os.environ["TURN_SECRET"] = "a" * 32
        os.environ["TURN_URL"] = "turn:8.8.8.8:3478"
        config = client_ice_config("2000")
        self.assertIn("8.8.4.4", config["iceServers"][0]["urls"][0])


if __name__ == "__main__":
    unittest.main()
