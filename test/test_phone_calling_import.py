"""Calling-linux metadata bridge: preserve labels, never import unowned DIDs."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "phone"))
from calling_linux_import import parse_fleet, write_import
from provision import provision
from server import create_server


class CallingLinuxImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "monico-state"
        provision(self.state, 1000)
        self.source = self.root / "carrier-state.json"
        self.source.write_text(json.dumps({
            "domain": "sms.customlinux.org",
            "publicIp": "198.51.100.45",
            "messages": [{"body": "Fake OTP 729104", "port25Verified": True}],
            "numbers": [
                {"extension": 1, "label": "Primary Switchboard",
                 "e164": "+12015550001", "phoneNumber": "+1 (201) 555-0001",
                 "sipUsername": "did_12015550001", "smsEnabled": True,
                 "voiceEnabled": True, "totalReceived": 10},
                {"extension": 1000, "label": "Remote Field Agent",
                 "e164": "+12015551000", "lastOtp": "123456"},
            ],
        }), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_only_trusted_display_labels_migrate(self):
        data = parse_fleet(self.source)
        self.assertEqual(set(data["labels"]), {"2000", "2999"})
        self.assertEqual(data["labels"]["2000"]["displayName"], "Primary Switchboard")
        self.assertFalse(data["publicTelephoneNumbersProvisioned"])
        self.assertFalse(data["publicSmsRoutesProvisioned"])
        self.assertNotIn("+1201555", json.dumps(data))
        self.assertNotIn("729104", json.dumps(data))
        self.assertNotIn("123456", json.dumps(data))
        self.assertNotIn("198.51.100.45", json.dumps(data))

    def test_import_preserves_existing_tokens_and_is_private(self):
        original = (self.state / "identities.json").read_bytes()
        result = write_import(self.source, self.state)
        self.assertEqual(result["imported_labels"], 2)
        self.assertEqual((self.state / "calling-linux-labels.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / "identities.json").read_bytes(), original)
        with self.assertRaises(FileExistsError):
            write_import(self.source, self.state)

    def test_mapping_rejects_duplicate_and_bad_extensions(self):
        for numbers in (
            [{"extension": 1}, {"extension": 1}],
            [{"extension": 0}], [{"extension": 1001}],
            [{"extension": "1"}], [None]
        ):
            with self.subTest(numbers=numbers):
                self.source.write_text(json.dumps({"numbers": numbers}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    parse_fleet(self.source)

    def test_server_directory_uses_labels_not_public_phone_numbers(self):
        write_import(self.source, self.state)
        service = create_server(self.state, count=1000, host="127.0.0.1", port=0)
        runner = threading.Thread(target=service.serve_forever, daemon=True)
        runner.start()
        try:
            idents = json.loads((self.state / "identities.json").read_text())["extensions"]
            def get(endpoint):
                req = Request(
                    f"http://127.0.0.1:{service.server_port}{endpoint}",
                    headers={"Authorization": "Bearer " + idents["2000"]["apiToken"]})
                with urlopen(req, timeout=5) as res:
                    return json.loads(res.read())
            me = get("/api/me")
            self.assertEqual(me["displayName"], "Primary Switchboard")
            self.assertEqual(me["webPhoneNumber"], "web:2000")
            directory = get("/api/directory?offset=0&limit=1")["agents"][0]
            self.assertEqual(directory["displayName"], "Primary Switchboard")
            self.assertFalse(directory["publicTelephoneNumber"])
            self.assertNotIn("e164", directory)
            self.assertNotIn("carrier", json.dumps(directory).lower())
            routes = get("/api/routes")
            self.assertTrue(routes["callingLinuxDisplayLabelsImported"])
            self.assertFalse(routes["publicPstnRouting"])
            self.assertFalse(routes["publicSmsRouting"])
        finally:
            service.shutdown()
            service.server_close()
            runner.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
