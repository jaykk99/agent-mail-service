"""Local authenticated TURN credential tests; no external coturn dependency."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from server import create_server
from turn_relay import make_ice_credentials, client_ice_config, render_coturn


class TurnTests(unittest.TestCase):
    def test_rest_hmac_matches_coturn_contract(self):
        secret = "s" * 48
        ice = make_ice_credentials("2000", secret, "8.8.8.8", now=1234567890)
        details = ice["iceServers"][0]
        self.assertEqual(details["username"], "1234571490:2000")
        expect = base64.b64encode(
            hmac.new(secret.encode(), details["username"].encode(), hashlib.sha1).digest()
        ).decode()
        self.assertEqual(details["credential"], expect)
        self.assertIn("turn:8.8.8.8:3478?transport=udp", details["urls"])
        self.assertNotIn(secret, str(ice))
        self.assertNotEqual(
            make_ice_credentials("2001", secret, "8.8.8.8", now=1234567890)["iceServers"][0]["credential"],
            details["credential"]
        )

    def test_no_turn_config_is_safe_direct_ice(self):
        with patch.dict(os.environ, {}, clear=True):
            data = client_ice_config("2000")
            self.assertEqual(data["iceServers"], [])
            self.assertFalse(data["turnConfigured"])

    def test_no_half_config_or_private_ip(self):
        with patch.dict(os.environ, {"PHONE_TURN_IP": "8.8.8.8"}, clear=True):
            with self.assertRaises(ValueError):
                client_ice_config("2000")
        with self.assertRaises(ValueError):
            make_ice_credentials("2000", "x" * 32, "192.168.1.1")
        with self.assertRaises(ValueError):
            make_ice_credentials("bad principal/../../", "x" * 32, "8.8.8.8")

    def test_private_selfhost_coturn_config(self):
        conf = render_coturn("8.8.8.8", "p" * 48, "192.168.1.30")
        self.assertIn("use-auth-secret", conf)
        self.assertIn("static-auth-secret=" + "p" * 48, conf)
        self.assertIn("external-ip=8.8.8.8/192.168.1.30", conf)
        self.assertIn("no-loopback-peers", conf)
        self.assertIn("user-quota=4", conf)
        self.assertIn("total-quota=1200", conf)
        self.assertIn("max-port=65535", conf)


class TurnEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = create_server(cls.tmp.name, count=1000, host="127.0.0.1", port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        identities = json.loads((Path(cls.tmp.name) / "identities.json").read_text())["extensions"]
        cls.token = identities["2000"]["apiToken"]
        cls.url = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.tmp.cleanup()

    def query(self, path, token=None, data=None):
        headers = {"Authorization": "Bearer " + (token or "invalid")}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = Request(self.url + path, headers=headers,
                      data=json.dumps(data).encode() if data is not None else None)
        try:
            with urlopen(req, timeout=5) as res:
                return res.status, json.loads(res.read())
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_turn_requires_bearer_and_returns_ephemeral_ice(self):
        with patch.dict(os.environ, {"PHONE_TURN_IP": "8.8.8.8",
                                     "PHONE_TURN_SECRET": "Z" * 48}):
            self.assertEqual(self.query("/api/turn")[0], 401)
            code, config = self.query("/api/turn", self.token)
            self.assertEqual(code, 200)
            self.assertTrue(config["turnConfigured"])
            self.assertEqual(config["iceServers"][0]["urls"][0], "turn:8.8.8.8:3478?transport=udp")
            self.assertNotIn("Z" * 48, json.dumps(config))

    def test_guest_uses_own_bearer_for_turn(self):
        with patch.dict(os.environ, {"PHONE_TURN_IP": "8.8.8.8",
                                     "PHONE_TURN_SECRET": "Z" * 48}):
            code, invitation = self.query("/api/webphone/invites", self.token, {"ttlMinutes": 15})
            self.assertEqual(code, 201)
            code, session = self.query("/api/webphone/session", None, {"invite": invitation["path"].split("/")[-1]})
            self.assertEqual(code, 201)
            code, ice = self.query("/api/turn", session["token"])
            self.assertEqual(code, 200)
            self.assertTrue(ice["turnConfigured"])
            self.assertIn("guest:", ice["iceServers"][0]["username"])


if __name__ == "__main__":
    unittest.main()
