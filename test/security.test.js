/** Regression checks: public example tokens must never authenticate as admin. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// This process intentionally simulates a misconfigured production instance.
process.env.AGENT_MAIL_TOKEN = 'dev-token-change-me';
process.env.MAIL_DOMAIN = 'example.test';
const { app, secureMasterKey } = require('../server.js');

test('master token selection fails closed for documented defaults', () => {
  for (const bad of [
    undefined, '', '   ', 'dev-token-change-me',
    'generate-a-long-random-token-here',
  ]) assert.equal(secureMasterKey(bad), '');
  assert.equal(secureMasterKey('secure-unique-token-for-test-1234'), 'secure-unique-token-for-test-1234');
});

test('known fallback token cannot read inboxes or forge inbound mail', async () => {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const master = { Authorization: 'Bearer dev-token-change-me' };
    const inbox = await fetch(base + '/api/addresses', { headers: master });
    assert.equal(inbox.status, 401, 'public example token cannot list inboxes');

    const forged = await fetch(base + '/api/inbound', {
      method: 'POST',
      headers: { ...master, 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'agent@example.test', from: 'forger@example.test',
        subject: 'fake', text: 'attack',
      }),
    });
    assert.equal(forged.status, 401, 'public example token cannot inject inbound mail');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
