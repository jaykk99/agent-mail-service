'use strict';

// E2E: GET /api/relay (live SMTP EHLO probe, sends no mail) and
// GET /api/quota + GET /api/quota/:address (reporting over real counters).

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// Minimal fake SMTP: 220 banner, multi-line 250 to EHLO, 221 to QUIT.
// Accepts no mail commands beyond the probe handshake.
function startFakeSmtp() {
  const seen = [];
  const srv = net.createServer(sock => {
    sock.on('error', () => {});
    sock.write('220 127.0.0.1 fake-relay\r\n');
    let buf = '';
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        seen.push(cmd);
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake-relay\r\n250 8BITMIME\r\n');
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

async function stop(child) {
  child.kill('SIGTERM');
  await new Promise(r => { child.once('exit', r); setTimeout(r, 2000); });
}

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

(async () => {
  const [apiPort, smtpPort, apiPort2, smtpPort2] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const fake = await startFakeSmtp();

  // Server 1: local Postfix path -> relay probe handshakes with the fake relay.
  const child = startServer({
    PORT: String(apiPort),
    SMTP_PORT: String(smtpPort),
    DATA_DIR: ':memory:',
    MAIL_DOMAIN: 'agents.local',
    LOCAL_POSTFIX_HOST: '127.0.0.1',
    LOCAL_POSTFIX_PORT: String(fake.port),
    RELAY_PROBE_TIMEOUT_MS: '5000',
  });
  const BASE = `http://127.0.0.1:${apiPort}`;
  try {
    await waitReady(BASE);

    await test('GET /api/relay reports usable via live EHLO probe, sends no mail', async () => {
      const r = await fetch(`${BASE}/api/relay`);
      const body = await r.json();
      assert.equal(r.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.provider, 'linux-postfix');
      assert.equal(body.status, 'usable');
      assert.match(body.detail, /EHLO ok/);
      assert.ok(body.checkedAt);
      // Probe handshake only: EHLO + QUIT, never MAIL/RCPT/DATA.
      assert.ok(fake.seen.includes('EHLO'));
      assert.ok(fake.seen.includes('QUIT'));
      assert.ok(!fake.seen.includes('MAIL'));
      assert.ok(!fake.seen.includes('RCPT'));
      assert.ok(!fake.seen.includes('DATA'));
    });

    await test('GET /api/quota counts real sends, receives and creations', async () => {
      const send = await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'agent-0001@agents.local',
          to: 'agent-0002@agents.local',
          subject: 'Quota count',
          text: 'count me',
        }),
      });
      assert.equal(send.status, 200);

      const one = await fetch(`${BASE}/api/quota/agent-0001@agents.local`);
      const q1 = await one.json();
      assert.equal(one.status, 200);
      assert.equal(q1.ok, true);
      assert.equal(q1.sends.last24h.used, 1);
      assert.equal(q1.sends.hourly.used, 1);
      assert.equal(q1.sends.last24h.limit, 0);
      assert.equal(q1.sends.last24h.remaining, null);

      const two = await fetch(`${BASE}/api/quota/agent-0002@agents.local`);
      const q2 = await two.json();
      assert.equal(two.status, 200);
      assert.equal(q2.receives.last24h.used, 1);
      assert.equal(q2.receives.stored, 1);

      const created = await fetch(`${BASE}/api/addresses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'quota-probe', extension: '2000' }),
      });
      assert.equal(created.status, 200);

      const all = await fetch(`${BASE}/api/quota`);
      const summary = await all.json();
      assert.equal(all.status, 200);
      assert.equal(summary.global.sendsLast24h, 1);
      assert.equal(summary.global.receivesLast24h, 1);
      assert.equal(summary.global.addressCreationPerHour.used, 1);
      assert.equal(summary.countersResetOnRestart, true);
      assert.ok(summary.addresses.some(a => a.address === 'agent-0001@agents.local'));
      assert.ok(summary.addresses.some(a => a.address === 'agent-0002@agents.local'));
    });

    await test('GET /api/quota validates format (400) and unknown address (404)', async () => {
      const bad = await fetch(`${BASE}/api/quota/not-an-address`);
      assert.equal(bad.status, 400);
      const unknown = await fetch(`${BASE}/api/quota/nobody@agents.local`);
      assert.equal(unknown.status, 404);
    });
  } finally {
    await stop(child);
  }

  // Server 2: local-only mode (no Postfix, direct MX off) -> relay 503 unconfigured.
  const child2 = startServer({
    PORT: String(apiPort2),
    SMTP_PORT: String(smtpPort2),
    DATA_DIR: ':memory:',
    MAIL_DOMAIN: 'agents.local',
    DIRECT_MX_OUTBOUND: '0',
    RELAY_PROBE_TIMEOUT_MS: '5000',
  });
  const BASE2 = `http://127.0.0.1:${apiPort2}`;
  try {
    await waitReady(BASE2);
    await test('GET /api/relay reports unconfigured (503) in local-only mode', async () => {
      const r = await fetch(`${BASE2}/api/relay`);
      const body = await r.json();
      assert.equal(r.status, 503);
      assert.equal(body.ok, false);
      assert.equal(body.provider, 'local-only');
      assert.equal(body.status, 'unconfigured');
    });
  } finally {
    await stop(child2);
    await new Promise(r => fake.srv.close(r));
  }

  if (failures) process.exit(1);
  console.log('All relay/quota e2e tests passed');
})();
