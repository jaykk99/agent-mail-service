#!/usr/bin/env python3
"""Local stdio MCP bridge for agent phonebook, texts and call signaling.

Requires PHONE_AGENT_TOKEN; no vendor services or Python dependencies.
"""
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = os.environ.get('PHONE_URL', 'http://127.0.0.1:8765').rstrip('/')
TOKEN = os.environ.get('PHONE_AGENT_TOKEN', '')


def request(path, payload=None):
    if not TOKEN:
        raise ValueError('PHONE_AGENT_TOKEN is required')
    headers = {'Authorization': 'Bearer ' + TOKEN}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    data = json.dumps(payload).encode() if payload is not None else None
    req = Request(API + path, data=data, headers=headers,
                  method='POST' if payload is not None else 'GET')
    try:
        with urlopen(req, timeout=10) as response:
            return json.loads(response.read(1024 * 1024))
    except HTTPError as exc:
        msg = exc.read(2048).decode(errors='replace')
        raise ValueError('Agent Phone returned HTTP %s: %s' % (exc.code, msg)) from exc
    except URLError as exc:
        raise ValueError('Agent Phone unreachable at ' + API) from exc


TOOLS = [
    {'name': 'phone_identity', 'description': 'Show this agent’s private internal phone extension.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'phone_claim', 'description': 'Claim/read this agent’s stable private extension. Not a real mobile number.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'webphone_number', 'description': 'Read this agent’s free self-hosted web:NNNN number, not a carrier number.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'webphone_guest_invite', 'description': 'Create a short-lived one-use link so a browser guest can message or call this agent.',
     'inputSchema': {'type': 'object', 'properties': {
         'ttlMinutes': {'type': 'integer', 'minimum': 5, 'maximum': 120}}}},
    {'name': 'routing_status', 'description': 'See which phone and mail routes work locally and which public routes are unavailable.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'email_addresses', 'description': 'List this agent’s self-hosted local inbox addresses.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'email_create_alias', 'description': 'Reserve a persistent internal mail address on agents.invalid. Not an internet email address.',
     'inputSchema': {'type': 'object', 'properties': {'prefix': {'type': 'string'}}, 'required': ['prefix']}},
    {'name': 'email_send', 'description': 'Send a local email to another agent’s agents.invalid address only.',
     'inputSchema': {'type': 'object', 'properties': {
         'from': {'type': 'string'}, 'to': {'type': 'string'},
         'subject': {'type': 'string'}, 'text': {'type': 'string'}},
         'required': ['from', 'to', 'text']}},
    {'name': 'email_inbox', 'description': 'Read mail sent to any of this agent’s local email aliases.',
     'inputSchema': {'type': 'object', 'properties': {'after': {'type': 'integer', 'minimum': 0}}}},
    {'name': 'phone_directory', 'description': 'List local extension numbers of other agents.',
     'inputSchema': {'type': 'object', 'properties': {
         'offset': {'type': 'integer', 'minimum': 0}, 'limit': {'type': 'integer', 'minimum': 1, 'maximum': 100}}}},
    {'name': 'phone_send_text', 'description': 'Send an internal text message to another agent (not SMS).',
     'inputSchema': {'type': 'object', 'properties': {
         'to': {'type': 'string'}, 'text': {'type': 'string'}}, 'required': ['to', 'text']}},
    {'name': 'phone_inbox', 'description': 'Read new internal messages for this agent.',
     'inputSchema': {'type': 'object', 'properties': {'after': {'type': 'integer', 'minimum': 0}}}},
    {'name': 'sms_send_internal', 'description': 'Send SMS-style text to another INTERNAL agent extension. Not carrier SMS.',
     'inputSchema': {'type': 'object', 'properties': {
         'to': {'type': 'string'}, 'text': {'type': 'string'}}, 'required': ['to', 'text']}},
    {'name': 'sms_inbox_internal', 'description': 'Read internal SMS-style texts. Does NOT receive ordinary mobile SMS.',
     'inputSchema': {'type': 'object', 'properties': {'after': {'type': 'integer', 'minimum': 0}}}},
    {'name': 'phone_call_signals', 'description': 'Read peer-to-peer call signaling events for this agent.',
     'inputSchema': {'type': 'object', 'properties': {'after': {'type': 'integer', 'minimum': 0}}}},
    {'name': 'phone_send_call_signal', 'description': 'Send WebRTC call signaling only, not audio.',
     'inputSchema': {'type': 'object', 'properties': {
         'to': {'type': 'string'}, 'type': {'type': 'string', 'enum': ['offer', 'answer', 'candidate', 'hangup']},
         'value': {}}, 'required': ['to', 'type']}},
]


