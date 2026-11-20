import json
import threading
import unittest
import tempfile
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from server import create_server


class InternalSmsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.srv = create_server(cls.temp.name, count=1000, port=0)
        cls.thread = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.thread.start()
        identities = json.loads((Path(cls.temp.name) / "identities.json").read_text())["extensions"]
        cls.a = identities["2000"]["apiToken"]
        cls.b = identities["2001"]["apiToken"]
        cls.url = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.thread.join(timeout=3)
        cls.temp.cleanup()

    def req(self, path, token, data=None):
        headers = {"Authorization": "Bearer " + token}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.url + path,
                          data=json.dumps(data).encode() if data is not None else None,
                          headers=headers)
        try:
            with urlopen(request, timeout=5) as reply:
                return reply.status, json.load(reply)
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_local_domain_and_explicit_routes(self):
        _, health = self.req("/health", self.a)
        self.assertEqual(health["privateDomain"], "agents.localhost")
        self.assertEqual(len(health["instanceId"]), 16)
        _, routes = self.req("/api/routes", self.a)
        self.assertTrue(routes["internalSms"])
        self.assertEqual(routes["privateWebDomain"], "agents.localhost")
        self.assertEqual(routes["domain"], "agents.invalid")
        self.assertFalse(routes["publicDomain"])
        self.assertFalse(routes["publicSmsRouting"])

    def test_internal_sms_style_delivery_and_isolation(self):
        status, sent = self.req("/api/sms/send", self.a, {"to": "2001", "text": "Hi via internal SMS"})
        self.assertEqual(status, 201)
        self.assertTrue(sent["internalOnly"])
        self.assertFalse(sent["carrierSms"])
        status, inbox = self.req("/api/sms/inbox", self.b)
        self.assertEqual(status, 200)
        self.assertTrue(any(row["id"] == sent["id"] and row["data"]["text"] == "Hi via internal SMS"
                            for row in inbox["events"]))
        self.assertFalse(inbox["carrierSms"])
        self.assertFalse(self.req("/api/sms/inbox", self.a)[1]["events"])
        self.assertEqual(self.req("/api/sms/send", self.a, {"to": "+12045550123", "text": "X"})[0], 404)
        self.assertEqual(self.req("/api/sms/inbox", "wrong")[0], 401)

    def test_sms_is_available_through_mcp(self):
        import mcp
        mcp.TOKEN = self.a
        mcp.API = self.url
        tools = mcp.handle({"method": "tools/list"})["tools"]
        names = {tool["name"] for tool in tools}
        self.assertTrue({"sms_send_internal", "sms_inbox_internal"}.issubset(names))
        call = mcp.handle({"method": "tools/call", "params": {
            "name": "sms_send_internal", "arguments": {"to": "2001", "text": "MCP text"}}})
        parsed = json.loads(call["content"][0]["text"])
        self.assertTrue(parsed["internalOnly"])
        self.assertFalse(parsed["carrierSms"])


if __name__ == "__main__":
    unittest.main()
