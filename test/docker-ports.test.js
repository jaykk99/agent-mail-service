'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Docker Compose publishes SMTP and HTTP only on host loopback', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  const portsBlock = compose.match(/^    ports:\s*\n((?:\s{6}-[^\n]*\n)+)/m);
  assert.ok(portsBlock, 'expected mail service ports block');
  const entries = [...portsBlock[1].matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)]
    .map(match => match[1].trim());
  assert.equal(entries.length, 2, 'unexpected new published port');
  assert.deepEqual(entries.sort(), ['127.0.0.1:25:2525', '127.0.0.1:3000:3000'].sort());
});
