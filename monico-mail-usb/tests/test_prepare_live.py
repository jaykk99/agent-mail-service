import tempfile
import unittest
from pathlib import Path
from monico_core import Registry
from selfhost.prepare_live import prepare


class LiveStagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.usb = self.base / "usb"
        self.usb.mkdir()
        self.registry = Registry(self.usb, "my-real-mail.org")
        self.registry.register("agent_123", "custom.name")
        self.cert = self.base / "cert.pem"
        self.cert.write_text("test fixture only, not a trusted certificate")
        self.key = self.base / "key.pem"
        self.key.write_text("test fixture only")
        self.output = self.base / "output"

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self, **changes):
        args = {
            "domain": "my-real-mail.org",
            "data": str(self.usb),
            "public_ip": "1.1.1.1",
            "ns1_ip": "1.1.1.1",
            "ns2_ip": "8.8.8.8",
            "vmail_uid": 2001,
            "vmail_gid": 2001,
            "cert": str(self.cert),
            "key": str(self.key),
            "output": str(self.output)
        }
        args.update(changes)
        return prepare(**args)

    def test_full_staging_has_dns_postfix_dovecot_and_manifest(self):
        manifest = self.prepare()
        self.assertEqual(manifest["status"], "STAGED_NOT_DEPLOYED")
        self.assertFalse(manifest["public_inbound_smtp_verified"])
        self.assertFalse(manifest["live_dns_verified"])
        for item in ("postfix-main.cf", "dovecot-2.3-extra.conf",
                     "dovecot-2.4-extra.conf", "postfix-master-submission.cf",
                     "named.conf.monico", "db.my-real-mail.org", "manifest.json"):
            self.assertTrue((self.output / item).is_file(), item)
        zone = (self.output / "db.my-real-mail.org").read_text()
        self.assertIn("MX 10 mail.my-real-mail.org", zone)
        self.assertIn("v=DMARC1", zone)
        self.assertIn("v=spf1", zone)
        self.assertIn("ns1.my-real-mail.org", zone)
        self.assertIn("custom.name", self.registry.register("agent_123", "different")["email"])

    def test_avoid_overwriting_staged_files(self):
        self.prepare()
        with self.assertRaises(FileExistsError):
            self.prepare()

    def test_refuse_mismatched_domain(self):
        with self.assertRaises(ValueError):
            self.prepare(domain="not-ours.net")

    def test_private_ip_and_missing_keys_refused(self):
        with self.assertRaises(ValueError):
            self.prepare(public_ip="192.168.0.1")
        with self.assertRaises(ValueError):
            self.prepare(key=str(self.base / "missing.pem"))
        with self.assertRaises(ValueError):
            self.prepare(cert=str(self.key))

    def test_requires_existing_accounts_db(self):
        empty = self.base / "newusb"
        empty.mkdir()
        with self.assertRaises(ValueError):
            self.prepare(data=str(empty))


if __name__ == "__main__":
    unittest.main()