def execute(name, args):
    if not isinstance(args, dict):
        raise ValueError('Tool arguments must be an object')
    if name == 'phone_identity':
        return request('/api/me')
    if name == 'phone_claim':
        return request('/api/phone/claim', {})
    if name == 'webphone_number':
        return request('/api/webphone')
    if name == 'webphone_guest_invite':
        return request('/api/webphone/invites', {'ttlMinutes': args.get('ttlMinutes', 30)})
    if name == 'routing_status':
        return request('/api/routes')
    if name == 'email_addresses':
        return request('/api/mailboxes')
    if name == 'email_create_alias':
        return request('/api/mailboxes', {'prefix': args['prefix']})
    if name == 'email_send':
        return request('/api/email/send', {'from': args['from'], 'to': args['to'],
                                           'subject': args.get('subject', ''),
                                           'text': args['text']})
    if name == 'email_inbox':
        return request('/api/email/inbox?' + urlencode({'after': args.get('after', 0)}))
    if name == 'phone_directory':
        return request('/api/directory?' + urlencode({'offset': args.get('offset', 0),
                                                       'limit': args.get('limit', 100)}))
    if name == 'phone_send_text':
        return request('/api/messages', {'to': args['to'], 'text': args['text']})
    if name == 'phone_inbox':
        return request('/api/messages?' + urlencode({'after': args.get('after', 0)}))
    if name == 'sms_send_internal':
        return request('/api/sms/send', {'to': args['to'], 'text': args['text']})
    if name == 'sms_inbox_internal':
        return request('/api/sms/inbox?' + urlencode({'after': args.get('after', 0)}))
    if name == 'phone_call_signals':
        return request('/api/signals?' + urlencode({'after': args.get('after', 0)}))
    if name == 'phone_send_call_signal':
        return request('/api/signals', {'to': args['to'], 'type': args['type'], 'value': args.get('value')})
    raise ValueError('Unknown tool: ' + str(name))


def handle(msg):
    method = msg.get('method')
    if method == 'initialize':
        requested = msg.get('params', {}).get('protocolVersion', '2025-06-18')
        return {'protocolVersion': requested if requested in ('2024-11-05', '2025-03-26', '2025-06-18') else '2025-06-18',
                'capabilities': {'tools': {}}, 'serverInfo': {'name': 'agent-phone-local', 'version': '0.1.0'}}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'tools/call':
        params = msg.get('params') or {}
        try:
            result = execute(params.get('name'), params.get('arguments') or {})
            return {'content': [{'type': 'text', 'text': json.dumps(result)}]}
        except (KeyError, TypeError, ValueError) as exc:
            return {'content': [{'type': 'text', 'text': str(exc)}], 'isError': True}
    raise ValueError('Unsupported method ' + str(method))


def main():
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if 'id' not in message:
                continue  # MCP notification: no response
            try:
                result = handle(message)
                out = {'jsonrpc': '2.0', 'id': message['id'], 'result': result}
            except (KeyError, ValueError, TypeError) as exc:
                out = {'jsonrpc': '2.0', 'id': message['id'], 'error': {'code': -32601, 'message': str(exc)}}
            sys.stdout.write(json.dumps(out, separators=(',', ':')) + '\n')
            sys.stdout.flush()
        except (ValueError, TypeError) as exc:
            sys.stderr.write('Invalid MCP input: ' + str(exc) + '\n')


if __name__ == '__main__':
    main()
