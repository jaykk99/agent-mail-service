import tempfile
import unittest
from pathlib import Path
from selfhost.generate_config import render, check_domain

class SelfHostedConfigTests(unittest.TestCase):
    def test_generate_independent_mail_stack(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / "agents.sqlite3")
            output = render("monicomail.org", db, str(Path(tmp) / "maildirs"), 2001, 2001,
                            "/etc/ssl/certs/mail.pem", "/etc/ssl/private/mail.key",
                            "1.1.1.1")
            self.assertEqual(len(output), 7)
            self.assertIn("virtual_transport = lmtp:unix:private/dovecot-lmtp",
                          output["postfix-main.cf"])
            self.assertIn("SELECT email FROM agents", output["postfix-sqlite-virtual-mailboxes.cf"])
            self.assertIn("mail_accounts", output["dovecot-sql.conf.ext"])
            self.assertIn("default_pass_scheme = SHA256.HEX", output["dovecot-sql.conf.ext"])
            self.assertIn("smtpd_sasl_auth_enable=yes", output["postfix-master-submission.cf"])
            self.assertIn("reject_authenticated_sender_login_mismatch",
                          output["postfix-master-submission.cf"])
            self.assertIn("IN MX", output["dns-zone-example.txt"])

    def test_reject_fake_domains(self):
        for domain in ("mail.example.invalid", "example.com", "localhost", "fake.test", "foo"):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                check_domain(domain)

    def test_reject_non_public_ip_and_bad_uid(self):
        args = ["monicomail.org", "/mnt/data/agents.sqlite3", "/mnt/data/mail", 2001, 2001,
                "/etc/ssl/mail.pem", "/etc/ssl/mail.key"]
        for ip in ("127.0.0.1", "192.168.1.10", "10.0.0.5"):
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                render(*args, ip)
        with self.assertRaises(ValueError):
            render("monicomail.org", "/mnt/data/agents.sqlite3", "/mnt/data/mail", 0, 2001,
                   "/etc/ssl/mail.pem", "/etc/ssl/mail.key", "1.1.1.1")

if __name__ == "__main__":
    unittest.main()
