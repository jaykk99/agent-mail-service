"""Local HTTPS integration for the DIRECT-IP public Monico gateway.

No outside network is contacted. Reaching this host from an outside network
still requires a public route and cannot be inferred from passing tests.
"""
import json
from pathlib import Path
import shutil
import ssl
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from public_gateway import public_ipv4, check_port, ensure_tls
from server import create_server


@unittest.skipUnless(shutil.which("openssl"), "OpenSSL required")
class PublicGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.ca, cls.crt, cls.key = ensure_tls(cls.root / "keys", "8.8.8.8")
        cls.server = create_server(cls.root / "state", count=1000,
                                   host="127.0.0.1", port=0,
                                   tls_cert=str(cls.crt), tls_key=str(cls.key))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"https://127.0.0.1:{cls.server.server_port}"
        cls.ctx = ssl.create_default_context(cafile=str(cls.ca))
        cls.identities = json.loads((cls.root / "state" / "identities.json").read_text())["extensions"]
        cls.token1 = cls.identities["2000"]["apiToken"]
        cls.token2 = cls.identities["2001"]["apiToken"]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.tmp.cleanup()

    def request(self, path, token=None, payload=None):
        headers = {"Authorization": "Bearer " + (token or "bogus")}
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        req = Request(self.url + path, headers=headers, data=data)
        try:
            with urlopen(req, context=self.ctx, timeout=5) as res:
                return res.status, json.loads(res.read())
        except HTTPError as err:
            return err.code, json.loads(err.read())

    def test_01_cert_is_verifiable_and_local(self):
        self.assertTrue(self.ca.is_file())
        self.assertTrue(self.crt.is_file())
        self.assertEqual(self.key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.ca.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(ensure_tls(self.root / "keys", "8.8.8.8")[0], self.ca)

    def test_02_authenticated_https_remote_protocol(self):
        self.assertEqual(self.request("/health")[0], 200)
        self.assertEqual(self.request("/api/me")[0], 401)
        self.assertEqual(self.request("/api/me", self.token1)[1]["extension"], "2000")
        code, sent = self.request("/api/messages", self.token1,
                                  {"to": "2001", "text": "Secure over self-hosted TLS"})
        self.assertEqual(code, 201)
        self.assertEqual(sent["carrierSms"], False)
        inbox = self.request("/api/messages", self.token2)[1]["events"]
        self.assertTrue(any(event["data"]["text"] == "Secure over self-hosted TLS"
                            for event in inbox))
        self.assertEqual(self.request("/api/messages", self.token1)[1]["events"], [])

    def test_03_tls_rejects_untrusted_connections(self):
        req = Request(self.url + "/health")
        with self.assertRaises(URLError) as caught:
            urlopen(req, timeout=5)
        self.assertIsInstance(caught.exception.reason, ssl.SSLCertVerificationError)

    def test_04_public_ip_and_port_safety(self):
        for invalid in ("127.0.0.1", "192.168.1.1", "10.0.0.2",
                        "172.16.0.1", "::1", "not-an-ip"):
            with self.subTest(ip=invalid), self.assertRaises(ValueError):
                public_ipv4(invalid)
        self.assertEqual(public_ipv4("8.8.8.8"), "8.8.8.8")
        with self.assertRaises(ValueError):
            check_port(25)
        self.assertEqual(check_port(8766), 8766)

    def test_05_never_silently_rekey_for_new_ip(self):
        with self.assertRaises(RuntimeError):
            ensure_tls(self.root / "keys", "1.1.1.1")
        with self.assertRaises(RuntimeError):
            ensure_tls(self.root / "keys", "8.8.4.4")


if __name__ == "__main__":
    unittest.main()
