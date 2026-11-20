/**
 * Real Node process check for the HTTP-only Render deployment.
 * Never contacts outside internet or public mailbox providers.
 */
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
}

async function isListening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(600);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function main() {
  const blueprint = readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  assert.match(blueprint, /buildCommand: npm ci --omit=dev/);
  assert.match(blueprint, /healthCheckPath: \/health/);
  assert.doesNotMatch(blueprint, /^\s+- key: PORT\s*$/m);
  assert.match(blueprint, /- key: SMTP_ENABLED\s+value: "0"/);
  console.log('PASS: Render controls PORT and SMTP is disabled in HTTP-only mode');

  const [apiPort, smtpPort] = await Promise.all([freePort(), freePort()]);
  assert.notEqual(apiPort, smtpPort);
  const env = {
    ...process.env,
    PORT: String(apiPort),
    SMTP_PORT: String(smtpPort),
    SMTP_ENABLED: '0',
    MAIL_DOMAIN: 'example.test',
    AGENT_MAIL_TOKEN: 'render-test-private-token-not-production',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_KEY: '',
    AGENT_MAIL_INBOUND_SECRET: 'testing-inbound-secret',
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', x => { logs += x; });
  child.stderr.on('data', x => { logs += x; });
  try {
    let response;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (child.exitCode !== null) throw new Error('Node service exited:\n' + logs);
      try {
        response = await fetch('http://127.0.0.1:' + apiPort + '/health');
        if (response.ok) break;
      } catch { /* process booting */ }
      await sleep(125);
    }
    assert.ok(response && response.ok, 'Node HTTP process never became healthy\n' + logs);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.storage, 'memory');
    assert.equal(health.durableStorage, false);
    assert.equal(health.smtpListenerEnabled, false);
    assert.equal(health.externalEmailVerified, false);
    const readinessResponse = await fetch('http://127.0.0.1:' + apiPort + '/ready');
    assert.equal(readinessResponse.status, 503, 'Ephemeral storage cannot pass readiness');
    const readiness = await readinessResponse.json();
    assert.equal(readiness.ok, false);
    assert.ok(readiness.issues.includes('persistent_storage_not_configured'));
    assert.equal(readiness.internetEmailDeliveryVerified, false);
    console.log('PASS: real Node HTTP startup and fail-closed persistence readiness');

    assert.equal(await isListening(smtpPort), false,
      'Render HTTP-only mode opened an SMTP listener');
    assert.match(logs, /listener disabled/);
    console.log('PASS: HTTP-only mode does not open a separate SMTP socket');

    const anonymous = await fetch('http://127.0.0.1:' + apiPort + '/api/me');
    assert.equal(anonymous.status, 401);
    console.log('PASS: unauthenticated account access denied');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(2500),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
