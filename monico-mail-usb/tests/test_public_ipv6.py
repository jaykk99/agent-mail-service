"""IPv6 support changes staging only; it is not a live public server test."""
import tempfile
import unittest
from pathlib import Path

from monico_core import Registry
from selfhost.generate_config import render
from selfhost.dns_zone import zone_text, public_ipv6
from selfhost.preflight import check_environment
from selfhost.prepare_live import prepare

V6_MAIL = "2001:4860:4860::8888"
V6_NS1 = "2606:4700:4700::1111"
V6_NS2 = "2001:4860:4860::8844"


class PublicIPv6Tests(unittest.TestCase):
    def test_ipv6_only_zone_uses_aaaa_not_invented_ipv4(self):
        zone = zone_text("public-monico.org", None, None, None,
                         mail_ipv6=V6_MAIL, ns1_ipv6=V6_NS1, ns2_ipv6=V6_NS2)
        self.assertIn("mail   IN AAAA  " + V6_MAIL, zone)
        self.assertIn("ns1    IN AAAA  " + V6_NS1, zone)
        self.assertNotIn(" IN A  ", zone)
        self.assertIn("MX 10 mail.public-monico.org", zone)

    def test_postfix_ipv6_and_dualstack_config(self):
        ipv6 = render("public-monico.org", "/mnt/usb/agents.sqlite3",
                      "/mnt/usb/maildirs", 2001, 2001,
                      "/etc/tls/mail.pem", "/etc/tls/mail.key",
                      None, public_ipv6=V6_MAIL)
        self.assertIn("inet_protocols = ipv6", ipv6["postfix-main.cf"])
        self.assertIn("mail 3600 IN AAAA", ipv6["dns-zone-example.txt"])
        dual = render("public-monico.org", "/mnt/usb/agents.sqlite3",
                      "/mnt/usb/maildirs", 2001, 2001,
                      "/etc/tls/mail.pem", "/etc/tls/mail.key",
                      "1.1.1.1", public_ipv6=V6_MAIL)
        self.assertIn("inet_protocols = all", dual["postfix-main.cf"])
        self.assertIn("mail 3600 IN A 1.1.1.1", dual["dns-zone-example.txt"])

    def test_reject_nonpublic_ipv6_and_missing_all_addresses(self):
        for ip6 in ("::1", "fe80::1234", "fd00::1", "192.168.1.1"):
            with self.subTest(ip=ip6), self.assertRaises(ValueError):
                public_ipv6(ip6)
        with self.assertRaises(ValueError):
            render("public-monico.org", "/mnt/usb/db.sqlite3", "/mnt/usb/mail",
                   2001, 2001, "/etc/cert", "/etc/key", None)

    def test_ipv6_only_full_staging_explicitly_not_live(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            usb = root / "usb"
            usb.mkdir()
            Registry(usb, "public-monico.org").register("agent_research", "research")
            cert, key = root / "cert.pem", root / "key.pem"
            cert.write_text("test fixture, not real certificate")
            key.write_text("test fixture, not real private key")
            manifest = prepare("public-monico.org", str(usb),
                               None, None, None, 2001, 2001,
                               str(cert), str(key), str(root / "out"),
                               public_ipv6=V6_MAIL,
                               ns1_ipv6=V6_NS1, ns2_ipv6=V6_NS2)
            self.assertEqual(manifest["public_mail_ip_protocol"], "IPv6-only")
            self.assertEqual(manifest["status"], "STAGED_NOT_DEPLOYED")
            self.assertFalse(manifest["public_inbound_smtp_verified"])
            self.assertIn("IN AAAA", (root / "out" / "db.public-monico.org").read_text())

    def test_ipv6_preflight_still_cannot_claim_public_delivery(self):
        with tempfile.TemporaryDirectory() as temp:
            result = check_environment(temp, "public-monico.org",
                                       "mail.public-monico.org", None,
                                       live=False, public_ipv6=V6_MAIL)
            self.assertTrue(result["ready_for_next_setup_step"])
            self.assertFalse(next(item for item in result["checks"]
                                  if item["check"] == "dns-and-ports")["passed"])


if __name__ == "__main__":
    unittest.main()
