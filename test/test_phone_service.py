import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'phone'))
from server import create_server


class PhoneServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.http = create_server(cls.tmp.name, count=1000, port=0)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        identities = json.loads((Path(cls.tmp.name) / 'identities.json').read_text())['extensions']
        cls.a, cls.b = identities['2000']['apiToken'], identities['2001']['apiToken']
        cls.port = cls.http.server_port

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=3)
        cls.tmp.cleanup()

    def query(self, path, key=None, payload=None):
        headers = {'Authorization': 'Bearer ' + (key or 'invalid')}
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        req = Request(f'http://127.0.0.1:{self.port}{path}',
                      data=json.dumps(payload).encode() if payload is not None else None,
                      headers=headers)
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read())
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def test_01_all_agent_identities_survive_restart(self):
        self.assertEqual(self.query('/health')[1]['agents'], 1000)
        identities = json.loads((Path(self.tmp.name) / 'identities.json').read_text())['extensions']
        self.assertEqual(len({x['apiToken'] for x in identities.values()}), 1000)
        from server import AgentPhone
        AgentPhone(self.tmp.name, count=1000)
        again = json.loads((Path(self.tmp.name) / 'identities.json').read_text())['extensions']
        self.assertEqual(identities, again)

    def test_02_private_identity_and_directory(self):
        self.assertEqual(self.query('/api/me')[0], 401)
        self.assertEqual(self.query('/api/me', self.a)[1]['extension'], '2000')
        status, directory = self.query('/api/directory?offset=998&limit=10', self.a)
        self.assertEqual(status, 200)
        self.assertEqual([x['extension'] for x in directory['agents']], ['2998', '2999'])
        self.assertNotIn('apiToken', json.dumps(directory))

    def test_03_text_is_private(self):
        status, sent = self.query('/api/messages', self.a, {'to': 'agent-0002', 'text': 'Hi agent 2'})
        self.assertEqual(status, 201)
        self.assertEqual(sent['from'], '2000')
        r = self.query('/api/messages', self.b)[1]['events']
        self.assertTrue(any(x['data']['text'] == 'Hi agent 2' and x['from'] == '2000' for x in r))
        self.assertEqual(self.query('/api/messages', self.a)[1]['events'], [])
        self.assertEqual(self.query('/api/messages', 'wrongkey')[0], 401)
        self.assertEqual(self.query('/api/messages', self.a, {'to': '5999', 'text': 'X'})[0], 404)
        self.assertEqual(self.query('/api/messages', self.a, {'to': '2001', 'text': ''})[0], 400)

    def test_04_voice_signaling_is_isolated(self):
        cursor = self.query('/api/signals/cursor', self.b)[1]['cursor']
        status, offer = self.query('/api/signals', self.a, {'to': '2001', 'type': 'offer',
                                                          'value': {'type': 'offer', 'sdp': 'sample'}})
        self.assertEqual(status, 201)
        events = self.query('/api/signals?after=' + str(cursor), self.b)[1]['events']
        self.assertEqual(events[0]['id'], offer['id'])
        self.assertEqual(events[0]['data']['type'], 'offer')
        self.assertEqual(self.query('/api/signals', self.a)[1]['events'], [])
        self.assertEqual(self.query('/api/signals', self.a, {'to': '2001', 'type': 'bogus'})[0], 400)

    def test_05_storage_persists_sqlite(self):
        db = sqlite3.connect(Path(self.tmp.name) / 'messages.sqlite3')
        self.assertGreater(db.execute('select count(*) from events').fetchone()[0], 0)
        db.close()


if __name__ == '__main__':
    unittest.main()
