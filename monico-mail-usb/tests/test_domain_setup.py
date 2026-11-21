import tempfile
import unittest
from pathlib import Path
from monico_core import Registry
from selfhost.configure_domain import write_domain_config, read_existing_domain


class DomainSetupTests(unittest.TestCase):
    def test_configure_domain_and_preserve_when_no_accounts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = Registry(root, "myrealmail.net")
            conf = root / "private" / "domain.env"
            result = write_domain_config("myrealmail.net", conf, root / "agents.sqlite3")
            self.assertEqual(result.read_text(), "export MONICO_DOMAIN=myrealmail.net\n")
            self.assertEqual(read_existing_domain(root / "agents.sqlite3"), "myrealmail.net")
            self.assertEqual(result.stat().st_mode & 0o777, 0o600)
            self.assertEqual(registry.mailbox_count(), 0)

    def test_refuse_mismatched_persistent_identity_domain(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            Registry(root, "your-real-domain.org").register("agent_123", "marketing")
            conf = root / "domain.env"
            with self.assertRaisesRegex(ValueError, "Existing accounts use"):
                write_domain_config("new-domain.net", conf, root / "agents.sqlite3")
            self.assertFalse(conf.exists())

    def test_accept_free_and_local_domains(self):
        with tempfile.TemporaryDirectory() as tmp:
            for domain in ("agents.local", "home.lan", "localhost"):
                with self.subTest(domain=domain):
                    out = Path(tmp) / f"{domain}.env"
                    write_domain_config(domain, out)
                    self.assertIn(f"MONICO_DOMAIN={domain}", out.read_text())
            with self.assertRaises(ValueError):
                write_domain_config("bad..domain", Path(tmp) / "bad.env")

    def test_no_database_created_for_new_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "fresh" / "agents.sqlite3"
            write_domain_config("my-real-domain.org", Path(tmp) / "domain.env", data)
            self.assertFalse(data.exists())


if __name__ == "__main__":
    unittest.main()
