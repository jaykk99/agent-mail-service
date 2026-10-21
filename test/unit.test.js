/**
 * Agent Mail Service — unit tests (no servers spawned).
 *
 * Requires ../server.js as a module, which must NOT bind ports on require.
 * Run: node test/unit.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const {
  extractLinks,
  extractAttachments,
  findVerifyLink,
  validAddressParam,
  backoffMs,
} = require('../server.js');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n  ${err.message}`);
  }
}

test('extractLinks trims trailing sentence punctuation', () => {
  const links = extractLinks('Click https://x.com/verify?token=abc. Done!');
  assert.deepEqual(links, ['https://x.com/verify?token=abc']);
});

test('extractLinks dedupes and skips non-urls', () => {
  const links = extractLinks('https://a.io/x https://a.io/x no link here');
  assert.deepEqual(links, ['https://a.io/x']);
});

test('extractLinks returns [] for empty text', () => {
  assert.deepEqual(extractLinks(''), []);
});

test('extractAttachments records metadata only', () => {
  const parsed = {
    attachments: [
      { filename: 'doc.pdf', contentType: 'application/pdf', content: Buffer.alloc(123) },
      { filename: null, contentType: null, size: 45 },
    ],
  };
  const out = extractAttachments(parsed);
  assert.deepEqual(out, [
    { filename: 'doc.pdf', contentType: 'application/pdf', size: 123 },
    { filename: 'unnamed', contentType: 'application/octet-stream', size: 45 },
  ]);
});

test('extractAttachments handles no attachments', () => {
  assert.deepEqual(extractAttachments({}), []);
});

test('findVerifyLink prefers verification-looking links', () => {
  const emails = [
    { id: 'e1', from: 'noreply@example.com', links: ['https://blog.example.com/post', 'https://app.example.com/verify?t=1'] },
  ];
  const found = findVerifyLink(emails, '');
  assert.equal(found.url, 'https://app.example.com/verify?t=1');
  assert.equal(found.emailId, 'e1');
});

test('findVerifyLink falls back to first link', () => {
  const emails = [{ id: 'e2', from: 'x@y.com', links: ['https://x.y/page'] }];
  assert.equal(findVerifyLink(emails, '').url, 'https://x.y/page');
});

test('findVerifyLink respects from filter (newest first)', () => {
  const emails = [
    { id: 'new', from: 'other@b.com', links: ['https://b.com/verify'] },
    { id: 'old', from: 'target@a.com', links: ['https://a.com/verify'] },
  ];
  assert.equal(findVerifyLink(emails, 'target@a.com').emailId, 'old');
  assert.equal(findVerifyLink(emails, 'nobody'), null);
});

test('findVerifyLink returns null when no links', () => {
  assert.equal(findVerifyLink([{ id: 'e', from: 'x', links: [] }], ''), null);
  assert.equal(findVerifyLink([], ''), null);
});

test('validAddressParam accepts normal addresses', () => {
  assert.equal(validAddressParam('signup-1@mail.example.test'), true);
  assert.equal(validAddressParam('a.b_c+d@sub.domain.co'), true);
});

test('validAddressParam rejects malformed input', () => {
  assert.equal(validAddressParam(''), false);
  assert.equal(validAddressParam('no-at-sign'), false);
  assert.equal(validAddressParam('@domain.com'), false);
  assert.equal(validAddressParam('local@'), false);
  assert.equal(validAddressParam('a@b@c.com'), false);
  assert.equal(validAddressParam('x'.repeat(255) + '@d.com'), false);
  assert.equal(validAddressParam('bad chars@d.com'), false);
});

test('backoffMs grows exponentially and stays capped', () => {
  const b0 = backoffMs(0);
  const b1 = backoffMs(1);
  const b2 = backoffMs(2);
  const b9 = backoffMs(9);
  assert.ok(b0 >= 1000 && b0 <= 1250, `attempt 0: ${b0}`);
  assert.ok(b1 >= 2000 && b1 <= 2500, `attempt 1: ${b1}`);
  assert.ok(b2 >= 4000 && b2 <= 5000, `attempt 2: ${b2}`);
  assert.ok(b9 <= 75000, `capped: ${b9}`);
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log('All unit tests passed');
