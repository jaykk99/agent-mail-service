'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function main() {
  const [apiPort, smtpPort] = await Promise.all([freePort(), freePort()]);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(apiPort),
      SMTP_PORT: String(smtpPort),
      SMTP_ENABLED: '0',
      DATA_DIR: ':memory:',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let response;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${apiPort}/health`);
        if (response.ok) break;
      } catch { /* booting */ }
      await sleep(100);
    }
    assert.ok(response && response.ok);
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.thirdPartyApis, false);
    assert.equal(health.apiKeysRequired, false);
    assert.equal(health.smtpListenerEnabled, false);
    assert.equal(await isListening(smtpPort), false);
    console.log('PASS: HTTP-only startup works with zero API keys');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(2000),
    ]);
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
