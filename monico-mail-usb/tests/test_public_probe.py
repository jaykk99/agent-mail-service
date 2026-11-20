"""Mocked outside-network checks; they never claim actual delivery."""
import unittest
from unittest.mock import patch

from selfhost.public_probe import check_public_endpoint


class FakeConn:
    def __init__(self, port):
        self.port = port
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def settimeout(self, seconds):
        pass
    def recv(self, size):
        return b"220 mail.example-owned.net ESMTP\r\n" if self.port == 25 else b"* OK IMAP4 ready\r\n"


class FakeTLS:
    def wrap_socket(self, connection, server_hostname):
        assert server_hostname == "mail.example-owned.net"
        return connection


class FakeSMTP:
    def __init__(self, host, port, timeout):
        assert host == "mail.example-owned.net" and port == 587
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def ehlo(self):
        pass
    def has_extn(self, value):
        return value == "starttls"
    def starttls(self, context):
        assert isinstance(context, FakeTLS)


class PublicProbeTests(unittest.TestCase):
    def test_dns_tcp_and_tls_checks_are_distinct_from_delivery(self):
        def dig(kind, name):
            if kind == "NS":
                return ["ns1.example-owned.net."]
            if kind == "MX":
                return ["10 mail.example-owned.net."]
            if kind == "A":
                return ["1.1.1.1"]
            if kind == "AAAA":
                return ["2001:4860:4860::8888"]
            return []
        def connection(address, timeout):
            return FakeConn(address[1])
        with patch("selfhost.public_probe._dig", side_effect=dig), \
             patch("selfhost.public_probe.socket.create_connection", side_effect=connection), \
             patch("selfhost.public_probe.smtplib.SMTP", FakeSMTP), \
             patch("selfhost.public_probe.ssl.create_default_context", return_value=FakeTLS()):
            result = check_public_endpoint("example-owned.net", check_mcp=False)
        self.assertTrue(result["public_network_checks_passed"])
        self.assertFalse(result["actual_internet_email_delivery_tested"])
        self.assertEqual(len(result["checks"]), 6)

    def test_missing_external_dns_never_returns_ready(self):
        with patch("selfhost.public_probe._dig", side_effect=RuntimeError("no public DNS")), \
             patch("selfhost.public_probe.socket.create_connection", side_effect=OSError("blocked")), \
             patch("selfhost.public_probe.smtplib.SMTP", side_effect=OSError("blocked")):
            result = check_public_endpoint("example-owned.net", check_mcp=False)
        self.assertFalse(result["public_network_checks_passed"])
        self.assertFalse(result["actual_internet_email_delivery_tested"])

    def test_non_public_domain_is_refused(self):
        with self.assertRaises(ValueError):
            check_public_endpoint("mail.example.invalid")


if __name__ == "__main__":
    unittest.main()
