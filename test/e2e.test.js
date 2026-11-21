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
 *   - inbox pagination (page/per_page) + subject/from/body search
 *   - GET /api/addresses registry listing (counts, created/last-seen)
 *   - attachment metadata in full email (content never stored or leaked)
 *   - HMAC-signed incoming-mail webhook delivery + signature verification
 *   - local /dashboard HTML UI (unauthenticated page, token client-side only)
 *   - address TTL auto-cleanup sweep on a short-TTL server
 *   - address-creation 429 + per-address SMTP receive rate limits
 *   - per-address quota reporting (GET /api/quota, GET /api/quota/:address)
 *   - (merged from origin) invalid address param 400, prefix truncation to 64
 *   - (merged from origin) inbox pagination via limit/offset
 *   - (merged from origin) verify-link long-poll /wait (immediate + timeout)
 *   - (merged from origin) dead-letters endpoint + retention health fields
 *   - (merged from origin) per-minute address-creation rate limit server
 *
 * Local-only: never touches Supabase, the network, or real mail.
 * The webhook test uses a loopback HTTP listener; nothing leaves the box.
 * Run: npm test
 */
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const PORT = 3310;
const SMTP_PORT = 2526;
const TOKEN = 'test-token-abc123';
const DOMAIN = 'mail.example.test';
const INBOUND_SECRET = 'test-inbound-secret-xyz';
const BASE = `http://127.0.0.1:${PORT}`;

// Throwaway DKIM key: the server under test signs outbound mail with it, and
// /api/dns must publish the matching public key.
const DKIM_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' });

// Incoming-mail webhook listener: collects deliveries with raw bodies so
// tests can verify the HMAC-SHA256 signature and payload shape.
const WH_PORT = 3399;
const WH_SECRET = 'hook-secret-for-tests';
const webhookHits = [];
const whServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    webhookHits.push({ headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});

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

