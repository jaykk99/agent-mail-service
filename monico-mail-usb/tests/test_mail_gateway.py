import os
import tempfile
import unittest
from email.message import EmailMessage
from unittest.mock import patch

from monico_core import Registry
from mail_gateway import MailGateway, MailSettings


class FakeSMTP:
    messages = []

    def __init__(self, host, port, context=None, timeout=None):
        assert context is not None
        assert port == 465

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def login(self, user, password):
        assert user == "owner@gmail.com"
        assert password == "local-test-secret"

    def send_message(self, msg):
        self.messages.append(msg)


class MailGatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.registry = Registry(self.tmp.name, "mail.example.invalid")
        self.alice = self.registry.register("agent_001", "alice")
        self.bob = self.registry.register("agent_002", "bob")
        self.gateway = MailGateway(self.registry, MailSettings("owner@gmail.com", "local-test-secret"))
        FakeSMTP.messages.clear()

    def tearDown(self):
        self.tmp.cleanup()

    def test_provider_config(self):
        with patch.dict(os.environ, {
            "MONICO_MAIL_ACCOUNT": "owner@gmail.com",
            "MONICO_MAIL_APP_PASSWORD": "local-test-secret",
        }):
            self.assertEqual(MailSettings.from_env().address, "owner@gmail.com")

    def test_real_alias(self):
        self.assertEqual(self.gateway.alias("agent_001", self.alice["token"]),
                         "owner+alice@gmail.com")
        with self.assertRaises(ValueError):
            self.gateway.alias("agent_001", "incorrect")

    def test_smtp_submission_and_sent_folder(self):
        with patch("mail_gateway.smtplib.SMTP_SSL", FakeSMTP):
            result = self.gateway.send("agent_001", self.alice["token"],
                                       "someone@outlook.com", "Test", "Hello from Monico")
        self.assertTrue(result["sent_via_smtp"])
        self.assertEqual(FakeSMTP.messages[0]["From"], "owner@gmail.com")
        self.assertEqual(FakeSMTP.messages[0]["Reply-To"], "owner+alice@gmail.com")
        self.assertEqual(self.gateway.sent("agent_001", self.alice["token"])[0]["subject"], "Test")
        self.assertEqual(self.gateway.sent("agent_002", self.bob["token"]), [])

    def test_sending_limits(self):
        with patch("mail_gateway.smtplib.SMTP_SSL", FakeSMTP):
            for i in range(5):
                self.gateway.send("agent_001", self.alice["token"],
                                  f"user{i}@example.com", "Subject", "Body")
            with self.assertRaisesRegex(ValueError, "hourly limit"):
                self.gateway.send("agent_001", self.alice["token"], "six@example.com", "Subject", "Body")

    def test_refuse_spoofed_recipient_and_header_injection(self):
        with self.assertRaises(ValueError):
            self.gateway.send("agent_001", self.alice["token"],
                              "victim@invalid", "Subject", "Body")
        with self.assertRaises(ValueError):
            self.gateway.send("agent_001", self.alice["token"],
                              "recipient@gmail.com", "New\nBcc:bad@example.com", "Body")

    def test_ingest_and_dedupe(self):
        message = EmailMessage()
        message["From"] = "friend@outlook.com"
        message["To"] = "owner+alice@gmail.com"
        message["Subject"] = "Real reply"
        message.set_content("Hi Alice!")
        self.assertEqual(self.gateway._ingest(message.as_bytes(), "123", "1"), 1)
        self.assertEqual(self.gateway._ingest(message.as_bytes(), "123", "1"), 0)
        entries = self.registry.inbox("agent_001", self.alice["token"])
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["subject"], "Real reply")
        self.assertEqual(self.registry.read_message("agent_001", self.alice["token"],
                                                     entries[0]["id"])["body"].strip(), "Hi Alice!")
        self.assertEqual(self.registry.inbox("agent_002", self.bob["token"]), [])
        with self.assertRaises(ValueError):
            self.registry.read_message("agent_002", self.bob["token"], entries[0]["id"])

    def test_unmatched_inbound_not_delivered(self):
        message = EmailMessage()
        message["To"] = "owner@gmail.com"
        message.set_content("Main mailbox only")
        self.assertEqual(self.gateway._ingest(message.as_bytes(), "124", "1"), 0)
        self.assertEqual(self.registry.inbox("agent_001", self.alice["token"]), [])

    def test_restart_persists_inbound(self):
        message = EmailMessage()
        message["To"] = "owner+bob@gmail.com"
        message["From"] = "friend@gmail.com"
        message["Subject"] = "Persistence"
        message.set_content("Stored on USB")
        self.gateway._ingest(message.as_bytes(), "125", "1")
        restarted = MailGateway(Registry(self.tmp.name, "mail.example.invalid"),
                                MailSettings("owner@gmail.com", "local-test-secret"))
        self.assertEqual(len(restarted.registry.inbox("agent_002", self.bob["token"])), 1)
        self.assertEqual(restarted._ingest(message.as_bytes(), "125", "1"), 0)


if __name__ == "__main__":
    unittest.main()
