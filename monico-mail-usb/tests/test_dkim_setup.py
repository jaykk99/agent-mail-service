import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from selfhost.dkim_setup import signing_templates, generate_key
from selfhost.dns_zone import read_opendkim_public_txt, zone_text


class DKIMTests(unittest.TestCase):
    def test_create_staged_postfix_milter_and_tables(self):
        templates = signing_templates("my-real-domain.org",
                                     "/etc/opendkim/keys/mail.private")
        self.assertIn("my-real-domain.org:mail:", templates["KeyTable"])
        self.assertIn("*@my-real-domain.org", templates["SigningTable"])
        self.assertIn("inet:127.0.0.1:8891", templates["postfix-milter.cf.fragment"])
        self.assertIn("Socket inet:8891@127.0.0.1", templates["opendkim.conf.fragment"])

    def test_read_real_formatted_public_dkim_record(self):
        with tempfile.TemporaryDirectory() as td:
            public = Path(td) / "mail.txt"
            key = "A" * 180 + "B" * 190
            public.write_text(
                'mail._domainkey IN TXT ( "v=DKIM1; k=rsa; " "p='
                + key[:180] + '" "' + key[180:] + '" ) ; public key')
            self.assertEqual(read_opendkim_public_txt(public), key)
            zone = zone_text("my-real-domain.org", "1.1.1.1", "1.1.1.1", "8.8.8.8",
                             dkim_key=read_opendkim_public_txt(public), serial=2026112001)
            self.assertIn(key[:180], zone)

    def test_never_read_private_key_as_dkim_txt(self):
        with tempfile.TemporaryDirectory() as td:
            private = Path(td) / "mail.private"
            private.write_text("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----")
            with self.assertRaises(ValueError):
                read_opendkim_public_txt(private)

    def test_refuse_overwrite_of_existing_private_key(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "mail.private").write_text("private")
            with self.assertRaises(FileExistsError):
                generate_key("my-real-domain.org", td)

    def test_invalid_selector(self):
        with self.assertRaises(ValueError):
            signing_templates("my-real-domain.org", "/etc/opendkim/mail.private",
                              selector="../mail")


if __name__ == "__main__":
    unittest.main()
