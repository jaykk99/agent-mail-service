"""Live bridge to Calling-linux: honest live/not-live, labels only, no fakes."""
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from calling_linux_bridge import CallingLinuxBridge
from provision import provision
from server import create_server

CAPABILITIES = {
    "hostname": "stub",
    "embeddedServices": {
        "sipUdpPort": 5060, "sipActive": True,
        "smtpListenPort": 2526, "smtpActive": True,
        "turnConfigured": False, "imapListening": False,
        "sipRegisteredLines": [], "webrtcOnlineLines": [],
    },
    "readiness1000": {
        "canRunSelfHosted1000": True, "canRunNodeGateway": True,
        "canSendLiveSmtp": True, "canTerminateCalls": True,
        "warnings": ["demo warning"],
    },
}

NUMBERS = {"numbers": [
    {"extension": 1, "label": "Primary Switchboard",
     "e164": "+12015550001", "lastOtp": "729104", "totalReceived": 12},
    {"extension": 2, "label": "Self-Hosted Auth Receiver",
     "e164": "+12015550002", "lastOtp": "519283", "totalReceived": 8},
    {"extension": 3, "label": "  ", "e164": "+12015550003"},
    {"extension": 4, "label": "Bad\x01label", "e164": "+12015550004"},
], "pagination": {"total": 4}}

E2E = {"timestamp": "2026-11-20T00:00:00.000Z", "passedCount": 4,
       "warningCount": 1, "failedCount": 1,
       "checks": [
           {"id": "unified-identity", "status": "passed"},
           {"id": "smtp-live", "status": "passed"},
           {"id": "sip-udp", "status": "passed"},
           {"id": "coturn-relay", "status": "warning"},
           {"id": "dovecot-imap", "status": "warning"},
           {"id": "tls-cert", "status": "failed"},
       ]}


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stub_handler(mode):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, payload, status=200):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if mode == "malformed" and self.path.startswith("/api/system/capabilities"):
                data = b"{not json"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if mode == "slow" and self.path.startswith("/api/system/capabilities"):
                time.sleep(5)
            if self.path.startswith("/api/system/capabilities"):
                return self._send(CAPABILITIES)
            if self.path.startswith("/api/numbers"):
                return self._send(NUMBERS)
            self._send({"error": "not found"}, status=404)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)
            if self.path.startswith("/api/system/verify-e2e"):
                return self._send(E2E)
            self._send({"error": "not found"}, status=404)

        def log_message(self, *args):
            pass
    return Handler


class StubServer:
    def __init__(self, mode="ok"):
        self.server = ThreadingHTTPServer(("127.0.0.1", free_port()),
                                          stub_handler(mode))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class BridgeTests(unittest.TestCase):
    def test_status_reads_real_capabilities_shape(self):
        stub = StubServer()
        try:
            status = CallingLinuxBridge(stub.url).status()
        finally:
            stub.stop()
        self.assertTrue(status["live"])
        self.assertTrue(status["sip"])
        self.assertTrue(status["smtp"])
        self.assertFalse(status["turn"])
        self.assertFalse(status["imap"])
        self.assertEqual(status["sipPort"], 5060)
        self.assertEqual(status["smtpPort"], 2526)
        self.assertEqual(status["warnings"], ["demo warning"])

    def test_fleet_labels_only_labels_cross(self):
        stub = StubServer()
        try:
            result = CallingLinuxBridge(stub.url).fleet_labels()
        finally:
            stub.stop()
        self.assertTrue(result["live"])
        self.assertEqual(result["labels"], {1: "Primary Switchboard",
                                            2: "Self-Hosted Auth Receiver"})
        # Blank and control-char labels are dropped, not passed through.

    def test_verify_e2e_maps_checks(self):
        stub = StubServer()
        try:
            result = CallingLinuxBridge(stub.url).verify_e2e()
        finally:
            stub.stop()
        self.assertTrue(result["live"])
        self.assertEqual(result["passed"], 4)
        self.assertEqual(result["checks"]["sip"], "passed")
        self.assertEqual(result["checks"]["tls"], "failed")

    def test_down_server_reports_not_live(self):
        bridge = CallingLinuxBridge("http://127.0.0.1:1", timeout=1.0)
        status = bridge.status()
        self.assertFalse(status["live"])
        self.assertIn("error", status)
        self.assertFalse(bridge.fleet_labels()["live"])
        self.assertFalse(bridge.verify_e2e()["live"])

    def test_malformed_json_reports_not_live(self):
        stub = StubServer(mode="malformed")
        try:
            status = CallingLinuxBridge(stub.url).status()
        finally:
            stub.stop()
        self.assertFalse(status["live"])

    def test_slow_server_times_out_not_live(self):
        stub = StubServer(mode="slow")
        try:
            status = CallingLinuxBridge(stub.url, timeout=0.5).status()
        finally:
            stub.stop()
        self.assertFalse(status["live"])

    def test_bad_url_rejected(self):
        with self.assertRaises(ValueError):
            CallingLinuxBridge("ftp://example.com")


class BridgeEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "monico-state"
        provision(self.state, 1000)
        self.stub = StubServer()
        os.environ["CALLING_LINUX_URL"] = self.stub.url
        self.server = create_server(self.state, count=1000, host="127.0.0.1",
                                    port=free_port())
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        identities = json.loads((self.state / "identities.json").read_text())
        self.token = identities["extensions"]["2000"]["apiToken"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.stub.stop()
        os.environ.pop("CALLING_LINUX_URL", None)
        self.temp.cleanup()

    def query(self, path, token=True):
        req = Request(self.base + path)
        if token:
            req.add_header("Authorization", "Bearer " + self.token)
        with urlopen(req, timeout=10) as res:
            return res.status, json.load(res)

    def test_health_carries_calling_linux_live(self):
        _, payload = self.query("/health")
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["callingLinux"]["live"])
        self.assertTrue(payload["callingLinux"]["sip"])

    def test_status_endpoint_returns_bridge_report(self):
        _, payload = self.query("/api/calling-linux/status")
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["live"])
        self.assertEqual(payload["e2e"]["passed"], 4)
        self.assertEqual(payload["e2e"]["checks"]["sip"], "passed")
        self.assertTrue(payload["fleetLabelsLive"])
        self.assertEqual(payload["fleetLabels"], 2)

    def test_status_endpoint_requires_auth(self):
        with self.assertRaises(Exception):
            self.query("/api/calling-linux/status", token=False)


if __name__ == "__main__":
    unittest.main()
