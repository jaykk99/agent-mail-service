/**
 * Outbound HTTP provider tests (Resend path, real HTTP).
 *
 * Spawns server.js with OUTBOUND_PROVIDER=resend pointed at a local fake
 * provider, then sends through POST /api/send and checks the exact wire
 * request, the returned message id, and 429/502 mapping. Nothing leaves the
 * box; no real provider key is used.
 *
 * Run: node test/outbound.test.js
 */
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');

const TOKEN = 'outbound-master-token';
const DOMAIN = 'outbound.example.test';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
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
  const [apiPort, smtpPort, providerPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const BASE = `http://127.0.0.1:${apiPort}`;
  const captured = [];

  const provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* keep raw */ }
      captured.push({ url: req.url, headers: req.headers, body: parsed });
      const to = Array.isArray(parsed.to) ? parsed.to[0] : '';
      res.setHeader('Content-Type', 'application/json');
      if (to === 'blocked@example.test') {
        res.statusCode = 429;
        return res.end(JSON.stringify({ message: 'daily quota exceeded' }));
      }
      if (to === 'fail@example.test') {
        res.statusCode = 500;
        return res.end(JSON.stringify({ message: 'provider exploded' }));
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ id: 're_test_123' }));
    });
  });
  await new Promise(r => provider.listen(providerPort, '127.0.0.1', r));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(apiPort),
      SMTP_PORT: String(smtpPort),
      AGENT_MAIL_TOKEN: TOKEN,
      MAIL_DOMAIN: DOMAIN,
      OUTBOUND_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_key',
      RESEND_API_BASE: `http://127.0.0.1:${providerPort}`,
      SEND_MAX_PER_DAY: '0',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        up = res.ok;
      } catch { /* starting */ }
      if (!up) await new Promise(r => setTimeout(r, 150));
    }
    if (!up) throw new Error(`server did not start:\n${logs.join('')}`);

    const health = await (await fetch(`${BASE}/health`)).json();
    assert.equal(health.outbound, 'resend');
    assert.equal(health.outboundConfigured, true);

    const created = await (await fetch(`${BASE}/api/addresses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ prefix: 'marcus.vance' }),
    })).json();
    const from = created.address;
    assert.equal(from, `marcus.vance@${DOMAIN}`);

    await test('POST /api/send sends through the Resend API with a display name', async () => {
      const res = await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          from,
          fromName: 'Marcus Vance',
          to: 'human@example.com',
          subject: 'Hello from Marcus',
          text: 'Hi there',
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.provider, 'resend');
      assert.equal(body.messageId, 're_test_123');
      assert.equal(body.fromName, 'Marcus Vance');

      assert.equal(captured.length, 1);
      const hit = captured[0];
      assert.equal(hit.url, '/emails');
      assert.equal(hit.headers.authorization, 'Bearer re_test_key');
      assert.equal(hit.body.from, `Marcus Vance <${from}>`);
      assert.deepEqual(hit.body.to, ['human@example.com']);
      assert.equal(hit.body.subject, 'Hello from Marcus');
      assert.equal(hit.body.text, 'Hi there');
    });

    await test('provider 429 is surfaced as 429 with Retry-After', async () => {
      const res = await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ from, to: 'blocked@example.test', subject: 'x', text: 'y' }),
      });
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('retry-after'), '3600');
      const body = await res.json();
      assert.match(body.error, /429|daily quota/i);
    });

    await test('other provider failures are surfaced as 502', async () => {
      const res = await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ from, to: 'fail@example.test', subject: 'x', text: 'y' }),
      });
      assert.equal(res.status, 502);
    });

    await test('foreign From is still rejected before any provider call', async () => {
      const before = captured.length;
      const res = await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ from: 'stranger@elsewhere.example', to: 'human@example.com', subject: 'x', text: 'y' }),
      });
      assert.equal(res.status, 403);
      assert.equal(captured.length, before);
    });
  } finally {
    child.kill('SIGKILL');
    await new Promise(r => {
      child.once('exit', r);
      setTimeout(r, 3000);
    });
    await new Promise(r => provider.close(r));
  }

  if (failures) {
    console.error(`${failures} outbound test(s) failed`);
    process.exit(1);
  }
  console.log('outbound tests passed');
})();
