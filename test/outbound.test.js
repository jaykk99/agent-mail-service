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

(async () => {
  const [apiPort, smtpPort, postfixPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const relayMail = [];

  const fakePostfix = net.createServer(sock => {
    sock.write('220 127.0.0.1 local-postfix\r\n');
    let buf = '', dataMode = false, data = '', mailFrom = '', rcpts = [];
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
            sock.write('250 OK\r\n');
          } else {
            data += line + '\n';
          }
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-local-postfix\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { mailFrom = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { rcpts.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { dataMode = true; data = ''; sock.write('354 End with .\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise(r => fakePostfix.listen(postfixPort, '127.0.0.1', r));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(apiPort),
      SMTP_PORT: String(smtpPort),
      DATA_DIR: ':memory:',
      MAIL_DOMAIN: 'agents.local',
      LOCAL_POSTFIX_HOST: '127.0.0.1',
      LOCAL_POSTFIX_PORT: String(postfixPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const BASE = `http://127.0.0.1:${apiPort}`;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) break;
      } catch { /* wait */ }
      await new Promise(r => setTimeout(r, 100));
    }

    const res = await fetch(`${BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'agent-0001@agents.local',
        to: 'external@example.org',
        subject: 'Self-hosted Linux Postfix outbound',
        text: 'Zero API keys!',
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.provider, 'linux-postfix');
    assert.equal(relayMail.length, 1);
    console.log('outbound tests passed');
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 2000); });
    await new Promise(r => fakePostfix.close(r));
  }
})();
