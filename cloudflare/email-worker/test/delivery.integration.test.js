/**
 * Real delivery loop: Email Worker -> HTTP -> server /api/inbound.
 *
 * No mocked fetch. Starts the real server and a real webhook listener on
 * ephemeral ports, hands the Worker's email() handler a raw RFC 822 message,
 * and checks the message is retrievable from the recipient's inbox.
 *
 * Run: node cloudflare/email-worker/test/delivery.integration.test.js
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import worker from '../src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rootRequire = createRequire(path.join(ROOT, 'server.js'));
const { simpleParser } = rootRequire('mailparser');
const { extractCodes, extractLinks, rankLinks, scoreLink } = rootRequire('./server.js');

const TOKEN = 'integration-master-token';
const INBOUND_SECRET = 'integration-inbound-secret';
const DOMAIN = 'catchall.example.test';
const ADDRESS = `marcus.vance@${DOMAIN}`;
const MESSAGE_ID = '<verify-483921@acme.example>';
const VERIFY_LINK = 'https://acme.example/auth/confirm?token=abc123def456ghi789&next=%2Fhome';

const RAW = [
  'From: Acme Signup <no-reply@acme.example>',
  'To: team@acme.example',
  `Bcc: ${ADDRESS}`,
  'Subject: Confirm your Acme account',
  `Message-ID: ${MESSAGE_ID}`,
  'Date: Thu, 20 Nov 2026 02:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hi Marcus,',
  'Your verification code is 483921.',
  'Backup code: 123 456',
  'Use the button in this email if the link does not open.',
  '',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body>',
  '<p>Your verification code is <b>483921</b>.</p>',
  '<p>Backup code: 123 456</p>',
  `<p><a href="${VERIFY_LINK.replace('&', '&amp;')}">Confirm email</a></p>`,
  '<p><a href="https://acme.example/unsubscribe">Unsubscribe</a></p>',
  '<img src="https://acme.example/logo.png" alt="Acme">',
  '</body></html>',
  '',
  '--b1--',
  '',
].join('\r\n');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGKILL');
  await new Promise(resolve => {
    child.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n  ${String(err.stack || err.message).split('\n').slice(0, 4).join('\n  ')}`);
  }
}

const [apiPort, smtpPort, hookPort] = await Promise.all([freePort(), freePort(), freePort()]);
const BASE = `http://127.0.0.1:${apiPort}`;
const hookHits = [];
const hookServer = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    try { hookHits.push(JSON.parse(body)); } catch { hookHits.push({ raw: body }); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await listen(hookServer, hookPort);

const logs = [];
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(apiPort),
    SMTP_PORT: String(smtpPort),
    AGENT_MAIL_TOKEN: TOKEN,
    AGENT_MAIL_INBOUND_SECRET: INBOUND_SECRET,
    MAIL_DOMAIN: DOMAIN,
    SIGNUP_OPEN: '1',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_KEY: '',
    INCOMING_WEBHOOK_URL: '',
    SMTP_RELAY_HOST: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => logs.push(String(d)));
child.stderr.on('data', d => logs.push(String(d)));

const auth = { Authorization: `Bearer ${TOKEN}` };
const workerEnv = {
  INBOUND_URL: `${BASE}/api/inbound`,
  INBOUND_SECRET,
  AGENT_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/hook`,
};

function message() {
  return { raw: new Blob([RAW]).stream(), to: ADDRESS, from: 'no-reply@acme.example' };
}

// The Worker logs one line per delivery; keep test output clean.
async function deliver(env = workerEnv) {
  const log = console.log;
  console.log = () => {};
  try {
    await worker.email(message(), env);
  } finally {
    console.log = log;
  }
}

const guard = setTimeout(() => {
  console.error('FAIL - integration test timed out');
  child.kill('SIGKILL');
  process.exit(1);
}, 45000);

try {
  let healthy = false;
  for (let i = 0; i < 100 && !healthy; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      healthy = res.ok;
    } catch { /* not up yet */ }
    if (!healthy) await sleep(150);
  }
  if (!healthy) throw new Error(`server did not start:\n${logs.join('')}`);

  await test('worker delivers a real MIME email over HTTP into the inbox', async () => {
    await deliver();
    const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(ADDRESS)}`, { headers: auth })).json();
    assert.equal(list.total, 1, 'exactly one message stored');

    const item = list.emails[0];
    assert.equal(item.subject, 'Confirm your Acme account');
    assert.ok(item.codes.includes('483921'), `labelled code stored (${item.codes})`);
    assert.ok(item.codes.includes('123456'), `spaced code stored (${item.codes})`);

    const full = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(ADDRESS)}/${item.id}`, { headers: auth })).json();
    const email = full.email;
    assert.match(email.text, /Your verification code is 483921/);
    assert.match(email.text, /Backup code: 123 456/);
    assert.match(email.from, /no-reply@acme\.example/);
    // The verify URL exists only inside the HTML href, so its presence proves
    // the HTML part crossed the wire (and the &amp; was decoded).
    assert.ok(email.links.includes(VERIFY_LINK), `HTML link stored (${email.links})`);
    assert.equal(email.bestLinks[0], VERIFY_LINK);
    assert.ok(!email.bestLinks.includes('https://acme.example/logo.png'), 'logo junk never chosen');
  });

  await test('agent webhook receives the extracted code and link', async () => {
    assert.equal(hookHits.length, 1, 'one webhook delivery');
    const hit = hookHits[0];
    assert.equal(hit.to, ADDRESS);
    assert.equal(hit.messageId, MESSAGE_ID);
    assert.equal(hit.code, '483921');
    assert.equal(hit.link, VERIFY_LINK);
    assert.equal(hit.subject, 'Confirm your Acme account');
  });

  await test('worker code/link match the server extractors for the same raw email', async () => {
    const parsed = await simpleParser(RAW);
    const text = parsed.text || '';
    const subject = parsed.subject || '';
    const serverCode = extractCodes(subject, text)[0] || null;
    const serverLinks = rankLinks(extractLinks(`${subject}\n${text}`, parsed.html || ''));
    const serverLink = serverLinks.find(u => scoreLink(u) > -10) || null;
    assert.equal(hookHits[0].code, serverCode, 'code parity');
    assert.equal(hookHits[0].link, serverLink, 'link parity');
  });

  await test('inbound rejects unauthenticated and wrong-secret requests', async () => {
    const body = JSON.stringify({ to: ADDRESS, subject: 'x', text: 'x' });
    const noAuth = await fetch(`${BASE}/api/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(`${BASE}/api/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-secret' },
      body,
    });
    assert.equal(wrong.status, 401);
  });

  await test('a retried delivery with the same Message-ID is stored once', async () => {
    await deliver();
    const list = await (await fetch(`${BASE}/api/inbox/${encodeURIComponent(ADDRESS)}`, { headers: auth })).json();
    assert.equal(list.total, 1, 'duplicate not stored twice');
  });

  await test('worker throws when the backend is unreachable (so Cloudflare retries)', async () => {
    const closed = await freePort();
    await assert.rejects(
      () => deliver({ INBOUND_URL: `http://127.0.0.1:${closed}/api/inbound`, INBOUND_SECRET }),
      /fetch failed|ECONNREFUSED|inbound/i,
    );
  });
} finally {
  clearTimeout(guard);
  await stopChild(child);
  await new Promise(resolve => hookServer.close(resolve));
}

if (failures) {
  console.error(`${failures} delivery integration test(s) failed`);
  process.exit(1);
}
console.log('delivery integration tests passed');
