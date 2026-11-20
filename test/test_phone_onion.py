import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from onion_gateway import render_hidden_service


class OnionRoutingTests(unittest.TestCase):
    def test_local_routing_and_hidden_service_version(self):
        config = render_hidden_service()
        self.assertIn("HiddenServiceDir /var/lib/tor/monico-agents", config)
        self.assertIn("HiddenServiceVersion 3", config)
        self.assertIn("HiddenServicePort 80 127.0.0.1:8765", config)
        self.assertNotIn("0.0.0.0", config)
        self.assertNotIn("HiddenServiceAuthorizeClient", config)

    def test_reject_unsafe_paths(self):
        for value in ("/tmp/bad path", "/etc/../root", "relative/path", "/etc/tor\nbad"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                render_hidden_service(value)
        with self.assertRaises(ValueError):
            render_hidden_service(local_port=25)
        with self.assertRaises(ValueError):
            render_hidden_service(virtual_port=25)

    def test_custom_internal_port_does_not_expose_raw_ip(self):
        c = render_hidden_service("/var/lib/tor/custom-monico", local_port=9876)
        self.assertIn("HiddenServicePort 80 127.0.0.1:9876", c)


if __name__ == "__main__":
    unittest.main()
