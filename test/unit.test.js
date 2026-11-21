/**
 * Agent Mail Service — unit tests (no servers spawned).
 *
 * Requires ../server.js as a module, which must NOT bind ports on require.
 * Run: node test/unit.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const {
  htmlToText,
  extractLinks,
  extractAttachments,
  findVerifyLink,
  validAddressParam,
  backoffMs,
  extractCodes,
  rankLinks,
  decodeEntities,
  validateSendBody,
  buildOutboundRequest,
  sendAgentMail,
  setSendTransport,
  registerAddress,
  newApiKey,
  hashApiKey,
  newAccountRow,
  dkimPublicKeyRecord,
  rateBucketUsage,
  windowBucketUsage,
  quotaForAddress,
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

test('htmlToText strips tags, styles and scripts, decodes entities', () => {
  const html = '<style>.a{color:red}</style><p>Hello&nbsp;<b>World</b> &amp; friends</p><script>alert(1)</script>';
  assert.equal(htmlToText(html), 'Hello World & friends');
});

test('htmlToText handles empty input', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(undefined), '');
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

test('extractLinks mines href values and decodes entities', () => {
  const links = extractLinks('See https://a.io/plain', '<a href="https://a.io/v?x=1&amp;y=2">Verify</a> <a href=\'mailto:x@y.z\'>mail</a>');
  assert.deepEqual(links, ['https://a.io/v?x=1&y=2', 'https://a.io/plain']);
});

test('rankLinks puts the action link first and junk last', () => {
  const ranked = rankLinks([
    'https://cdn.x.com/logo.png',
    'https://x.com/',
    'https://twitter.com/x',
    'https://x.com/unsubscribe?id=1',
    'https://x.com/account/verify-email/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
  ]);
  assert.equal(ranked[0], 'https://x.com/account/verify-email/9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c');
  assert.ok(ranked.indexOf('https://x.com/') < ranked.indexOf('https://cdn.x.com/logo.png'));
});

test('findVerifyLink skips an email whose only links are junk', () => {
  const emails = [
    { id: 'promo', from: 'a@b.c', links: ['https://b.c/logo.png', 'https://b.c/unsubscribe'] },
    { id: 'real', from: 'a@b.c', links: ['https://b.c/confirm?t=1'] },
  ];
  assert.equal(findVerifyLink(emails, '').emailId, 'real');
});

test('extractCodes: plain, spaced, next-line, alphanumeric', () => {
  assert.deepEqual(extractCodes('Your code', 'Your verification code is 483921.'), ['483921']);
  assert.deepEqual(extractCodes('', 'Use code 123 456 to sign in'), ['123456']);
  assert.deepEqual(extractCodes('Verify your email', 'Enter this code:\n\n774 019\n\nIt expires in 10 minutes.'), ['774019']);
  assert.deepEqual(extractCodes('', 'Your one-time passcode: K7Q2M9'), ['K7Q2M9']);
  assert.deepEqual(extractCodes('482913 is your Acme code', ''), ['482913']);
});

test('extractCodes ignores phones, years, prices and URLs', () => {
  assert.deepEqual(extractCodes('Welcome', 'Call 204-972-0325 or +1 204 972 0325. Copyright 2026. Total $1299.00. https://x.com/o/12345678'), []);
  assert.deepEqual(extractCodes('', 'Verification code 5501. Sent in 2026 to 204-972-0325.'), ['5501']);
});

test('decodeEntities handles numeric and named entities', () => {
  assert.equal(decodeEntities('a&amp;b &#39;x&#x27; &lt;y&gt; &quot;z&quot;'), 'a&b \'x\' <y> "z"');
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

test('newApiKey is prefixed, long and unique', () => {
  const keys = new Set();
  for (let i = 0; i < 50; i++) {
    const k = newApiKey();
    assert.match(k, /^am_[A-Za-z0-9_-]{30,}$/);
    keys.add(k);
  }
  assert.equal(keys.size, 50, 'every minted key is unique');
});

test('hashApiKey is deterministic and hides the key', () => {
  const key = newApiKey();
  assert.equal(hashApiKey(key), hashApiKey(key));
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
  assert.notEqual(hashApiKey(key), key);
  assert.notEqual(hashApiKey(key), hashApiKey(newApiKey()));
});

test('newAccountRow stores only a hash of the account key', () => {
  const { account, apiKey } = newAccountRow({ name: 'Agent <One>!' });
  assert.equal(account.name, 'Agent One');
  assert.equal(account.plan, 'free');
  assert.equal(account.apiKeyHash, hashApiKey(apiKey));
  assert.ok(!JSON.stringify(account).includes(apiKey), 'raw key must never be stored');
  assert.ok(apiKey.startsWith(account.apiKeyPrefix));
});

test('dkimPublicKeyRecord is empty when no key is configured', () => {
  assert.equal(dkimPublicKeyRecord(), '');
});

test('rateBucketUsage peeks without consuming quota', () => {
  const key = `probe-unit-${Date.now()}`;
  assert.deepEqual(rateBucketUsage(key, 100), { limit: 100, used: 0, remaining: 100, resetAt: null });
  // A limit of 0 means disabled: remaining is null (unlimited), used still counts.
  assert.deepEqual(rateBucketUsage(key, 0), { limit: 0, used: 0, remaining: null, resetAt: null });
  assert.deepEqual(windowBucketUsage(key), { count: 0, resetAt: null });
});

test('quotaForAddress reports buckets for a registered address', () => {
  const addr = `probe-${Date.now()}@mail.example.test`;
  registerAddress(addr);
  const q = quotaForAddress(addr);
  assert.equal(q.address, addr);
  assert.equal(q.emails, 0);
  assert.ok(q.createdAt, 'createdAt is set');
  assert.equal(q.sendPerHour.limit, 100);
  assert.equal(q.sendPerHour.used, 0);
  assert.equal(q.sendPerHour.remaining, 100);
  assert.equal(q.sendPerHour.resetAt, null);
  assert.equal(q.receivePerHour.limit, 100);
  assert.equal(q.receivePerHour.used, 0);
});

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}

// --- Outbound send (mock transport, no real mail) ---
async function atest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n  ${err.message}`);
  }
}

(async () => {
  await atest('validateSendBody accepts a valid body', () => {
    const v = validateSendBody({
      from: 'Agent1@Mail.Example.Test',
      to: 'User@Example.com',
      subject: 'Hi',
      text: 'hello',
    });
    assert.equal(v.ok, true);
    assert.equal(v.value.from, 'agent1@mail.example.test');
    assert.deepEqual(v.value.to, ['user@example.com']);
    assert.equal(v.value.subject, 'Hi');
    assert.equal(v.value.html, undefined);
  });

  await atest('validateSendBody accepts array recipients and html body', () => {
    const v = validateSendBody({
      from: 'a@mail.example.test',
      to: ['b@example.com', 'c@example.com'],
      subject: '',
      html: '<p>hi</p>',
    });
    assert.equal(v.ok, true);
    assert.deepEqual(v.value.to, ['b@example.com', 'c@example.com']);
  });

  await atest('validateSendBody rejects bad input', () => {
    assert.equal(validateSendBody(null).ok, false);
    assert.equal(validateSendBody({ to: 'x@y.com', text: 'hi' }).ok, false); // no from
    assert.equal(validateSendBody({ from: 'not-an-address', to: 'x@y.com', text: 'hi' }).ok, false);
    assert.equal(validateSendBody({ from: 'a@mail.example.test', text: 'hi' }).ok, false); // no to
    assert.equal(validateSendBody({ from: 'a@mail.example.test', to: 'bad', text: 'hi' }).ok, false);
    assert.equal(validateSendBody({ from: 'a@mail.example.test', to: 'x@y.com' }).ok, false); // no body
    assert.equal(validateSendBody({ from: 'a@mail.example.test', to: Array(11).fill('x@y.com'), text: 'hi' }).ok, false); // >10 recipients
    assert.equal(validateSendBody({ from: 'a@mail.example.test', to: 'x@y.com', subject: 's'.repeat(1001), text: 'hi' }).ok, false);
  });

  await atest('sendAgentMail sends via injected mock transport', async () => {
    const captured = [];
    setSendTransport({
      sendMail: async opts => {
        captured.push(opts);
        return { messageId: 'mock-id-1', accepted: opts.to, rejected: [] };
      },
    });
    try {
      registerAddress('sender@mail.example.test');
      const out = await sendAgentMail({
        from: 'sender@mail.example.test',
        to: ['dest@example.com'],
        subject: 'Hello',
        text: 'body here',
        html: undefined,
      });
      assert.equal(out.messageId, 'mock-id-1');
      assert.equal(captured.length, 1);
      assert.equal(captured[0].from, 'sender@mail.example.test');
      assert.deepEqual(captured[0].to, ['dest@example.com']);
      assert.equal(captured[0].subject, 'Hello');
    } finally {
      setSendTransport(null);
    }
  });

  await atest('sendAgentMail rejects a foreign From address (403)', async () => {
    setSendTransport({ sendMail: async () => { throw new Error('must not be called'); } });
    try {
      await assert.rejects(
        sendAgentMail({ from: 'stranger@evil.example', to: ['x@y.com'], subject: 's', text: 't' }),
        err => err.status === 403
      );
    } finally {
      setSendTransport(null);
    }
  });

  await atest('sendAgentMail answers 503 when no relay is configured', async () => {
    // This process has no SMTP_RELAY_HOST, so the relay is unconfigured
    // and no mock transport is injected here.
    setSendTransport(null);
    registerAddress('norelay@mail.example.test');
    await assert.rejects(
      sendAgentMail({ from: 'norelay@mail.example.test', to: ['x@y.com'], subject: 's', text: 't' }),
      err => err.status === 503
    );
  });

  await atest('sendAgentMail enforces the per-address hourly quota (429)', async () => {
    setSendTransport({
      sendMail: async opts => ({ messageId: 'mock-id', accepted: opts.to, rejected: [] }),
    });
    try {
      const from = 'quota@mail.example.test';
      registerAddress(from);
      for (let i = 0; i < 100; i++) {
        await sendAgentMail({ from, to: ['x@y.com'], subject: 's', text: 't' });
      }
      await assert.rejects(
        sendAgentMail({ from, to: ['x@y.com'], subject: 's', text: 't' }),
        err => err.status === 429
      );
    } finally {
      setSendTransport(null);
    }
  });

  await atest('validateSendBody sanitizes fromName and rejects an oversized one', () => {
    const v = validateSendBody({
      from: 'a@mail.example.test',
      fromName: '"Marcus\r\nBcc: x@y.com" <Vance>',
      to: 'x@y.com',
      text: 'hi',
    });
    assert.equal(v.ok, true);
    assert.equal(v.value.fromName, 'Marcus Bcc: x@y.com Vance');
    assert.equal(validateSendBody({
      from: 'a@mail.example.test',
      fromName: 'n'.repeat(121),
      to: 'x@y.com',
      text: 'hi',
    }).ok, false);
  });

  await atest('buildOutboundRequest shapes a Resend send', () => {
    const req = buildOutboundRequest('resend', {
      from: 'marcus@mail.example.test',
      fromName: 'Marcus Vance',
      to: ['human@example.com'],
      subject: 'Hello',
      text: 'plain',
      html: '<b>rich</b>',
    }, { apiKey: 're_test_key', apiBase: 'https://api.test' });
    assert.equal(req.url, 'https://api.test/emails');
    assert.equal(req.headers.authorization, 'Bearer re_test_key');
    assert.equal(req.body.from, 'Marcus Vance <marcus@mail.example.test>');
    assert.deepEqual(req.body.to, ['human@example.com']);
    assert.equal(req.body.subject, 'Hello');
    assert.equal(req.body.text, 'plain');
    assert.equal(req.body.html, '<b>rich</b>');
  });

  await atest('buildOutboundRequest shapes a Brevo send', () => {
    const req = buildOutboundRequest('brevo', {
      from: 'marcus@mail.example.test',
      fromName: 'Marcus Vance',
      to: ['human@example.com'],
      subject: 'Hello',
      text: 'plain',
      html: '<b>rich</b>',
    }, { apiKey: 'brevo_test_key', apiBase: 'https://brevo.test' });
    assert.equal(req.url, 'https://brevo.test/v3/smtp/email');
    assert.equal(req.headers['api-key'], 'brevo_test_key');
    assert.deepEqual(req.body.sender, { email: 'marcus@mail.example.test', name: 'Marcus Vance' });
    assert.deepEqual(req.body.to, [{ email: 'human@example.com' }]);
    assert.equal(req.body.textContent, 'plain');
    assert.equal(req.body.htmlContent, '<b>rich</b>');
  });

  if (failures > 0) {
    console.error(`${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('All unit tests passed');
})();
