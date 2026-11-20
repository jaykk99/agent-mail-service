import tempfile
import unittest
from email.message import EmailMessage
from unittest.mock import patch

from monico_core import Registry
from selfhost.mail_client import SelfHostedMail


class FakeSMTP:
    sent = []

    def __init__(self, host, port, timeout):
        assert host == "mail.mail.example.invalid"
        assert port == 587

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def ehlo(self):
        pass

    def starttls(self, context):
        assert context.verify_mode

    def login(self, address, secret):
        assert secret

    def send_message(self, message):
        self.sent.append(message)


class FakeIMAP:
    message = EmailMessage()
    message["From"] = "friend@example.com"
    message["To"] = "alice@mail.example.invalid"
    message["Subject"] = "Hello from the internet"
    message.set_content("Received using Dovecot!")

    def __init__(self, host, port, ssl_context, timeout):
        assert host == "mail.mail.example.invalid"
        assert port == 993
        assert ssl_context.verify_mode

    def login(self, address, secret):
        assert address.endswith("@mail.example.invalid")
        assert secret

    def select(self, mailbox, readonly):
        assert mailbox == "INBOX" and readonly
        return "OK", [b"1"]

    def uid(self, command, *args):
        if command == "search":
            return "OK", [b"15"]
        if command == "fetch":
            uid, syntax = args
            assert uid == "15"
            if syntax.startswith("(BODY.PEEK[HEADER"):
                return "OK", [(b"15", self.message.as_bytes().split(b"\n\n")[0] + b"\n\n")]
            return "OK", [(b"15", self.message.as_bytes())]
        raise AssertionError(command)

    def logout(self):
        pass


class SelfHostMailTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.registry = Registry(self.tmp.name, "mail.example.invalid")
        self.alice = self.registry.register("agent_001", "alice")
        self.bob = self.registry.register("agent_002", "bob")
        self.client = SelfHostedMail(self.registry, "mail.mail.example.invalid")
        FakeSMTP.sent = []

    def tearDown(self):
        self.tmp.cleanup()

    def test_hosts_are_limited_to_our_domain(self):
        with self.assertRaises(ValueError):
            SelfHostedMail(self.registry, "smtp.gmail.com")

    def test_agent_secrets_are_isolated(self):
        a = self.alice
        self.assertEqual(self.client.authenticate("agent_001", a["token"], a["mail_password"]),
                         "alice@mail.example.invalid")
        with self.assertRaises(ValueError):
            self.client.authenticate("agent_002", self.bob["token"], a["mail_password"])
        with self.assertRaises(ValueError):
            self.client.authenticate("agent_001", "wrong-token", a["mail_password"])

    def test_smtp_uses_unique_from(self):
        with patch("selfhost.mail_client.smtplib.SMTP", FakeSMTP):
            result = self.client.send("agent_001", self.alice["token"],
                                      self.alice["mail_password"], "person@example.org",
                                      "Hello", "Hi")
        self.assertTrue(result["submitted"])
        self.assertEqual(FakeSMTP.sent[0]["From"], "alice@mail.example.invalid")
        self.assertEqual(self.client.sent("agent_001", self.alice["token"])[0]["subject"], "Hello")
        self.assertEqual(self.client.sent("agent_002", self.bob["token"]), [])

    def test_no_header_injection(self):
        with self.assertRaises(ValueError):
            self.client.send("agent_001", self.alice["token"], self.alice["mail_password"],
                             "user@example.org", "hello\nBcc: spam@example.com", "body")
        with self.assertRaises(ValueError):
            self.client.send("agent_001", self.alice["token"], self.alice["mail_password"],
                             "bad@example.org,other@example.org", "test", "body")

    def test_send_rate_limit(self):
        with patch("selfhost.mail_client.smtplib.SMTP", FakeSMTP):
            for i in range(10):
                self.client.send("agent_001", self.alice["token"], self.alice["mail_password"],
                                 f"user{i}@example.org", "Hi", "Body")
            with self.assertRaisesRegex(ValueError, "limit"):
                self.client.send("agent_001", self.alice["token"], self.alice["mail_password"],
                                 "eleventh@example.org", "Hi", "Body")

    def test_imap_is_per_agent_and_plain_text(self):
        with patch("selfhost.mail_client.imaplib.IMAP4_SSL", FakeIMAP):
            inbox = self.client.inbox("agent_001", self.alice["token"],
                                      self.alice["mail_password"])
            self.assertEqual(inbox[0]["uid"], "15")
            received = self.client.read("agent_001", self.alice["token"],
                                        self.alice["mail_password"], "15")
            self.assertEqual(received["subject"], "Hello from the internet")
            self.assertIn("Received using Dovecot", received["body"])
        with self.assertRaises(ValueError):
            self.client.read("agent_001", self.alice["token"], self.alice["mail_password"],
                             "15\r\nDELETE")


if __name__ == "__main__":
    unittest.main()
