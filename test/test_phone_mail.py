import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'phone'))
from server import create_server


class AgentEmailRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.server = create_server(cls.temp.name, count=1000, port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        identities = json.loads((Path(cls.temp.name) / 'identities.json').read_text())['extensions']
        cls.a = identities['2000']['apiToken']
        cls.b = identities['2001']['apiToken']
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.temp.cleanup()

    def req(self, path, token=None, data=None):
        headers = {'Authorization': 'Bearer ' + (token or 'wrong-token')}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = Request(self.base + path,
                      data=json.dumps(data).encode() if data is not None else None,
                      headers=headers)
        try:
            with urlopen(req, timeout=5) as resp:
                return resp.status, json.load(resp)
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_01_routes_status_is_honest(self):
        code, status = self.req('/api/routes', self.a)
        self.assertEqual(code, 200)
        self.assertTrue(status['internalMail'])
        self.assertFalse(status['publicEmailRouting'])
        self.assertFalse(status['publicPstnRouting'])
        self.assertFalse(status['publicSmsRouting'])

    def test_02_auto_created_1000_unique_inboxes(self):
        from internal_mail import LocalMailRouter
        import sqlite3
        with sqlite3.connect(Path(self.temp.name) / 'messages.sqlite3') as db:
            rows = db.execute('SELECT address,owner FROM local_mailboxes').fetchall()
        self.assertEqual(len(rows), 1000)
        self.assertEqual(len(set(address for address, _ in rows)), 1000)
        self.assertEqual(self.req('/api/me', self.a)[1]['email'], 'agent-0001@agents.invalid')
        self.assertEqual(self.req('/api/mailboxes', self.b)[1]['addresses'],
                         ['agent-0002@agents.invalid'])
        self.assertEqual(self.req('/api/phone/claim', self.a, {})[1]['extension'], '2000')

    def test_03_alias_creation_ownership_validation(self):
        status, data = self.req('/api/mailboxes', self.a, {'prefix': 'team-one'})
        self.assertEqual(status, 201)
        self.assertEqual(data['address'], 'team-one@agents.invalid')
        self.assertEqual(self.req('/api/mailboxes', self.a, {'prefix': 'team-one'})[0], 201)
        self.assertEqual(self.req('/api/mailboxes', self.b, {'prefix': 'team-one'})[0], 409)
        self.assertEqual(self.req('/api/mailboxes', self.b, {'prefix': '@other.org'})[0], 400)
        self.assertEqual(self.req('/api/mailboxes', self.b, {'prefix': 'bad space'})[0], 400)
        self.assertEqual(self.req('/api/mailboxes', 'bogus', {'prefix': 'intruder'})[0], 401)

    def test_04_email_is_routed_and_private(self):
        status, sent = self.req('/api/email/send', self.a, {
            'from': 'team-one@agents.invalid', 'to': 'agent-0002@agents.invalid',
            'subject': 'handoff', 'text': 'Internal only'})
        self.assertEqual(status, 201)
        self.assertTrue(sent['routedInternally'])
        self.assertFalse(sent['internetDelivered'])
        mail = self.req('/api/email/inbox', self.b)[1]['emails']
        self.assertEqual(mail[-1]['id'], sent['id'])
        self.assertEqual(mail[-1]['text'], 'Internal only')
        self.assertEqual(mail[-1]['subject'], 'handoff')
        self.assertEqual(self.req('/api/email/inbox', self.a)[1]['emails'], [])
        self.assertEqual(self.req('/api/email/send', self.b, {
            'from': 'team-one@agents.invalid','to': 'agent-0001@agents.invalid',
            'text': 'spoof'})[0], 403)
        self.assertEqual(self.req('/api/email/send', self.a, {
            'from': 'team-one@agents.invalid','to': 'outside@gmail.com',
            'text': 'cannot deliver'})[0], 404)

    def test_05_restart_preserves_routes_and_keys(self):
        from server import AgentPhone
        AgentPhone(self.temp.name, 1000)
        self.assertIn('team-one@agents.invalid', self.req('/api/mailboxes', self.a)[1]['addresses'])
        self.assertTrue(self.req('/api/email/inbox', self.b)[1]['emails'])
        self.assertEqual(self.req('/api/me', self.a)[1]['extension'], '2000')

    def test_06_email_alias_quota(self):
        for idx in range(8):
            code, _ = self.req('/api/mailboxes', self.a, {'prefix': 'my-alias-' + str(idx)})
            self.assertEqual(code, 201)
        self.assertEqual(self.req('/api/mailboxes', self.a, {'prefix': 'one-too-many'})[0], 429)

    def test_07_mcp_tools_for_email_and_phone(self):
        import mcp
        mcp.API = self.base
        mcp.TOKEN = self.a
        listed = mcp.handle({'method': 'tools/list'})['tools']
        names = [tool['name'] for tool in listed]
        self.assertIn('email_create_alias', names)
        self.assertIn('email_send', names)
        self.assertIn('email_inbox', names)
        self.assertIn('phone_claim', names)
        result = mcp.handle({'method': 'tools/call',
                             'params': {'name': 'phone_claim', 'arguments': {}}})
        self.assertEqual(json.loads(result['content'][0]['text'])['extension'], '2000')


if __name__ == '__main__':
    unittest.main()
