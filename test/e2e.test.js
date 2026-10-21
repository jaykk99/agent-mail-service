/**
 * Agent Mail Service — local end-to-end tests (no test framework, node:test style).
 *
 * Spawns server.js on local ports with the in-memory store, then drives it
 * over HTTP (global fetch) and raw SMTP (net.Socket):
 *   - health endpoint (unauthenticated)
 *   - auth enforcement on protected endpoints
 *   - address creation incl. empty-after-sanitize prefix fallback
 *   - receiving a real SMTP message and polling the inbox API
 *   - full email fetch, verify-link extraction (trailing punctuation trimmed)
 *   - inbox clearing
 *
 * Local-only: never touches Supabase, the network, or real mail.
 * Run: npm test
 */
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3310;
const SMTP_PORT = 2526;
const TOKEN = 'test-token-abc123';
const DOMAIN = 'mail.example.test';
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n  ${err.message}`);
  }
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

function smtpSend({ to, from, subject, body }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: SMTP_PORT });
    sock.setEncoding('utf8');
    let buf = '';
    let step = 0; // 0=greet, 1=HELO ack, 2=MAIL ack, 3=RCPT ack, 4=DATA ack, 5=body ack
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('SMTP timed out at step ' + step)); }, 8000);
    sock.on('data', d => {
      buf += d;
      while (buf.includes('\r\n')) {
        const i = buf.indexOf('\r\n');
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (step === 0 && /^220 /.test(line)) { sock.write('HELO test\r\n'); step = 1; }
        else if (step === 1 && /^250 /.test(line)) { sock.write(`MAIL FROM:<${from}>\r\n`); step = 2; }
        else if (step === 2 && /^250 /.test(line)) { sock.write(`RCPT TO:<${to}>\r\n`); step = 3; }
        else if (step === 3 && /^250 /.test(line)) { sock.write('DATA\r\n'); step = 4; }
        else if (step === 4 && /^354 /.test(line)) {
          sock.write(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.\r\n`);
          step = 5;
        }
        else if (step === 5 && /^250 /.test(line)) { sock.write('QUIT\r\n'); sock.end(); clearTimeout(timer); resolve(); }
      }
    });
    sock.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function waitForHealth(child, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  child.kill('SIGKILL');
  throw new Error('server did not become healthy in time');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SMTP_PORT: String(SMTP_PORT), AGENT_MAIL_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', err => { console.error('spawn failed', err); process.exit(1); });

  try {
    await waitForHealth(child);

    await test('health returns ok with memory storage', async () => {
      const r = await fetch(`${BASE}/health`);
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.storage, 'memory');
      assert.equal(j.domain, DOMAIN);
    });

    await test('protected endpoints reject requests without token', async () => {
      const r1 = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r1.status, 401);
      const r2 = await fetch(`${BASE}/api/inbox/nobody@${DOMAIN}`);
      assert.equal(r2.status, 401);
    });

    await test('protected endpoints reject wrong token', async () => {
      const r = await fetch(`${BASE}/api/inbox/nobody@${DOMAIN}`, { headers: { Authorization: 'Bearer wrong' } });
      assert.equal(r.status, 401);
    });

    let address;
    await test('create address with prefix', async () => {
      const r = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'signup-1' }) });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.address, `signup-1@${DOMAIN}`);
      address = j.address;
    });

    await test('empty-after-sanitize prefix falls back to generated prefix', async () => {
      const r = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: '!!!' }) });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.ok(j.address.startsWith('agent'), `got ${j.address}`);
      assert.ok(!j.address.startsWith('@'), `address has empty local part: ${j.address}`);
    });

    await test('verify-link returns nothing before any mail arrives', async () => {
      const r = await fetch(`${BASE}/api/verify-link/${encodeURIComponent(address)}`, { headers });
      const j = await r.json();
      assert.equal(j.ok, false);
    });

    const verifyUrl = 'https://provider.example.com/verify?token=abc123';
    await test('SMTP receive stores email', async () => {
      await smtpSend({
        to: address,
        from: 'verify@provider.example.com',
        subject: 'Confirm your account',
        body: `Welcome! Please confirm your account:\n${verifyUrl}.\nThanks.`,
      });
      // give the parser a moment
      await new Promise(r => setTimeout(r, 500));
      const r = await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}`, { headers });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.count, 1);
      assert.equal(j.emails[0].subject, 'Confirm your account');
      assert.ok(!('text' in j.emails[0]), 'list view must not include body text');
    });

    await test('full email fetch includes links with trailing punctuation trimmed', async () => {
      const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}`, { headers })).json();
      const id = list.emails[0].id;
      const r = await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}/${id}`, { headers });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.ok(j.email.text.includes('Confirm your account') || j.email.text.includes('Welcome'));
      assert.ok(j.email.links.includes(verifyUrl), `links were: ${JSON.stringify(j.email.links)}`);
    });

    await test('verify-link finds the verification URL', async () => {
      const r = await fetch(`${BASE}/api/verify-link/${encodeURIComponent(address)}?from=provider.example.com`, { headers });
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.url, verifyUrl);
    });

    await test('unknown email id returns 404', async () => {
      const r = await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}/nope`, { headers });
      assert.equal(r.status, 404);
    });

    await test('delete clears the inbox', async () => {
      const del = await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}`, { method: 'DELETE', headers });
      assert.equal((await del.json()).ok, true);
      const j = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}`, { headers })).json();
      assert.equal(j.count, 0);
    });

    await test('invalid address param returns 400', async () => {
      const r = await fetch(`${BASE}/api/inbox/${encodeURIComponent('not-an-address')}`, { headers });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).ok, false);
    });

    await test('long prefixes are truncated to 64 chars', async () => {
      const r = await fetch(`${BASE}/api/addresses`, {
        method: 'POST', headers,
        body: JSON.stringify({ prefix: 'a'.repeat(100) }),
      });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.address.split('@')[0].length, 64);
    });

    await test('inbox pagination honors limit and offset', async () => {
      const pr = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'paged' }) });
      const paged = (await pr.json()).address;
      for (let i = 0; i < 3; i++) {
        await smtpSend({ to: paged, from: 's@x.com', subject: `Mail ${i}`, body: 'hi' });
        await new Promise(r => setTimeout(r, 300));
      }
      const page1 = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(paged)}?limit=2&offset=0`, { headers })).json();
      assert.equal(page1.count, 2);
      assert.equal(page1.total, 3);
      assert.equal(page1.emails[0].subject, 'Mail 2', 'newest first');
      const page2 = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(paged)}?limit=2&offset=2`, { headers })).json();
      assert.equal(page2.count, 1);
      assert.equal(page2.emails[0].subject, 'Mail 0');
      assert.ok(typeof page1.emails[0].attachments === 'number', 'list view carries attachment count');
    });

    await test('verify-link wait returns immediately when mail exists', async () => {
      // (the earlier inbox was cleared, so send fresh mail first)
      await smtpSend({
        to: address, from: 'verify@provider.example.com', subject: 'Confirm',
        body: `go here: ${verifyUrl}`,
      });
      await new Promise(r => setTimeout(r, 500));
      const w = await (await fetch(`${BASE}/api/verify-link/${encodeURIComponent(address)}/wait?from=provider.example.com&timeoutMs=5000`, { headers })).json();
      assert.equal(w.ok, true);
      assert.equal(w.url, verifyUrl);
      assert.ok(w.waitedMs < 5000);
    });

    await test('verify-link wait times out on an empty inbox', async () => {
      const pr = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'empty-wait' }) });
      const emptyAddr = (await pr.json()).address;
      const start = Date.now();
      const w = await (await fetch(`${BASE}/api/verify-link/${encodeURIComponent(emptyAddr)}/wait?timeoutMs=1200`, { headers })).json();
      assert.equal(w.ok, false);
      assert.ok(Date.now() - start >= 1000, 'waited at least ~1s');
    });

    await test('health reports retention, dead letters and retry queue', async () => {
      const j = await (await fetch(`${BASE}/health`)).json();
      assert.equal(j.retentionDays, 7);
      assert.equal(j.deadLetters, 0);
      assert.equal(j.retryQueue, 0);
    });

    await test('dead-letters endpoint is empty in a healthy run', async () => {
      const j = await (await fetch(`${BASE}/api/dead-letters`, { headers })).json();
      assert.equal(j.ok, true);
      assert.equal(j.count, 0);
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
  }

  // --- rate limiting: separate server with a tiny budget ---
  await test('address creation is rate-limited', async () => {
    const P2 = 3311, S2 = 2527;
    const child2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(P2), SMTP_PORT: String(S2), AGENT_MAIL_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN, RATE_LIMIT_PER_MINUTE: '2' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const base2 = `http://127.0.0.1:${P2}`;
      const start = Date.now();
      while (Date.now() - start < 15000) {
        try { const r = await fetch(`${base2}/health`); if (r.ok) break; } catch { /* not up */ }
        await new Promise(r => setTimeout(r, 200));
      }
      const mk = () => fetch(`${base2}/api/addresses`, { method: 'POST', headers, body: '{}' });
      assert.equal((await mk()).status, 200);
      assert.equal((await mk()).status, 200);
      assert.equal((await mk()).status, 429, 'third request within the minute must be rejected');
    } finally {
      child2.kill('SIGKILL');
      await new Promise(r => setTimeout(r, 500));
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
})();
