"""Actual UDP SIP OPTIONS response (local fixture, never claimed as public PSTN)."""
from pathlib import Path
import re
import socket
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from sip_probe import check_sip, render_options, validate_host


class LocalSIPServer:
    def __enter__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        self.running = True
        self.worker = threading.Thread(target=self.work, daemon=True)
        self.worker.start()
        return self

    def work(self):
        self.sock.settimeout(0.5)
        while self.running:
            try:
                packet, peer = self.sock.recvfrom(4096)
            except (socket.timeout, OSError):
                continue
            raw = packet.decode("ascii")
            assert raw.startswith("OPTIONS sip:")
            callid = re.search(r"^Call-ID:\s*(\S+)", raw, re.MULTILINE)
            assert callid
            reply = (
                "SIP/2.0 401 Unauthorized\r\n"
                "Via: SIP/2.0/UDP 127.0.0.1:0;branch=z9hG4bKtest\r\n"
                f"Call-ID: {callid.group(1)}\r\n"
                "CSeq: 1 OPTIONS\r\nContent-Length: 0\r\n\r\n"
            )
            self.sock.sendto(reply.encode(), peer)

    def __exit__(self, *_):
        self.running = False
        self.sock.close()
        self.worker.join(timeout=1)


class SIPProbeTests(unittest.TestCase):
    def test_probe_actual_sip_udp_response_not_public_call(self):
        with LocalSIPServer() as server:
            result = check_sip("127.0.0.1", server.port, timeout=1)
        self.assertTrue(result["sip_udp_responded"])
        self.assertEqual(result["status_code"], 401)
        self.assertIsNotNone(result["latency_ms"])
        self.assertFalse(result["authenticated_sip_registration_verified"])
        self.assertFalse(result["sip_audio_rtp_verified"])
        self.assertFalse(result["public_pstn_number_verified"])
        self.assertFalse(result["carrier_sms_verified"])

    def test_bad_host_port_timeout_rejected(self):
        for host in ("http://127.0.0.1", "example.com/evil", "", "hello world"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                validate_host(host)
        with self.assertRaises(ValueError):
            check_sip("127.0.0.1", 25)
        with self.assertRaises(ValueError):
            check_sip("127.0.0.1", 5060, timeout=20)

    def test_options_is_valid_sip_request(self):
        request = render_options("example.org", "a"*40, "b"*32)
        self.assertTrue(request.startswith(b"OPTIONS sip:"))
        self.assertIn(b"Call-ID: " + b"a"*40, request)
        self.assertIn(b"CSeq: 1 OPTIONS", request)


if __name__ == "__main__":
    unittest.main()
