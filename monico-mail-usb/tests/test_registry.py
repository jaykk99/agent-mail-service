import tempfile
import unittest
from monico_core import Registry

class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.reg = Registry(self.tmp.name, "mail.example.invalid")

    def tearDown(self):
        self.tmp.cleanup()

    def test_persistent_identity(self):
        first = self.reg.register("agent_001", "alice")
        second = Registry(self.tmp.name, "mail.example.invalid").register("agent_001", "different")
        self.assertEqual(first["email"], second["email"])
        self.assertTrue(second["existing"])
        self.assertNotIn("token", second)
        self.assertEqual(self.reg.get_email("agent_001", first["token"]), first["email"])

    def test_duplicate_name(self):
        self.reg.register("agent_001", "alice")
        with self.assertRaises(ValueError):
            self.reg.register("agent_002", "alice")

    def test_bad_credentials(self):
        self.reg.register("agent_001", "alice")
        with self.assertRaises(ValueError):
            self.reg.get_email("agent_001", "incorrect")

    def test_rotation(self):
        first = self.reg.register("agent_001", "alice")
        new = self.reg.rotate("agent_001", first["token"])
        with self.assertRaises(ValueError):
            self.reg.get_email("agent_001", first["token"])
        self.assertEqual(self.reg.get_email("agent_001", new), first["email"])

    def test_invalid_names(self):
        for name in ("admin", "postmaster", "a..b", "UPPER", "bad@", "-bad"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.reg.register("agent_001", name)

    def test_local_delivery_and_isolation(self):
        alice = self.reg.register("agent_001", "alice")
        bob = self.reg.register("agent_002", "bob")
        sent = self.reg.send_internal("agent_001", alice["token"], bob["email"], "Hello", "Hi Bob")
        self.assertTrue(sent["delivered_locally"])
        inbox = Registry(self.tmp.name, "mail.example.invalid").inbox("agent_002", bob["token"])
        self.assertEqual(inbox[0]["subject"], "Hello")
        msg = self.reg.read_message("agent_002", bob["token"], sent["message_id"])
        self.assertEqual(msg["body"], "Hi Bob")
        with self.assertRaises(ValueError):
            self.reg.read_message("agent_001", alice["token"], sent["message_id"])

    def test_no_external_delivery(self):
        alice = self.reg.register("agent_001", "alice")
        with self.assertRaises(ValueError):
            self.reg.send_internal("agent_001", alice["token"], "person@gmail.com", "Hello", "Body")

    def test_missing_usb(self):
        with self.assertRaises(RuntimeError):
            Registry(self.tmp.name + "/missing", "example.invalid")

if __name__ == "__main__":
    unittest.main()
