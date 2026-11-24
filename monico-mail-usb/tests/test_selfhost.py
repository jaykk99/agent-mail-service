import tempfile
import unittest
from pathlib import Path
from selfhost.generate_config import render, check_domain, check_local_domain

class SelfHostedConfigTests(unittest.TestCase):
    def test_generate_independent_mail_stack(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = str(Path(tmp) / "agents.sqlite3")
            output = render("monicomail.org", db, str(Path(tmp) / "maildirs"), 2001, 2001,
                            "/etc/ssl/certs/mail.pem", "/etc/ssl/private/mail.key",
                            "1.1.1.1")
            self.assertEqual(len(output), 8)
            self.assertIn("dovecot_config_version = 2.4.0", output["dovecot-2.4-extra.conf"])
            self.assertIn("mail_accounts", output["dovecot-2.4-extra.conf"])
            self.assertIn("virtual_transport = lmtp:unix:private/dovecot-lmtp",
                          output["postfix-main.cf"])
            self.assertIn("proxy:sqlite:/etc/postfix/sqlite-sender-login.cf",
                          output["postfix-main.cf"])
            self.assertIn("proxy_read_maps =", output["postfix-main.cf"])
            self.assertIn("SELECT email FROM agents", output["postfix-sqlite-virtual-mailboxes.cf"])
            self.assertIn("mail_accounts", output["dovecot-sql.conf.ext"])
            self.assertIn("default_pass_scheme = SHA256.HEX", output["dovecot-sql.conf.ext"])
            self.assertIn("smtpd_sasl_auth_enable=yes", output["postfix-master-submission.cf"])
            self.assertIn("reject_authenticated_sender_login_mismatch",
                          output["postfix-master-submission.cf"])
            self.assertIn("IN MX", output["dns-zone-example.txt"])

    def test_reject_fake_domains(self):
        for domain in ("mail.example.invalid", "example.com", "localhost", "fake.test", "foo",
                       "mail.local", "agents.local", "foo.onion", "mail.home.arpa", "home.arpa"):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                check_domain(domain)

    def test_special_use_domains_never_reach_public_templates(self):
        # render() publishes public Postfix/Dovecot/DNS configs, so a
        # special-use name must fail there too, not just in check_domain().
        for domain in ("mail.local", "foo.onion", "mail.home.arpa"):
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                render(domain, "/mnt/data/agents.sqlite3", "/mnt/data/mail", 2001, 2001,
                       "/etc/ssl/mail.pem", "/etc/ssl/mail.key", "1.1.1.1")

    def test_local_domain_check_still_allows_offline_names(self):
        # The offline-only path is deliberately permissive: local installs
        # legitimately use names that can never be delegated.
        for domain in ("agents.local", "home.lan", "localhost"):
            self.assertEqual(check_local_domain(domain), domain)

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
