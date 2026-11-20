#!/usr/bin/env python3
"""Private agent phonebook, text inbox and WebRTC signaling (standard library).

These are local extensions, NOT public phone numbers or carrier SMS.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
import sqlite3
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from provision import provision
from internal_mail import LocalMailRouter, MailError, INTERNAL_DOMAIN
from webphone import WebPhone, WebPhoneError

MAX_BODY = 16384


class AgentPhone:
    def __init__(self, state_dir, count=1000):
        self.state_dir = Path(state_dir).resolve()
        provision(self.state_dir, count)
        identities = json.loads((self.state_dir / 'identities.json').read_text())['extensions']
        self.phones = identities
        # Random high-entropy credential fingerprint identifies this specific
        # storage vault, preventing accidental cross-connection on reused ports.
        self.instance_id = hashlib.sha256(
            identities["2000"]["apiToken"].encode("utf-8")
        ).hexdigest()[:16]
        self.token_hashes = {
            hashlib.sha256(item['apiToken'].encode()).digest(): number
            for number, item in identities.items()
        }
        self.names = {item['agentId']: number for number, item in identities.items()}
        self.db_path = self.state_dir / 'messages.sqlite3'
        self.lock = threading.Lock()
        self.rate = {}
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender TEXT NOT NULL,
                    recipient TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS events_recipient_kind_id
                    ON events(recipient,kind,id);
            ''')
        self.mail = LocalMailRouter(self.db_path, identities)
        self.webphone = WebPhone(self.db_path)
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass

    @contextmanager
    def db(self):
        con = sqlite3.connect(self.db_path, timeout=10)
        con.execute('PRAGMA busy_timeout=10000')
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()

    def sender(self, auth):
        if not auth.startswith('Bearer '):
            return None
        token = auth[7:]
        if len(token) < 32 or len(token) > 256:
            return None
        return self.token_hashes.get(hashlib.sha256(token.encode()).digest())

    def recipient(self, requested, sender=None):
        if not isinstance(requested, str):
            return None
        if requested.startswith('guest:'):
            # Only the invited agent may reply to this private guest session.
            return requested if sender and self.webphone.can_agent_reply(sender, requested) else None
        if requested in self.phones:
            return requested
        return self.names.get(requested)

    def allow(self, sender, kind):
        now = time.monotonic()
        limit = 60 if kind == 'text' else 180
        key = (sender, kind)
        with self.lock:
            hits = [x for x in self.rate.get(key, ()) if now - x < 60]
            if len(hits) >= limit:
                self.rate[key] = hits
                return False
            hits.append(now)
            self.rate[key] = hits
            return True

    def insert(self, sender, recipient, kind, payload):
        with self.db() as db:
            cur = db.execute('INSERT INTO events(sender,recipient,kind,payload) VALUES (?,?,?,?)',
                             (sender, recipient, kind, json.dumps(payload, separators=(',', ':'))))
            return cur.lastrowid

    def events(self, recipient, kind, after=0, limit=50):
        with self.db() as db:
            rows = db.execute('''SELECT id,sender,kind,payload,created_at FROM events
                                 WHERE recipient=? AND kind=? AND id>?
                                 ORDER BY id LIMIT ?''', (recipient, kind, after, limit)).fetchall()
        return [{'id': i, 'from': sender, 'kind': event_kind, 'data': json.loads(payload),
                 'createdAt': timestamp} for i, sender, event_kind, payload, timestamp in rows]

    def cursor(self, recipient, kind):
        with self.db() as db:
            (latest,) = db.execute('SELECT COALESCE(MAX(id),0) FROM events WHERE recipient=? AND kind=?',
                                   (recipient, kind)).fetchone()
        return latest


def handler_factory(service, html_path):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'AgentPhone/0.2'

        def _reply(self, status, value):
            data = json.dumps(value, separators=(',', ':')).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.end_headers()
            self.wfile.write(data)

        def _actor(self):
            actor = service.sender(self.headers.get('Authorization', ''))
            if actor is None:
                self._reply(401, {'ok': False, 'error': 'Agent bearer token required'})
            return actor

        def _cursor(self, qs, key, default, cap):
            try:
                value = int(qs.get(key, [str(default)])[0])
            except (TypeError, ValueError):
                return None
            return value if 0 <= value <= cap else None

        def do_GET(self):
            parsed = urlsplit(self.path)
            path = parsed.path
            if path == '/health':
                return self._reply(200, {'ok': True, 'internalOnly': True,
                                         'publicNumbers': False, 'agents': len(service.phones),
                                         'instanceId': service.instance_id,
                                         'privateDomain': 'agents.localhost'})
            if path == '/' or (path.startswith('/call/') and 24 <= len(path[6:]) <= 128
                                and '/' not in path[6:]):
                data = (html_path if path == '/' else html_path.with_name('webphone_guest.html')).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Frame-Options', 'DENY')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.end_headers()
                return self.wfile.write(data)
            if not path.startswith('/api/'):
                return self._reply(404, {'ok': False, 'error': 'Not found'})
            if path == '/api/webphone/guest/events':
                guest = service.webphone.authenticate_guest(self.headers.get('Authorization', ''))
                if not guest:
                    return self._reply(401, {'ok': False, 'error': 'Valid guest session token required'})
                q = parse_qs(parsed.query)
                after = self._cursor(q, 'after', 0, 2**63 - 1)
                kind = q.get('kind', ['signal'])[0]
                if after is None or kind not in ('signal', 'text'):
                    return self._reply(400, {'ok': False, 'error': 'Invalid event filter'})
                events = service.events(guest['address'], kind, after, 100)
                return self._reply(200, {'ok': True, 'events': events,
                    'cursor': events[-1]['id'] if events else after,
                    'expiresAt': guest['expiresAt'], 'carrierCall': False})
            actor = self._actor()
            if actor is None:
                return
            if path == '/api/me':
                return self._reply(200, {'ok': True, 'extension': actor,
                                         'agentId': service.phones[actor]['agentId'],
                                         'email': service.phones[actor]['agentId'] + '@' + INTERNAL_DOMAIN})
            if path == '/api/routes':
                return self._reply(200, {'ok': True, 'internalMail': True,
                    'internalMessaging': True, 'internalSms': True,
                    'internalCallSignaling': True, 'webphoneGuestLinks': True,
                    'privateWebDomain': 'agents.localhost',
                    'publicDomain': False,
                    'publicEmailRouting': False, 'publicPstnRouting': False,
                    'publicSmsRouting': False, 'domain': INTERNAL_DOMAIN})
            if path == '/api/mailboxes':
                return self._reply(200, {'ok': True, 'addresses': service.mail.addresses(actor),
                    'internetRoutable': False})
            if path == '/api/webphone':
                return self._reply(200, {'ok': True, 'number': 'web:' + actor,
                    'extension': actor, 'dialPath': '/call/ (invitation link required)',
                    'guestLinksAvailable': True, 'carrierPhoneNumber': False,
                    'publicReachable': False, 'protocol': 'WebRTC'})
            qs = parse_qs(parsed.query)
            if path == '/api/email/inbox':
                after = self._cursor(qs, 'after', 0, 2**63-1)
                limit = self._cursor(qs, 'limit', 50, 100)
                if after is None or limit is None or limit == 0:
                    return self._reply(400, {'ok': False, 'error': 'Invalid pagination'})
                emails = service.mail.inbox(actor, after, limit)
                return self._reply(200, {'ok': True, 'emails': emails,
                    'cursor': emails[-1]['id'] if emails else after})
            if path == '/api/directory':
                offset = self._cursor(qs, 'offset', 0, 100000)
                limit = self._cursor(qs, 'limit', 100, 100)
                if offset is None or limit is None or limit == 0:
                    return self._reply(400, {'ok': False, 'error': 'Invalid pagination'})
                phones = sorted(service.phones, key=int)
                return self._reply(200, {'ok': True, 'total': len(phones), 'agents': [
                    {'extension': ext, 'agentId': service.phones[ext]['agentId']}
                    for ext in phones[offset:offset + limit]]})
            if path in ('/api/messages', '/api/signals', '/api/sms/inbox'):
                after = self._cursor(qs, 'after', 0, 2**63 - 1)
                limit = self._cursor(qs, 'limit', 50, 100)
                if after is None or limit is None or limit == 0:
                    return self._reply(400, {'ok': False, 'error': 'Invalid pagination'})
                kind = 'text' if path in ('/api/messages', '/api/sms/inbox') else 'signal'
                events = service.events(actor, kind, after, limit)
                return self._reply(200, {'ok': True, 'events': events,
                                         'internalOnly': path == '/api/sms/inbox',
                                         'carrierSms': False,
                                         'cursor': events[-1]['id'] if events else after})
            if path == '/api/signals/cursor':
                return self._reply(200, {'ok': True, 'cursor': service.cursor(actor, 'signal')})
            return self._reply(404, {'ok': False, 'error': 'Not found'})

        def do_POST(self):
            path = urlsplit(self.path).path
            guest_paths = ('/api/webphone/session', '/api/webphone/guest/signal',
                           '/api/webphone/guest/message')
            agent_paths = ('/api/messages', '/api/signals', '/api/sms/send',
                           '/api/mailboxes', '/api/email/send', '/api/phone/claim',
                           '/api/webphone/invites')
            if path not in guest_paths + agent_paths:
                return self._reply(404, {'ok': False, 'error': 'Not found'})
            actor = None
            if path not in guest_paths:
                actor = self._actor()
                if actor is None:
                    return
            if path == '/api/phone/claim':
                return self._reply(200, {'ok': True, 'extension': actor,
                    'agentId': service.phones[actor]['agentId'],
                    'publicPhoneNumber': False})
            try:
                size = int(self.headers.get('Content-Length', '-1'))
            except ValueError:
                size = -1
            if size < 0 or size > MAX_BODY:
                return self._reply(413, {'ok': False, 'error': 'Request body too large or missing'})
            try:
                body = json.loads(self.rfile.read(size))
            except (ValueError, UnicodeDecodeError):
                return self._reply(400, {'ok': False, 'error': 'Invalid JSON'})
            if not isinstance(body, dict):
                return self._reply(400, {'ok': False, 'error': 'JSON object expected'})
            if path == '/api/webphone/session':
                if not service.allow('webphone-ip:' + self.client_address[0], 'text'):
                    return self._reply(429, {'ok': False, 'error': 'Rate limit exceeded'})
                try:
                    session = service.webphone.open_session(body.get('invite'))
                    return self._reply(201, {'ok': True, **session})
                except WebPhoneError as exc:
                    return self._reply(exc.status, {'ok': False, 'error': str(exc)})
            if path in ('/api/webphone/guest/signal', '/api/webphone/guest/message'):
                guest = service.webphone.authenticate_guest(self.headers.get('Authorization', ''))
                if guest is None:
                    return self._reply(401, {'ok': False, 'error': 'Guest token invalid or expired'})
                kind = 'signal' if path.endswith('/signal') else 'text'
                if kind == 'text':
                    message = body.get('text')
                    if not isinstance(message, str) or not (1 <= len(message) <= 2000):
                        return self._reply(400, {'ok': False, 'error': 'text must be 1–2000 characters'})
                    payload = {'text': message}
                else:
                    signal_type = body.get('type')
                    if signal_type not in ('offer', 'answer', 'candidate', 'hangup'):
                        return self._reply(400, {'ok': False, 'error': 'Invalid signal type'})
                    payload = {'type': signal_type, 'value': body.get('value')}
                    if len(json.dumps(payload)) > 8000:
                        return self._reply(413, {'ok': False, 'error': 'Signal too large'})
                if not service.allow(guest['address'], kind):
                    return self._reply(429, {'ok': False, 'error': 'Rate limit exceeded'})
                event_id = service.insert(guest['address'], guest['owner'], kind, payload)
                return self._reply(201, {'ok': True, 'id': event_id,
                    'from': guest['address'], 'to': guest['owner'],
                    'carrierCall': False, 'webOnly': True})
            if path == '/api/webphone/invites':
                if not service.allow(actor, 'text'):
                    return self._reply(429, {'ok': False, 'error': 'Rate limit exceeded'})
                try:
                    invitation = service.webphone.create_invite(actor, body.get('ttlMinutes', 30))
                    return self._reply(201, {'ok': True, **invitation})
                except WebPhoneError as exc:
                    return self._reply(exc.status, {'ok': False, 'error': str(exc)})
            if path == '/api/mailboxes':
                try:
                    address = service.mail.create_alias(actor, body.get('prefix'))
                    return self._reply(201, {'ok': True, 'address': address,
                                             'internetRoutable': False})
                except MailError as exc:
                    return self._reply(exc.status, {'ok': False, 'error': str(exc)})
                except sqlite3.Error:
                    return self._reply(503, {'ok': False, 'error': 'Storage unavailable'})
            if path == '/api/email/send':
                if not service.allow(actor, 'text'):
                    return self._reply(429, {'ok': False, 'error': 'Agent rate limit exceeded'})
                try:
                    mail_id = service.mail.send(actor, body.get('from'), body.get('to'),
                                                body.get('subject', ''), body.get('text'))
                    return self._reply(201, {'ok': True, 'id': mail_id,
                        'routedInternally': True, 'internetDelivered': False})
                except MailError as exc:
                    return self._reply(exc.status, {'ok': False, 'error': str(exc)})
                except sqlite3.Error:
                    return self._reply(503, {'ok': False, 'error': 'Storage unavailable'})
            recipient = service.recipient(body.get('to'), sender=actor)
            if recipient is None:
                return self._reply(404, {'ok': False, 'error': 'Unknown internal extension'})
            if recipient == actor:
                return self._reply(400, {'ok': False, 'error': 'Cannot send to self'})
            kind = 'text' if path in ('/api/messages', '/api/sms/send') else 'signal'
            if kind == 'text':
                message = body.get('text')
                if not isinstance(message, str) or not (1 <= len(message) <= 2000):
                    return self._reply(400, {'ok': False, 'error': 'text must be 1–2000 characters'})
                payload = {'text': message}
            else:
                signal_type = body.get('type')
                if signal_type not in ('offer', 'answer', 'candidate', 'hangup'):
                    return self._reply(400, {'ok': False, 'error': 'Invalid signal type'})
                payload = {'type': signal_type, 'value': body.get('value')}
                if len(json.dumps(payload)) > 8000:
                    return self._reply(413, {'ok': False, 'error': 'Signal too large'})
            if not service.allow(actor, kind):
                return self._reply(429, {'ok': False, 'error': 'Agent rate limit exceeded'})
            try:
                event_id = service.insert(actor, recipient, kind, payload)
            except sqlite3.Error:
                return self._reply(503, {'ok': False, 'error': 'Storage unavailable'})
            return self._reply(201, {'ok': True, 'id': event_id,
                                     'to': recipient, 'from': actor,
                                     'internalOnly': True, 'carrierSms': False})

        def log_message(self, fmt, *args):
            # Don't log potentially sensitive URL paths or Authorization headers.
            pass

    return Handler


def create_server(state_dir, count=1000, host='127.0.0.1', port=8765, tls_cert=None, tls_key=None):
    service = AgentPhone(state_dir, count)
    html = Path(__file__).with_name('index.html')
    server = ThreadingHTTPServer((host, port), handler_factory(service, html))
    server.daemon_threads = True
    if tls_cert or tls_key:
        if not tls_cert or not tls_key:
            raise ValueError('Both TLS certificate and private key must be supplied')
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(tls_cert, tls_key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    return server


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--state-dir', default=os.environ.get('PHONE_STATE_DIR', './phone-data'))
    ap.add_argument('--count', type=int, default=1000)
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--tls-cert')
    ap.add_argument('--tls-key')
    args = ap.parse_args()
    if args.host not in ('127.0.0.1', 'localhost', '::1') and not (args.tls_cert and args.tls_key):
        ap.error('Non-localhost binding requires --tls-cert and --tls-key (HTTPS)')
    server = create_server(args.state_dir, args.count, args.host, args.port, args.tls_cert, args.tls_key)
    scheme = 'https' if args.tls_cert else 'http'
    print(f'Agent Phone: {scheme}://{args.host}:{server.server_port} ({args.count} internal extensions)', flush=True)
    print('No public phone numbers or carrier SMS. Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
