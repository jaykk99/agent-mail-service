'use strict';

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

function sendSmtp({ port, from, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    let stage = 0;
    let buf = '';
    const cmds = [
      'EHLO localhost',
      `MAIL FROM:<${from}>`,
      `RCPT TO:<${to}>`,
      'DATA',
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <msg-${Date.now()}@test>\r\n\r\n${body}\r\n.`,
      'QUIT',
    ];
    sock.on('error', reject);
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n')) return;
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        if (/^[45]/.test(line)) return reject(new Error('SMTP error: ' + line));
        if (/^\d{3}\s/.test(line)) {
          if (stage < cmds.length) sock.write(cmds[stage++] + '\r\n');
          else { sock.end(); resolve(); }
        }
      }
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
  const [apiPort, smtpPort] = await Promise.all([freePort(), freePort()]);
  const BASE = `http://127.0.0.1:${apiPort}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(apiPort),
      SMTP_PORT: String(smtpPort),
      DATA_DIR: ':memory:',
      MAIL_DOMAIN: 'agents.local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) break;
      } catch { /* wait */ }
      await new Promise(r => setTimeout(r, 100));
    }

    await test('health reports 1,000 plug-and-play agents with zero API keys', async () => {
      const r = await fetch(`${BASE}/health`);
      assert.equal(r.status, 200);
      const h = await r.json();
      assert.equal(h.ok, true);
      assert.equal(h.agents, 1000);
      assert.equal(h.thirdPartyApis, false);
      assert.equal(h.apiKeysRequired, false);
      assert.equal(h.domain, 'agents.local');
    });

    await test('root / serves plug-and-play dashboard HTML without login wall', async () => {
      const r = await fetch(`${BASE}/`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /Linux Agent Mail &amp; Phone/);
    });

    await test('GET /api/agents lists 1,000 mailboxes and extensions 2000..2999', async () => {
      const r = await fetch(`${BASE}/api/agents?page=1&per_page=10`);
      const d = await r.json();
      assert.equal(d.total, 1000);
      assert.equal(d.agents[0].extension, '2000');
      assert.equal(d.agents[0].email, 'agent-0001@agents.local');
    });

    await test('POST /api/domain switches free local domain cleanly', async () => {
      const r = await fetch(`${BASE}/api/domain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'home.lan' }),
      });
      const d = await r.json();
      assert.equal(d.domain, 'home.lan');
      const list = await (await fetch(`${BASE}/api/agents?q=2999`)).json();
      assert.equal(list.agents[0].email, 'agent-1000@home.lan');
    });

    await test('POST /api/addresses claims free custom email without API key or invite', async () => {
      const r = await fetch(`${BASE}/api/addresses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: 'support', extension: '2000' }),
      });
      const d = await r.json();
      assert.equal(d.ok, true);
      assert.equal(d.address, 'support@home.lan');
    });

    await test('SMTP inbound stores mail and extracts OTP code + verification link', async () => {
      await sendSmtp({
        port: smtpPort,
        from: 'noreply@test.lan',
        to: 'agent-0002@home.lan',
        subject: 'Verify your login',
        body: 'Code: 918273\nVerify: https://home.lan/verify?token=xyz',
      });
      const codeRes = await (await fetch(`${BASE}/api/code/agent-0002@home.lan`)).json();
      assert.equal(codeRes.ok, true);
      assert.equal(codeRes.code, '918273');
      const linkRes = await (await fetch(`${BASE}/api/verify-link/agent-0002@home.lan`)).json();
      assert.equal(linkRes.url, 'https://home.lan/verify?token=xyz');
    });

    await test('POST /api/send delivers locally between agents immediately', async () => {
      const r = await fetch(`${BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'agent-0001@home.lan',
          to: 'agent-0003@home.lan',
          subject: 'Direct test',
          text: 'Hello agent 3',
        }),
      });
      const d = await r.json();
      assert.equal(d.ok, true);
      assert.equal(d.provider, 'local-selfhosted');
      const inbox = await (await fetch(`${BASE}/api/inbox/agent-0003@home.lan`)).json();
      assert.equal(inbox.total, 1);
    });

    await test('Phone SMS, SIM bridge, WebRTC signaling, and guest call links work', async () => {
      const sms = await fetch(`${BASE}/api/phone/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '2000', to: '2001', text: 'Hey 2001' }),
      });
      assert.equal(sms.status, 201);

      const sim = await fetch(`${BASE}/api/phone/inbound-sim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: '2001', from: '+15551234567', text: 'Real SIM SMS' }),
      });
      assert.equal(sim.status, 201);

      const inbox = await (await fetch(`${BASE}/api/phone/messages?extension=2001`)).json();
      assert.equal(inbox.events.length, 2);

      const sig = await fetch(`${BASE}/api/phone/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: '2000', to: '2001', type: 'offer', value: { type: 'offer', sdp: 'v=0' } }),
      });
      assert.equal(sig.status, 201);

      const invite = await (await fetch(`${BASE}/api/webphone/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extension: '2000', ttlMinutes: 15 }),
      })).json();
      assert.equal(invite.webNumber, 'web:2000');

      const sess = await (await fetch(`${BASE}/api/webphone/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invite: invite.token }),
      })).json();
      assert.ok(sess.token);
    });

    await test('GET /api/linux/status returns Asterisk, USB SIM, and Postfix configs', async () => {
      const r = await (await fetch(`${BASE}/api/linux/status`)).json();
      assert.equal(r.ok, true);
      assert.ok(r.files['pjsip_agents.conf'].includes('[2999]'));
      assert.ok(r.files['dongle.conf'].includes('[dongle0]'));
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 2000); });
  }

  if (failures) process.exit(1);
  console.log('All e2e tests passed');
})();
