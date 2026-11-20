import unittest
from selfhost.dns_zone import zone_text, named_config, public_ipv4


class BindZoneTests(unittest.TestCase):
    def test_self_hosted_nameservers_and_mail_records(self):
        zone = zone_text("my-real-domain.org", "1.1.1.1", "1.1.1.1",
                         "8.8.8.8", serial=2026112001)
        self.assertIn("$ORIGIN my-real-domain.org.", zone)
        self.assertIn("2026112001", zone)
        self.assertIn("IN SOA ns1.my-real-domain.org.", zone)
        self.assertIn("IN MX 10 mail.my-real-domain.org.", zone)
        self.assertIn('IN TXT "v=spf1 mx -all"', zone)
        self.assertIn("v=DMARC1; p=none", zone)
        self.assertIn("ns1    IN A  1.1.1.1", zone)
        self.assertIn("ns2    IN A  8.8.8.8", zone)

    def test_dkim_long_public_key_is_chunked_for_dns(self):
        key = "A" * 392
        zone = zone_text("my-real-domain.org", "1.1.1.1", "1.1.1.1",
                         "8.8.8.8", dkim_key=key, serial=2026112001)
        record = next(l for l in zone.splitlines() if "mail._domainkey" in l)
        self.assertIn("v=DKIM1", record)
        self.assertIn('" "', record)
        self.assertEqual(record.count("A"), 392)
        with self.assertRaises(ValueError):
            zone_text("my-real-domain.org", "1.1.1.1", "1.1.1.1",
                      "8.8.8.8", dkim_key="not-key; evil")

    def test_validate_public_ip_and_non_fake_domain(self):
        for ip in ("127.0.0.1", "192.168.1.1", "172.16.1.1", "::1"):
            with self.subTest(ip=ip), self.assertRaises(ValueError):
                public_ipv4(ip)
        with self.assertRaises(ValueError):
            zone_text("fake.example.invalid", "1.1.1.1", "1.1.1.1", "8.8.8.8")

    def test_named_config_points_to_zone(self):
        text = named_config("my-real-domain.org", "/etc/bind/zones/db.my-real-domain.org")
        self.assertIn('zone "my-real-domain.org"', text)
        self.assertIn("allow-update { none; };", text)


if __name__ == "__main__":
    unittest.main()
