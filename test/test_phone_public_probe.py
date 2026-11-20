"""End-to-end TLS/API probe test on loopback ONLY, not an internet reachability claim."""
import json
from pathlib import Path
import shutil
import ssl
import sys
import tempfile
import threading
import unittest
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from public_gateway import ensure_tls
from probe_public import run_probe, validate_public_url
from server import create_server


@unittest.skipUnless(shutil.which("openssl"), "OpenSSL required for local TLS tests")
class PublicProbeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.ca, cls.cert, cls.key = ensure_tls(cls.root / "certs", "8.8.8.8")
        cls.service = create_server(cls.root / "state", count=1000,
                                    host="127.0.0.1", port=0,
                                    tls_cert=str(cls.cert), tls_key=str(cls.key))
        cls.worker = threading.Thread(target=cls.service.serve_forever, daemon=True)
        cls.worker.start()
        cls.url = "https://127.0.0.1:" + str(cls.service.server_port)
        cls.accounts = json.loads((cls.root / "state" / "identities.json").read_text())["extensions"]

    @classmethod
    def tearDownClass(cls):
        cls.service.shutdown()
        cls.service.server_close()
        cls.worker.join(timeout=3)
        cls.temp.cleanup()

    def test_01_valid_https_anonymous_rejected_and_1000_agents(self):
        report = run_probe(self.url, ca_file=str(self.ca), allow_loopback_for_tests=True)
        self.assertTrue(report["https_certificate_trusted_by_tester"])
        self.assertTrue(report["anonymous_agent_api_rejected"])
        self.assertEqual(report["agent_count"], 1000)
        self.assertFalse(report["internet_email_verified"])
        self.assertFalse(report["carrier_sms_or_phone_verified"])

    def test_02_agent_bearer_works(self):
        report = run_probe(self.url, ca_file=str(self.ca),
                           agent_token=self.accounts["2001"]["apiToken"],
                           allow_loopback_for_tests=True)
        self.assertEqual(report["authenticated_agent"], "2001")

    def test_03_bad_certificate_rejected(self):
        with self.assertRaises(URLError) as failure:
            run_probe(self.url, allow_loopback_for_tests=True)
        self.assertIsInstance(failure.exception.reason, ssl.SSLCertVerificationError)

    def test_04_fail_closed_for_nonpublic_or_insecure_urls(self):
        for url in ("http://8.8.8.8:8766", "https://127.0.0.1:8766",
                    "https://192.168.1.20:8766", "https://8.8.8.8:25",
                    "https://8.8.8.8:8766/path", "https://u:p@8.8.8.8:8766",
                    "https://example.com:8766"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_public_url(url)
        self.assertEqual(validate_public_url("https://8.8.8.8:8766"),
                         "https://8.8.8.8:8766")


if __name__ == "__main__":
    unittest.main()
