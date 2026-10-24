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
const BASE = `http://127.0.0.1:${PORT}`;

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
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), SMTP_PORT: String(SMTP_PORT),
      AGENT_MAIL_TOKEN: TOKEN, MAIL_DOMAIN: DOMAIN,
      INCOMING_WEBHOOK_URL: `http://127.0.0.1:${WH_PORT}/hook`,
      INCOMING_WEBHOOK_SECRET: WH_SECRET,
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

    // --- New: malformed recipient addresses are rejected, not registered ---
    // RFC 5322 allows a quoted-string local part containing characters like
    // ' " < > that would corrupt the dashboard's HTML/JS if registered and
    // rendered verbatim. The To: header inside DATA (not the RCPT TO
    // envelope) is what gets parsed and registered, so a sender fully
    // controls it — the server must filter on shape before trusting it.
    await test('malformed To: header addresses are not registered or stored', async () => {
      const before = await (await fetch(`${BASE}/api/addresses`, { headers })).json();
      const beforeCount = before.count;
      const raw = [
        'From: attacker@evil.test',
        `To: "bad'); alert(1); //"@evil.test`,
        'Subject: injection attempt', '', 'payload', '',
      ].join('\r\n');
      await smtpSend({ to: `${address}`, from: 'attacker@evil.test', subject: 'x', body: 'x', raw });
      await new Promise(r => setTimeout(r, 500));
      const after = await (await fetch(`${BASE}/api/addresses`, { headers })).json();
      assert.ok(!after.addresses.some(a => a.address.includes("'") || a.address.includes('<') || a.address.includes('"')),
        `a malformed address was registered: ${JSON.stringify(after.addresses.map(a => a.address))}`);
      assert.equal(after.count, beforeCount, 'malformed-To mail must not register a new address');
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
    await new Promise(r => setTimeout(r, 500));
  }

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
})();
