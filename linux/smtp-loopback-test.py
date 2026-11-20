#!/usr/bin/env python3
"""Loopback test for the agent-mail-service SMTP listener (:2525).

Creates a throwaway account + address via the REST API, sends one message
through the local SMTP listener, then reads it back from the inbox API.
Prints only statuses, counts and subjects. The API key stays in memory and
is never printed. Run while the stack is up (bash start-all.sh).
"""
import json
import smtplib
import urllib.request
from email.message import EmailMessage

BASE = 'http://127.0.0.1:3000'


def api(method, path, key=None, payload=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={'Content-Type': 'application/json',
                 **({'Authorization': f'Bearer {key}'} if key else {})},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read())


status, acct = api('POST', '/api/accounts', payload={'name': 'loopback-test'})
assert status == 201, acct
key = acct['apiKey']
print('account created: ok (key kept in memory, not printed)')

status, addr = api('POST', '/api/addresses', key=key, payload={'prefix': 'loopbacktest'})
assert status == 200, addr
address = addr['address']
print('address created:', address)

msg = EmailMessage()
msg['From'] = 'sender@localhost'
msg['To'] = address
msg['Subject'] = 'loopback-2525-test'
msg.set_content('Loopback test body.\n')
with smtplib.SMTP('127.0.0.1', 2525, timeout=15) as s:
    s.ehlo()
    s.send_message(msg)
print('smtp send to :2525: accepted')

status, inbox = api('GET', f'/api/inbox/{address}', key=key)
assert status == 200, inbox
emails = inbox.get('emails', inbox.get('messages', []))
print('inbox count:', len(emails))
subjects = [e.get('subject', '') for e in emails]
assert 'loopback-2525-test' in subjects, subjects
print('inbox fetch: subject present')
print('SMTP LOOPBACK (:2525): PASS')