// Fake outbound SMTP relay: speaks just enough SMTP for nodemailer
// (EHLO, MAIL FROM, RCPT TO, DATA, QUIT; no STARTTLS, no AUTH) and records
// every message the server under test sends through it. Nothing leaves
// the box.
const RELAY_PORT = 2532;
const relayMail = [];
const relayServer = net.createServer(sock => {
  sock.write('220 127.0.0.1 fake-relay\r\n');
  let buf = '';
  let dataMode = false;
  let data = '';
  let mailFrom = '';
  let rcpts = [];
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (dataMode) {
        if (line === '.') {
          dataMode = false;
          relayMail.push({ from: mailFrom, to: rcpts.slice(), data });
          sock.write('250 OK: queued\r\n');
        } else {
          data += line + '\n';
        }
        continue;
      }
      const space = line.indexOf(' ');
      const cmd = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const arg = space === -1 ? '' : line.slice(space + 1);
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake-relay\r\n250 8BITMIME\r\n');
      else if (cmd === 'MAIL') { mailFrom = (arg.match(/<([^>]*)>/) || [])[1] || arg; sock.write('250 OK\r\n'); }
      else if (cmd === 'RCPT') { rcpts.push((arg.match(/<([^>]*)>/) || [])[1] || arg); sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { dataMode = true; data = ''; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (cmd === 'RSET') { mailFrom = ''; rcpts = []; sock.write('250 OK\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
      else sock.write('250 OK\r\n');
    }
  });
});

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

function smtpSend({ to, from, subject, body, raw }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: SMTP_PORT });
    sock.setEncoding('utf8');
    let buf = '';
    let step = 0; // 0=greet, 1=HELO ack, 2=MAIL ack, 3=RCPT ack, 4=DATA ack, 5=body ack
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('SMTP timed out at step ' + step)); }, 8000);
    const dataContent = raw || `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}`;
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
          sock.write(`${dataContent}\r\n.\r\n`);
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
  await new Promise(r => whServer.listen(WH_PORT, '127.0.0.1', r));
  await new Promise(r => relayServer.listen(RELAY_PORT, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), SMTP_PORT: String(SMTP_PORT),
      AGENT_MAIL_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN,
      AGENT_MAIL_INBOUND_SECRET: INBOUND_SECRET,
      INCOMING_WEBHOOK_URL: `http://127.0.0.1:${WH_PORT}/hook`,
      INCOMING_WEBHOOK_SECRET: WH_SECRET,
      SMTP_RELAY_HOST: '127.0.0.1',
      SMTP_RELAY_PORT: String(RELAY_PORT),
      SIGNUP_PER_IP_PER_HOUR: '50',
      DKIM_PRIVATE_KEY: DKIM_KEY,
      DKIM_SELECTOR: 'mail',
      DKIM_DOMAIN: DOMAIN,
    },
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

    // --- Free self-serve accounts: one isolated key per agent ---
    let accountAKey, accountBKey;
    await test('free signup mints one API key per agent', async () => {
      const mk = name => fetch(`${BASE}/api/accounts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(r => r.json().then(j => ({ status: r.status, ...j })));
      const a = await mk('agent-a');
      const b = await mk('agent-b');
      assert.equal(a.status, 201, JSON.stringify(a));
      assert.ok(a.apiKey.startsWith('am_'), `key: ${a.apiKey}`);
      assert.equal(a.account.name, 'agent-a');
      assert.equal(a.account.plan, 'free');
      assert.ok(a.account.addressQuota > 0);
      assert.notEqual(a.apiKey, b.apiKey);
      accountAKey = a.apiKey;
      accountBKey = b.apiKey;

      const me = await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${accountAKey}` } })).json();
      assert.equal(me.ok, true);
      assert.equal(me.role, 'account');
      assert.equal(me.usage.addresses, 0);
    });

    await test('account keys cannot see or send from another account address', async () => {
      const aHeaders = { Authorization: `Bearer ${accountAKey}`, 'Content-Type': 'application/json' };
      const bHeaders = { Authorization: `Bearer ${accountBKey}`, 'Content-Type': 'application/json' };
      const created = await (await fetch(`${BASE}/api/addresses`, {
        method: 'POST', headers: aHeaders, body: JSON.stringify({ prefix: 'acct-a' }),
      })).json();
      assert.equal(created.address, `acct-a@${DOMAIN}`);

      const foreign = await fetch(`${BASE}/api/inbox/${encodeURIComponent(created.address)}`, { headers: bHeaders });
      assert.equal(foreign.status, 404, 'a foreign inbox must not be readable');
      const waiting = await fetch(`${BASE}/api/wait/${encodeURIComponent(created.address)}?timeoutMs=1000`, { headers: bHeaders });
      assert.equal(waiting.status, 404);

      const steal = await fetch(`${BASE}/api/send`, {
        method: 'POST', headers: bHeaders,
        body: JSON.stringify({ from: created.address, to: 'x@example.com', subject: 's', text: 't' }),
      });
      assert.equal(steal.status, 403, 'sending From a foreign address is rejected');

      const claim = await fetch(`${BASE}/api/addresses`, {
        method: 'POST', headers: bHeaders, body: JSON.stringify({ prefix: 'acct-a' }),
      });
      assert.equal(claim.status, 409, 'a claimed address cannot be taken over');

      const other = await (await fetch(`${BASE}/api/addresses`, { headers: bHeaders })).json();
      assert.equal(other.count, 0, 'account B sees none of account A addresses');
      const own = await (await fetch(`${BASE}/api/addresses`, { headers: aHeaders })).json();
      assert.deepEqual(own.addresses.map(x => x.address), [created.address]);
    });

    await test('an account receives and reads its own real SMTP mail', async () => {
      const aHeaders = { Authorization: `Bearer ${accountAKey}` };
      const addr = `acct-a@${DOMAIN}`;
      await smtpSend({
        to: addr, from: 'verify@provider.example.com', subject: 'Your Acme code',
        body: 'Your verification code is 450199.\nhttps://provider.example.com/verify?token=acct',
      });
      await new Promise(r => setTimeout(r, 600));
      const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(addr)}`, { headers: aHeaders })).json();
      assert.equal(list.total, 1, JSON.stringify(list));
      assert.deepEqual(list.emails[0].codes, ['450199']);
      const code = await (await fetch(`${BASE}/api/code/${encodeURIComponent(addr)}`, { headers: aHeaders })).json();
      assert.equal(code.code, '450199');
    });

    await test('account listing is admin-only and never exposes keys', async () => {
      const denied = await fetch(`${BASE}/api/accounts`, { headers: { Authorization: `Bearer ${accountAKey}` } });
      assert.equal(denied.status, 403);
      const anon = await fetch(`${BASE}/api/accounts`);
      assert.equal(anon.status, 401);
      const all = await (await fetch(`${BASE}/api/accounts`, { headers })).json();
      assert.equal(all.ok, true);
      assert.ok(all.count >= 2, `accounts listed: ${all.count}`);
      assert.ok(all.accounts.every(a => !('apiKey' in a) && !('apiKeyHash' in a)), 'keys are never listed');
    });

    await test('GET /api/dns advertises MX, SPF, DKIM and DMARC records', async () => {
      const r = await fetch(`${BASE}/api/dns`);
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.ok(j.records.some(x => x.type === 'MX' && x.value === DOMAIN), 'MX record');
      assert.ok(j.records.some(x => x.type === 'TXT' && x.value === 'v=spf1 a mx ~all'), 'SPF record');
      assert.ok(j.records.some(x => x.name === `_dmarc.${DOMAIN}` && x.value.startsWith('v=DMARC1')), 'DMARC record');
      const dkim = j.records.find(x => x.name === `mail._domainkey.${DOMAIN}`);
      assert.ok(dkim, 'DKIM record present');
      const p = /p=([A-Za-z0-9+/=]+)/.exec(dkim.value)[1];
      const pub = crypto.createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
      assert.equal(pub.asymmetricKeyType, 'rsa');
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

    // --- Outbound send via the fake relay ---
    await test('POST /api/send delivers through the relay from a created address', async () => {
      relayMail.length = 0;
      const r = await fetch(`${BASE}/api/send`, {
        method: 'POST', headers,
        body: JSON.stringify({ from: address, to: 'dest@example.com', subject: 'Hello from the agent', text: 'sent body here', html: '<p>sent body here</p>' }),
      });
      const j = await r.json();
      assert.equal(r.status, 200, JSON.stringify(j));
      assert.equal(j.ok, true);
      assert.ok(j.messageId, 'response carries a messageId');
      assert.equal(j.from, address);
      assert.deepEqual(j.to, ['dest@example.com']);
      // nodemailer acks only after the relay accepts DATA, so it is
      // already captured; poll briefly just in case.
      for (let i = 0; i < 10 && relayMail.length === 0; i++) await new Promise(r2 => setTimeout(r2, 100));
      assert.equal(relayMail.length, 1, 'relay received exactly one message');
      assert.equal(relayMail[0].from, address);
      assert.deepEqual(relayMail[0].to, ['dest@example.com']);
      assert.ok(relayMail[0].data.includes('Subject: Hello from the agent'), 'relay DATA carries the subject');
      assert.ok(relayMail[0].data.includes('sent body here'), 'relay DATA carries the body');
      assert.ok(relayMail[0].data.includes('DKIM-Signature:'), 'outbound mail is DKIM-signed');
      assert.ok(relayMail[0].data.includes(`d=${DOMAIN}`), 'DKIM signature names the domain');
    });

    await test('POST /api/send rejects a foreign From address', async () => {
      const r = await fetch(`${BASE}/api/send`, {
        method: 'POST', headers,
        body: JSON.stringify({ from: 'someone-else@example.com', to: 'dest@example.com', subject: 'x', text: 'y' }),
      });
      assert.equal(r.status, 403);
      assert.equal((await r.json()).ok, false);
    });

    await test('POST /api/send rejects malformed bodies', async () => {
      const bad = [
        { to: 'dest@example.com', text: 'no from' },
        { from: address, text: 'no to' },
        { from: address, to: 'dest@example.com' }, // no body
        { from: address, to: 'not-an-address', text: 'x' },
      ];
      for (const body of bad) {
        const r = await fetch(`${BASE}/api/send`, { method: 'POST', headers, body: JSON.stringify(body) });
        assert.equal(r.status, 400, JSON.stringify(body));
      }
    });

    await test('POST /api/send rejects unauthenticated requests', async () => {
      const r = await fetch(`${BASE}/api/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: address, to: 'dest@example.com', subject: 'x', text: 'y' }),
      });
      assert.equal(r.status, 401);
    });

    await test('GET /api/quota reports per-address buckets and creation quota', async () => {
      const r = await fetch(`${BASE}/api/quota`, { headers });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.role, 'master');
      const entry = j.addresses.find(a => a.address === address);
      assert.ok(entry, 'created address is listed');
      assert.equal(entry.sendPerHour.limit, 100);
      assert.equal(entry.sendPerHour.used, 1, 'the one relay send is counted');
      assert.equal(entry.sendPerHour.remaining, 99);
      assert.match(entry.sendPerHour.resetAt, /^\d{4}-\d{2}-\d{2}T/, 'resetAt is ISO');
      assert.equal(entry.receivePerHour.limit, 100);
      assert.equal(entry.receivePerHour.used, 0, 'no mail received yet');
      assert.equal(entry.receivePerHour.remaining, 100);
      assert.equal(entry.receivePerHour.resetAt, null);
      assert.equal(j.addressCreationPerHour.limit, 20);
      assert.ok(j.addressCreationPerHour.used >= 2, `two creations so far, got ${j.addressCreationPerHour.used}`);
      assert.equal(j.sendPerDay.limit, 0, 'daily cap disabled by default');
      assert.equal(j.sendPerDay.remaining, null);
      // Creating one more address bumps the creation bucket by exactly one.
      const before = j.addressCreationPerHour.used;
      const cr = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'quota-probe' }) });
      assert.equal(cr.status, 200);
      const after = await (await fetch(`${BASE}/api/quota`, { headers })).json();
      assert.equal(after.addressCreationPerHour.used, before + 1);
      assert.ok(after.addresses.some(a => a.address === 'quota-probe@mail.example.test'));
    });

    await test('GET /api/quota/:address returns one address and guards access', async () => {
      const r = await fetch(`${BASE}/api/quota/${encodeURIComponent(address)}`, { headers });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.address, address);
      assert.equal(j.sendPerHour.used, 1);
      assert.equal(j.receivePerHour.used, 0);
      const bad = await fetch(`${BASE}/api/quota/not-an-address`, { headers });
      assert.equal(bad.status, 400);
      const missing = await fetch(`${BASE}/api/quota/${encodeURIComponent('nobody@mail.example.test')}`, { headers });
      assert.equal(missing.status, 404);
      const anon = await fetch(`${BASE}/api/quota/${encodeURIComponent(address)}`);
      assert.equal(anon.status, 401);
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

    await test('SMTP rejects recipients outside MAIL_DOMAIN', async () => {
      await assert.rejects(
        smtpSend({ to: 'victim@elsewhere.test', from: 'a@b.co', subject: 'x', body: 'y' }),
        /timed out at step 3/,
      );
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

    await test('HTTP inbound rejects missing and wrong bearer', async () => {
      const payload = { to: `httpin@${DOMAIN}`, from: 'a@b.co', subject: 'x', text: 'y' };
      const noAuth = await fetch(`${BASE}/api/inbound`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(noAuth.status, 401);
      // The API token must NOT work when a dedicated inbound secret is set.
      const wrong = await fetch(`${BASE}/api/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(payload),
      });
      assert.equal(wrong.status, 401);
    });

    await test('HTTP inbound stores mail, fetchable via inbox + verify-link APIs', async () => {
      const to = `httpin@${DOMAIN}`;
      const r = await fetch(`${BASE}/api/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${INBOUND_SECRET}` },
        body: JSON.stringify({
          to, from: 'verify@provider.example.com', subject: 'Your code',
          text: 'Your code is 731204. Confirm: https://example.com/confirm?c=731204.',
          html: '<p>Your code is <b>731204</b></p>',
        }),
      });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.stored, true);
      assert.ok(j.id);
      const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(to)}`, { headers })).json();
      assert.equal(list.count, 1);
      assert.equal(list.emails[0].subject, 'Your code');
      const full = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(to)}/${j.id}`, { headers })).json();
      assert.ok(full.email.text.includes('731204'));
      assert.ok(full.email.links.includes('https://example.com/confirm?c=731204'));
      const vl = await (await fetch(`${BASE}/api/verify-link/${encodeURIComponent(to)}`, { headers })).json();
      assert.equal(vl.url, 'https://example.com/confirm?c=731204');
    });

    const inbound = (payload) => fetch(`${BASE}/api/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INBOUND_SECRET}` },
      body: JSON.stringify(payload),
    }).then(r => r.json());

    await test('code endpoint returns the one-time code; list items carry codes + preview', async () => {
      const to = `httpin@${DOMAIN}`;
      const c = await (await fetch(`${BASE}/api/code/${encodeURIComponent(to)}`, { headers })).json();
      assert.equal(c.ok, true);
      assert.equal(c.code, '731204');
      const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(to)}`, { headers })).json();
      assert.deepEqual(list.emails[0].codes, ['731204']);
      assert.ok(list.emails[0].preview.includes('Your code is'));
    });

    await test('HTML-only mail: link found in href with &amp; decoded, logo and unsubscribe never chosen', async () => {
      const to = `htmlonly@${DOMAIN}`;
      const j = await inbound({
        to, from: 'no-reply@app.example.com', subject: 'Confirm your email',
        html: '<html><head><style>a{color:red}</style></head><body><img src="https://cdn.example.com/logo.png">' +
          '<a href="https://cdn.example.com/logo.png">logo</a>' +
          '<p>Hi,</p><p>Tap the button to finish.</p>' +
          '<a href="https://app.example.com/auth/confirm?token=abc123&amp;next=%2Fhome">Confirm email</a>' +
          '<p><a href="https://app.example.com/unsubscribe?u=1">Unsubscribe</a></p></body></html>',
      });
      assert.equal(j.stored, true);
      const vl = await (await fetch(`${BASE}/api/verify-link/${encodeURIComponent(to)}`, { headers })).json();
      assert.equal(vl.url, 'https://app.example.com/auth/confirm?token=abc123&next=%2Fhome');
      const full = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(to)}/${j.id}`, { headers })).json();
      assert.equal(full.email.bestLinks[0], 'https://app.example.com/auth/confirm?token=abc123&next=%2Fhome');
      assert.ok(!full.email.text.includes('color:red'));
    });

    await test('a retried delivery with the same Message-ID is stored once', async () => {
      const to = `dedupe@${DOMAIN}`;
      const payload = { to, from: 'a@b.example.com', subject: 'Code 554433', text: 'Your code is 554433', messageId: '<m1@b.example.com>' };
      const first = await inbound(payload);
      const second = await inbound(payload);
      assert.equal(first.stored, true);
      assert.equal(second.duplicate, true);
      assert.equal(second.id, first.id);
      const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(to)}`, { headers })).json();
      assert.equal(list.total, 1);
    });

    await test('since ignores older mail; /api/wait wakes as soon as new mail lands', async () => {
      const to = `waiter@${DOMAIN}`;
      await inbound({ to, from: 'old@x.example.com', subject: 'Old code 111222', text: 'code 111222' });
      await new Promise(r => setTimeout(r, 20));
      const since = new Date().toISOString();
      const stale = await (await fetch(`${BASE}/api/code/${encodeURIComponent(to)}?since=${encodeURIComponent(since)}`, { headers })).json();
      assert.equal(stale.ok, false);
      const t0 = Date.now();
      const pending = fetch(`${BASE}/api/wait/${encodeURIComponent(to)}?timeoutMs=20000&since=${encodeURIComponent(since)}`, { headers }).then(r => r.json());
      await new Promise(r => setTimeout(r, 300));
      await inbound({ to, from: 'new@x.example.com', subject: 'Sign in', text: 'Your sign-in code:\n\n908 172\n\nOr open https://x.example.com/magic-link?t=zzz' });
      const got = await pending;
      assert.equal(got.ok, true);
      assert.equal(got.code, '908172');
      assert.equal(got.link, 'https://x.example.com/magic-link?t=zzz');
      assert.equal(got.email.subject, 'Sign in');
      assert.ok(Date.now() - t0 < 1500, `woke in ${Date.now() - t0}ms (should not wait for the 2s poll)`);
    });

    await test('code wait times out cleanly; bad since is a 400', async () => {
      const to = `nothing@${DOMAIN}`;
      const j = await (await fetch(`${BASE}/api/code/${encodeURIComponent(to)}/wait?timeoutMs=1000`, { headers })).json();
      assert.equal(j.ok, false);
      const bad = await fetch(`${BASE}/api/code/${encodeURIComponent(to)}/wait?since=yesterday`, { headers });
      assert.equal(bad.status, 400);
    });

    await test('HTTP inbound drops mail for other domains without error', async () => {
      const r = await fetch(`${BASE}/api/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${INBOUND_SECRET}` },
        body: JSON.stringify({ to: 'someone@elsewhere.test', from: 'a@b.co', subject: 'x', text: 'y' }),
      });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.stored, false);
    });

    await test('HTTP inbound html-only body falls back to stripped text', async () => {
      const to = `htmlonly@${DOMAIN}`;
      const r = await fetch(`${BASE}/api/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${INBOUND_SECRET}` },
        body: JSON.stringify({
          to, from: 'a@b.co', subject: 'HTML only',
          html: '<html><body><p>Reset here: <a href="https://example.com/reset?t=9">Reset</a></p></body></html>',
        }),
      });
      const j = await r.json();
      assert.equal(j.stored, true);
      const full = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(to)}/${j.id}`, { headers })).json();
      assert.ok(full.email.text.includes('Reset here'));
      assert.ok(!full.email.text.includes('<a href'));
      assert.ok(full.email.links.includes('https://example.com/reset?t=9'));
    });

    await test('delete clears the inbox', async () => {
      const del = await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}`, { method: 'DELETE', headers });
      assert.equal((await del.json()).ok, true);
      const j = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(address)}`, { headers })).json();
      assert.equal(j.count, 0);
    });

    // --- Merged from origin: validation hardening ---
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

    // --- Merged from origin: limit/offset pagination style ---
    // (Unified server supports BOTH this and page/per_page; list items carry
    // the attachment count under both `attachments` and `attachmentCount`.)
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
      assert.equal(page1.limit, 2);
      assert.equal(page1.offset, 0);
      assert.equal(page1.emails[0].subject, 'Mail 2', 'newest first');
      const page2 = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(paged)}?limit=2&offset=2`, { headers })).json();
      assert.equal(page2.count, 1);
      assert.equal(page2.emails[0].subject, 'Mail 0');
      assert.ok(typeof page1.emails[0].attachments === 'number', 'list view carries attachment count (attachments)');
      assert.ok(typeof page1.emails[0].attachmentCount === 'number', 'list view carries attachment count (attachmentCount)');
    });

    // --- Merged from origin: verify-link long-poll ---
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

    // --- Merged from origin: dead letters ---
    await test('dead-letters endpoint is empty in a healthy run', async () => {
      const r = await fetch(`${BASE}/api/dead-letters`, { headers });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.equal(j.count, 0);
    });

    // --- New: pagination + search ---
    let pageAddr;
    await test('pagination and search over inbox', async () => {
      const cr = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'pagetest' }) });
      pageAddr = (await cr.json()).address;
      const subjects = [
        'Order #1001 shipped', 'Order #1002 shipped', 'Password reset requested',
        'Order #1003 shipped', 'Weekly newsletter digest',
      ];
      for (const s of subjects) {
        await smtpSend({ to: pageAddr, from: 'shop@example.com', subject: s, body: `body for ${s}` });
      }
      await new Promise(r => setTimeout(r, 800));

      const p1 = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(pageAddr)}?per_page=2&page=1`, { headers })).json();
      assert.equal(p1.total, 5);
      assert.equal(p1.pages, 3);
      assert.equal(p1.page, 1);
      assert.equal(p1.perPage, 2);
      assert.equal(p1.count, 2);
      // newest first
      assert.equal(p1.emails[0].subject, 'Weekly newsletter digest');

      const p3 = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(pageAddr)}?per_page=2&page=3`, { headers })).json();
      assert.equal(p3.page, 3);
      assert.equal(p3.count, 1);

      const q = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(pageAddr)}?q=order`, { headers })).json();
      assert.equal(q.total, 3);
      assert.ok(q.emails.every(e => e.subject.toLowerCase().includes('order')));

      const qfrom = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(pageAddr)}?q=newsletter&from=shop`, { headers })).json();
      assert.equal(qfrom.total, 1);

      const capped = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(pageAddr)}?per_page=500`, { headers })).json();
      assert.ok(capped.perPage <= 100, `per_page not capped: ${capped.perPage}`);
    });

    // --- New: address registry listing ---
    await test('GET /api/addresses lists known addresses with counts', async () => {
      const r = await fetch(`${BASE}/api/addresses`, { headers });
      const j = await r.json();
      assert.equal(r.status, 200);
      assert.equal(j.ok, true);
      assert.ok(j.count >= 3, `expected >=3 addresses, got ${j.count}`);
      const found = j.addresses.find(a => a.address === pageAddr);
      assert.ok(found, 'pagetest address listed');
      assert.equal(found.emails, 5);
      assert.ok(found.createdAt && found.lastSeenAt);
    });

    await test('GET /api/addresses rejects unauthenticated', async () => {
      const r = await fetch(`${BASE}/api/addresses`);
      assert.equal(r.status, 401);
    });

    // --- New: attachment metadata ---
    let attachAddr;
    await test('attachment metadata stored, content never exposed', async () => {
      const cr = await fetch(`${BASE}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'attachtest' }) });
      attachAddr = (await cr.json()).address;
      const raw = [
        'From: files@example.com', `To: ${attachAddr}`, 'Subject: Here is the file',
        'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="BND"', '',
        '--BND', 'Content-Type: text/plain', '', 'See attached.', '--BND',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64', '',
        'aGVsbG8=', '--BND--', '',
      ].join('\r\n');
      await smtpSend({ to: attachAddr, from: 'files@example.com', subject: 'Here is the file', raw });
      await new Promise(r => setTimeout(r, 800));

      const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(attachAddr)}`, { headers })).json();
      assert.equal(list.total, 1);
      assert.equal(list.emails[0].attachmentCount, 1, 'list view shows attachment count');

      const full = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(attachAddr)}/${list.emails[0].id}`, { headers })).json();
      const at = full.email.attachments;
      assert.equal(at.length, 1);
      assert.equal(at[0].filename, 'invoice.pdf');
      assert.equal(at[0].contentType, 'application/pdf');
      assert.ok(at[0].size > 0, `size was ${at[0].size}`);
      assert.ok(!('content' in at[0]) && !('data' in at[0]), 'no attachment content leaked');
    });

    // --- New: HMAC-signed incoming webhook ---
    await test('incoming webhook fires with valid HMAC signature', async () => {
      webhookHits.length = 0;
      const marker = 'webhook-marker-' + Date.now();
      await smtpSend({ to: pageAddr, from: 'hooks@example.com', subject: marker, body: 'trigger the webhook' });
      let hit = null;
      for (let i = 0; i < 20 && !hit; i++) {
        await new Promise(r => setTimeout(r, 250));
        hit = webhookHits.find(h => {
          try { return JSON.parse(h.body).email.subject === marker; } catch { return false; }
        });
      }
      assert.ok(hit, 'webhook delivery not observed');
      assert.equal(hit.headers['x-agentmail-event'], 'mail.received');
      const sig = hit.headers['x-agentmail-signature'] || '';
      assert.ok(sig.startsWith('sha256='), `signature header missing/prefix: ${sig}`);
      const expected = 'sha256=' + crypto.createHmac('sha256', WH_SECRET).update(hit.body).digest('hex');
      assert.equal(sig, expected, 'HMAC signature mismatch');
      const payload = JSON.parse(hit.body);
      assert.equal(payload.event, 'mail.received');
      assert.equal(payload.address, pageAddr);
      assert.equal(payload.email.from.includes('hooks@example.com'), true);
    });

    // --- New: dashboard serves HTML ---
    await test('dashboard serves the local UI without auth', async () => {
      const r = await fetch(`${BASE}/dashboard`);
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(text.includes('Agent Mail Service'), 'dashboard HTML missing title');
      assert.ok(text.includes('sessionStorage'), 'dashboard should keep the token client-side only');
    });

    // --- New: health exposes new status fields (union of both sides) ---
    await test('health reports relay/webhook/ttl status', async () => {
      const j = await (await fetch(`${BASE}/health`)).json();
      assert.ok(['unconfigured', 'configured', 'misconfigured'].includes(j.relay), `relay: ${j.relay}`);
      assert.equal(j.webhook, 'configured');
      assert.equal(typeof j.addressTtlHours, 'number');
      // merged from origin
      assert.equal(j.retentionDays, 7);
      assert.equal(j.deadLetters, 0);
      assert.equal(j.retryQueue, 0);
    });

    // --- TTL sweep on a dedicated short-lived server ---
    await test('TTL sweep purges idle addresses', async () => {
      const tPort = 3312, tSmtp = 2528, tBase = `http://127.0.0.1:${tPort}`;
      const tc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
          ...process.env, PORT: String(tPort), SMTP_PORT: String(tSmtp),
          AGENT_MAIL_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN,
          ADDRESS_TTL_HOURS: '0.0002', ADDRESS_SWEEP_MS: '250',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        for (let i = 0; i < 40; i++) {
          try { const r = await fetch(`${tBase}/health`); if (r.ok) break; } catch { /* booting */ }
          await new Promise(r => setTimeout(r, 200));
        }
        const cr = await fetch(`${tBase}/api/addresses`, { method: 'POST', headers, body: JSON.stringify({ prefix: 'ttl1' }) });
        const ttlAddr = (await cr.json()).address;
        let before = await (await fetch(`${tBase}/api/addresses`, { headers })).json();
        assert.ok(before.addresses.some(a => a.address === ttlAddr), 'address present before sweep');
        await new Promise(r => setTimeout(r, 1500)); // TTL ~0.7s + sweep 250ms
        const after = await (await fetch(`${tBase}/api/addresses`, { headers })).json();
        assert.ok(!after.addresses.some(a => a.address === ttlAddr), 'idle address was swept');
        const inbox = await (await fetch(`${tBase}/api/inbox/${encodeURIComponent(ttlAddr)}`, { headers })).json();
        assert.equal(inbox.total, 0, 'swept address inbox is gone');
      } finally {
        tc.kill('SIGTERM');
      }
    });

    // --- Rate limits on a dedicated server ---
    await test('address-creation and per-address receive rate limits', async () => {
      const rPort = 3314, rSmtp = 2530, rBase = `http://127.0.0.1:${rPort}`;
      const rc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
          ...process.env, PORT: String(rPort), SMTP_PORT: String(rSmtp),
          AGENT_MAIL_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN,
          ADDRESS_CREATE_MAX_PER_HOUR: '2', EMAILS_PER_ADDRESS_PER_HOUR: '2',
          ADDRESS_QUOTA_PER_ACCOUNT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const rHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
      try {
        for (let i = 0; i < 40; i++) {
          try { const r = await fetch(`${rBase}/health`); if (r.ok) break; } catch { /* booting */ }
          await new Promise(r => setTimeout(r, 200));
        }
        const mk = p => fetch(`${rBase}/api/addresses`, { method: 'POST', headers: rHeaders, body: JSON.stringify({ prefix: p }) });
        assert.equal((await mk('rl1')).status, 200);
        assert.equal((await mk('rl2')).status, 200);
        const limited = await mk('rl3');
        assert.equal(limited.status, 429, '3rd creation should be rate limited');
        assert.ok(limited.headers.get('retry-after'), '429 carries Retry-After');

        // per-account standing address quota (ADDRESS_QUOTA_PER_ACCOUNT=1)
        const signupRes = await fetch(`${rBase}/api/accounts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'quota-agent' }),
        });
        assert.equal(signupRes.status, 201, 'signup works on a fresh server');
        const acctKey = (await signupRes.json()).apiKey;
        const ah = { Authorization: `Bearer ${acctKey}`, 'Content-Type': 'application/json' };
        const mkAcct = p => fetch(`${rBase}/api/addresses`, { method: 'POST', headers: ah, body: JSON.stringify({ prefix: p }) });
        assert.equal((await mkAcct('q1')).status, 200);
        const over = await mkAcct('q2');
        assert.equal(over.status, 403, 'second address exceeds the per-account quota');
        assert.equal((await over.json()).quota, 1);

        // per-address SMTP receive limit: 2 stored, 3rd dropped
        const rAddr = `rllimit@${DOMAIN}`;
        const sendRaw = (subject) => new Promise((resolve, reject) => {
          const sock = net.createConnection({ host: '127.0.0.1', port: rSmtp });
          sock.setEncoding('utf8');
          let buf = '', step = 0;
          const timer = setTimeout(() => { sock.destroy(); reject(new Error('SMTP timeout')); }, 8000);
          sock.on('data', d => {
            buf += d;
            while (buf.includes('\r\n')) {
              const i = buf.indexOf('\r\n');
              const line = buf.slice(0, i); buf = buf.slice(i + 2);
              if (step === 0 && /^220 /.test(line)) { sock.write('HELO t\r\n'); step = 1; }
              else if (step === 1 && /^250 /.test(line)) { sock.write('MAIL FROM:<a@b.c>\r\n'); step = 2; }
              else if (step === 2 && /^250 /.test(line)) { sock.write(`RCPT TO:<${rAddr}>\r\n`); step = 3; }
              else if (step === 3 && /^250 /.test(line)) { sock.write('DATA\r\n'); step = 4; }
              else if (step === 4 && /^354 /.test(line)) { sock.write(`From: a@b.c\r\nTo: ${rAddr}\r\nSubject: ${subject}\r\n\r\nx\r\n.\r\n`); step = 5; }
              else if (step === 5 && /^250 /.test(line)) { sock.write('QUIT\r\n'); sock.end(); clearTimeout(timer); resolve(); }
            }
          });
          sock.on('error', e => { clearTimeout(timer); reject(e); });
        });
        await sendRaw('rl-mail-1'); await sendRaw('rl-mail-2'); await sendRaw('rl-mail-3');
        await new Promise(r => setTimeout(r, 800));
        const inbox = await (await fetch(`${rBase}/api/inbox/${encodeURIComponent(rAddr)}`, { headers: rHeaders })).json();
        assert.equal(inbox.total, 2, `expected 2 stored, got ${inbox.total}`);
      } finally {
        rc.kill('SIGTERM');
      }
    });

    // --- Merged from origin: per-minute address-creation rate limit ---
    await test('address creation is rate-limited per minute (RATE_LIMIT_PER_MINUTE)', async () => {
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
  } finally {
    child.kill('SIGTERM');
    whServer.close();
    relayServer.close();
    await new Promise(r => setTimeout(r, 500));
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
})();
