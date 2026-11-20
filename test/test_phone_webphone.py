import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from server import create_server
from webphone import WebPhone


class GuestWebPhoneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.srv = create_server(cls.folder.name, count=1000, port=0)
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.srv.server_port)
        identities = json.loads((Path(cls.folder.name) / "identities.json").read_text())["extensions"]
        cls.a = identities["2000"]["apiToken"]
        cls.b = identities["2001"]["apiToken"]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.thread.join(timeout=3)
        cls.folder.cleanup()

    def query(self, path, token=None, payload=None):
        h = {}
        if token:
            h["Authorization"] = "Bearer " + token
        if payload is not None:
            h["Content-Type"] = "application/json"
        req = Request(self.base + path,
                      data=json.dumps(payload).encode("utf-8") if payload is not None else None, headers=h)
        try:
            with urlopen(req, timeout=5) as r:
                body = r.read()
                return r.status, json.loads(body) if "json" in r.headers.get("Content-Type", "") else body
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def invite(self, owner=None, ttl=30):
        status, data = self.query("/api/webphone/invites", owner or self.a,
                                  {"ttlMinutes": ttl})
        self.assertEqual(status, 201, data)
        return data

    def session(self, invitation):
        return self.query("/api/webphone/session", payload={"invite": invitation["path"].split("/")[-1]})

    def test_01_number_is_stable_private_and_not_e164(self):
        status, response = self.query("/api/webphone", self.a)
        self.assertEqual(status, 200)
        self.assertEqual(response["number"], "web:2000")
        self.assertFalse(response["carrierPhoneNumber"])
        self.assertEqual(self.query("/api/webphone", self.b)[1]["number"], "web:2001")
        self.assertEqual(self.query("/api/webphone")[0], 401)
        self.assertTrue(self.query("/api/routes", self.a)[1]["webphoneGuestLinks"])

    def test_02_one_time_link_and_browser_page(self):
        invite = self.invite()
        self.assertTrue(invite["singleUse"])
        self.assertFalse(invite["carrierPhoneNumber"])
        status, page = self.query(invite["path"])
        self.assertEqual(status, 200)
        self.assertIn(b"WebPhone Guest Call", page)
        status, accepted = self.session(invite)
        self.assertEqual(status, 201)
        self.assertEqual(accepted["extension"], "2000")
        self.assertEqual(accepted["webNumber"], "web:2000")
        self.assertFalse(accepted["carrierCall"])
        self.assertEqual(self.session(invite)[0], 410)
        self.assertEqual(self.query("/api/webphone/session", payload={"invite": "invalid"})[0], 404)

    def test_03_guest_to_agent_text_and_agent_to_guest_reply(self):
        invite = self.invite()
        _, guest = self.session(invite)
        status, msg = self.query("/api/webphone/guest/message", guest["token"], {"text": "Hello agent"})
        self.assertEqual(status, 201)
        self.assertEqual(msg["to"], "2000")
        self.assertEqual(msg["from"], "guest:" + guest["sessionId"])
        self.assertTrue(msg["webOnly"])
        self.assertFalse(msg["carrierCall"])
        events = self.query("/api/messages", self.a)[1]["events"]
        self.assertTrue(any(e["id"] == msg["id"] and e["data"]["text"] == "Hello agent" for e in events))
        self.assertFalse(self.query("/api/messages", self.b)[1]["events"])
        status, reply = self.query("/api/messages", self.a, {"to": msg["from"], "text": "Hi there"})
        self.assertEqual(status, 201)
        events = self.query("/api/webphone/guest/events?kind=text", guest["token"])[1]["events"]
        self.assertTrue(any(e["id"] == reply["id"] and e["data"]["text"] == "Hi there" for e in events))
        self.assertEqual(self.query("/api/messages", self.b, {"to": msg["from"], "text": "unauthorized"})[0], 404)
        self.assertEqual(self.query("/api/webphone/guest/events?kind=text")[0], 401)

    def test_04_voice_offer_answer_candidate_and_hangup(self):
        invite = self.invite()
        _, guest = self.session(invite)
        auth = guest["token"]
        status, offer = self.query("/api/webphone/guest/signal", auth,
                                   {"type": "offer", "value": {"type": "offer", "sdp": "dummy"}})
        self.assertEqual(status, 201)
        self.assertTrue(any(e["id"] == offer["id"] for e in self.query("/api/signals", self.a)[1]["events"]))
        status, answer = self.query("/api/signals", self.a, {"to": "guest:" + guest["sessionId"],
                                                  "type": "answer", "value": {"type": "answer", "sdp": "reply"}})
        self.assertEqual(status, 201)
        data = self.query("/api/webphone/guest/events?kind=signal", auth)[1]["events"]
        self.assertTrue(any(e["id"] == answer["id"] and e["data"]["type"] == "answer" for e in data))
        self.assertEqual(self.query("/api/webphone/guest/signal", auth, {"type": "bad"})[0], 400)
        self.assertEqual(self.query("/api/webphone/guest/signal", "wrong", {"type": "hangup"})[0], 401)
        self.assertEqual(self.query("/api/signals", self.b, {"to": "guest:" + guest["sessionId"],
                                                     "type": "hangup", "value": None})[0], 404)

    def test_05_expired_tokens_cannot_be_reused(self):
        invite = self.invite()
        _, guest = self.session(invite)
        with sqlite3.connect(Path(self.folder.name) / "messages.sqlite3") as db:
            db.execute("UPDATE webphone_sessions SET expires_at=? WHERE id=?",
                       (int(time.time()) - 1, guest["sessionId"]))
        self.assertEqual(self.query("/api/webphone/guest/events", guest["token"])[0], 401)
        self.assertEqual(self.query("/api/messages", self.a, {"to": "guest:" + guest["sessionId"],
                                                      "text": "blocked"})[0], 404)
        other_invite = self.invite()
        with sqlite3.connect(Path(self.folder.name) / "messages.sqlite3") as db:
            db.execute("UPDATE webphone_invites SET expires_at=? WHERE token_hash=?",
                       (int(time.time()) - 1, __import__("hashlib").sha256(
                           other_invite["path"].split("/")[-1].encode()).hexdigest()))
        self.assertEqual(self.session(other_invite)[0], 410)

    def test_06_invalid_invite_parameters(self):
        for ttl in (-1, 0, 1, 121, "30", None, True):
            status, _ = self.query("/api/webphone/invites", self.a, {"ttlMinutes": ttl})
            self.assertEqual(status, 400)
        self.assertEqual(self.query("/api/webphone/invites", "bad", {})[0], 401)

    def test_07_mcp_can_issue_webphone_invite(self):
        import mcp
        mcp.API = self.base
        mcp.TOKEN = self.a
        listed = {tool["name"] for tool in mcp.handle({"method": "tools/list"})["tools"]}
        self.assertIn("webphone_number", listed)
        self.assertIn("webphone_guest_invite", listed)
        result = mcp.handle({"method": "tools/call", "params": {
            "name": "webphone_number", "arguments": {}}})
        self.assertEqual(json.loads(result["content"][0]["text"])["number"], "web:2000")


if __name__ == "__main__":
    unittest.main()
