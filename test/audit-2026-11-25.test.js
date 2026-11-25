'use strict';

// Audit 2026-11-25: guest-state leak, direct-MX fallback, SMTP probe caps,
// SIP probe host validation. Every check fails on the pre-fix code.
process.env.DATA_DIR = ':memory:';
process.env.SMTP_ENABLED = '0';
process.env.PORT = '0';

const assert = require('node:assert/strict');
const net = require('net');
const dns = require('dns');
const {
  app,
  guestInvites,
  guestSessions,
  pruneExpiredGuestState,
  probeSmtpGreeting,
  sendAgentMail,
} = require('../server.js');
const { probeSip, validateSipHost } = require('../lib/linux-configs.js');

let failures = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => console.log(`ok - ${name}`),
        (err) => { failures++; console.error(`FAIL - ${name}\n  ${err.message}`); },
      ));
    } else {
      console.log(`ok - ${name}`);
    }
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n  ${err.message}`);
  }
}

function listen(appToServe) {
  return new Promise((resolve) => {
    const srv = appToServe.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
async function postJson(base, pathName, body, headers = {}) {
  const r = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

// --- 1. Guest invites/sessions are pruned, not kept forever ---
test('pruneExpiredGuestState drops expired invites/sessions and keeps live ones', () => {
  guestInvites.clear();
  guestSessions.clear();
  const now = Date.now();
  guestInvites.set('dead-invite', { token: 'dead-invite', extension: '2000', expiresAt: now - 1000, used: false });
  guestInvites.set('live-invite', { token: 'live-invite', extension: '2000', expiresAt: now + 60000, used: false });
  guestSessions.set('dead-sess', { sessionId: 'x', address: 'guest:x', extension: '2000', expiresAt: now - 1000 });
  guestSessions.set('live-sess', { sessionId: 'y', address: 'guest:y', extension: '2000', expiresAt: now + 60000 });
  pruneExpiredGuestState(now);
  assert.equal(guestInvites.has('dead-invite'), false);
  assert.equal(guestInvites.has('live-invite'), true);
  assert.equal(guestSessions.has('dead-sess'), false);
  assert.equal(guestSessions.has('live-sess'), true);
  guestInvites.clear();
  guestSessions.clear();
});

test('pruneExpiredGuestState evicts oldest entries past the cap', () => {
  guestInvites.clear();
  const now = Date.now();
  for (let i = 0; i < 10005; i++) {
    guestInvites.set(`t${i}`, { token: `t${i}`, extension: '2000', expiresAt: now + 60000 + i, used: false });
  }
  pruneExpiredGuestState(now);
  assert.equal(guestInvites.size, 10000);
  assert.equal(guestInvites.has('t0'), false);
  assert.equal(guestInvites.has('t10004'), true);
  guestInvites.clear();
});

test('redeemed invite is removed from the map (no used-invite litter)', async () => {
  const srv = await listen(app);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const created = await postJson(base, '/api/webphone/invites', { extension: '2000', ttlMinutes: 30 });
    assert.equal(created.status, 201);
    assert.equal(guestInvites.has(created.json.token), true);
    const session = await postJson(base, '/api/webphone/session', { invite: created.json.token });
    assert.equal(session.status, 201);
    assert.equal(guestInvites.has(created.json.token), false);
  } finally {
    srv.close();
  }
});

// --- 2. Direct MX tries every host in priority order ---
test('deliverDirectMx falls through to the second MX when the first is dead, and throws when all are dead', async () => {
  let gotMail = false;
  const fake = net.createServer((s) => {
    s.on('error', () => {});
    s.write('220 fake-mx ESMTP\r\n');
    let dataMode = false;
    s.on('data', (chunk) => {
      const line = chunk.toString();
      if (dataMode) {
        if (line.includes('\r\n.\r\n')) { s.write('250 OK queued\r\n'); dataMode = false; gotMail = true; }
        return;
      }
      if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 HELP\r\n');
      else if (/^MAIL FROM/i.test(line)) s.write('250 OK\r\n');
      else if (/^RCPT TO/i.test(line)) s.write('250 OK\r\n');
      else if (/^DATA/i.test(line)) { s.write('354 End data\r\n'); dataMode = true; }
      else if (/^QUIT/i.test(line)) { s.write('221 Bye\r\n'); s.end(); }
      else s.write('250 OK\r\n');
    });
  });
  await new Promise((resolve, reject) => {
    fake.once('error', reject);
    fake.listen(25, '127.0.0.2', resolve);
  });
  const origResolveMx = dns.promises.resolveMx;
  dns.promises.resolveMx = async () => [
    { exchange: '127.0.0.1', priority: 10 },
    { exchange: '127.0.0.2', priority: 20 },
  ];
  try {
    const r = await sendAgentMail({
      from: 'agent-0001@agents.local',
      to: ['someone@example.org'],
      subject: 'hi',
      text: 'hello',
    });
    assert.equal(r.provider, 'direct-mx');
    assert.equal(gotMail, true);
  } finally {
    dns.promises.resolveMx = origResolveMx;
    await new Promise((resolve) => fake.close(resolve));
  }
  // Same stub, fake server now closed: every MX dead must still throw.
  dns.promises.resolveMx = async () => [
    { exchange: '127.0.0.1', priority: 10 },
    { exchange: '127.0.0.2', priority: 20 },
  ];
  try {
    await assert.rejects(
      sendAgentMail({ from: 'agent-0001@agents.local', to: ['someone@example.org'], subject: 'hi', text: 'hello' }),
      /Direct MX delivery to someone@example\.org failed/,
    );
  } finally {
    dns.promises.resolveMx = origResolveMx;
  }
});

// --- 3. SMTP probe: bounded buffer, multi-line 220 banner ---
test('probeSmtpGreeting fails fast on a junk stream instead of buffering to timeout', async () => {
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    const chunk = Buffer.alloc(65536, 88);
    for (let i = 0; i < 80; i++) s.write(chunk);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const res = await probeSmtpGreeting('127.0.0.1', srv.address().port, 3000);
    const dt = Date.now() - t0;
    assert.equal(res.ok, false);
    assert.match(res.detail, /over \d+ bytes/);
    assert.ok(dt < 1500, `probe took ${dt}ms, should fail fast on oversize response`);
  } finally {
    srv.close();
  }
});

test('probeSmtpGreeting accepts a multi-line 220 banner', async () => {
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    s.write('220-fake ESMTP\r\n220 ready\r\n');
    s.on('data', (c) => {
      const l = c.toString();
      if (/^EHLO/i.test(l)) s.write('250-fake\r\n250 HELP\r\n');
      else if (/^QUIT/i.test(l)) { s.write('221 Bye\r\n'); s.end(); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const res = await probeSmtpGreeting('127.0.0.1', srv.address().port, 3000);
    assert.equal(res.ok, true);
    assert.match(res.detail, /EHLO ok/);
  } finally {
    srv.close();
  }
});

// --- 4. SIP probe host validation (parity with phone/sip_probe.py) ---
test('validateSipHost rejects schemes, paths, and junk like the Python probe', () => {
  for (const bad of ['http://127.0.0.1', 'example.com/evil', '', 'hello world', 'a'.repeat(253), 'bad_host!']) {
    assert.throws(() => validateSipHost(bad), /without a scheme or URL path/);
  }
  assert.equal(validateSipHost('127.0.0.1'), '127.0.0.1');
  assert.equal(validateSipHost('asterisk.local'), 'asterisk.local');
  assert.throws(() => probeSip('http://127.0.0.1', 5060, 100), /without a scheme or URL path/);
  assert.throws(() => probeSip('127.0.0.1', 0, 100), /Port must be between/);
});

test('POST /api/linux/sip-probe returns 400 for a malformed host', async () => {
  const srv = await listen(app);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const bad = await postJson(base, '/api/linux/sip-probe', { host: 'http://127.0.0.1', port: 5060 });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /without a scheme or URL path/);
    const bad2 = await postJson(base, '/api/linux/sip-probe', { host: 'example.com/evil', port: 5060 });
    assert.equal(bad2.status, 400);
  } finally {
    srv.close();
  }
});

Promise.all(pending).then(() => {
  if (failures) process.exit(1);
  console.log('All audit 2026-11-25 tests passed');
});
