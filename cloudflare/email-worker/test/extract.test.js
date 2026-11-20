/**
 * Worker extraction tests (no Wrangler, no network).
 * Run: node cloudflare/email-worker/test/extract.test.js
 */
import assert from 'node:assert/strict';
import {
  htmlToText,
  extractLinks,
  extractCodes,
  bestCode,
  bestLink,
} from '../src/extract.js';

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

test('extractCodes picks a labelled numeric code', () => {
  assert.deepEqual(extractCodes('Verify your email', 'Your verification code is 483921.'), ['483921']);
});

test('extractCodes joins a spaced six-digit code', () => {
  assert.deepEqual(extractCodes('Sign in', 'Use code 123 456 to continue.'), ['123456']);
});

test('extractCodes accepts alphanumeric codes', () => {
  assert.deepEqual(extractCodes('Confirm', 'Your code: K7Q2M9'), ['K7Q2M9']);
});

test('extractCodes reads a code on the line after the label', () => {
  assert.deepEqual(extractCodes('Your code is:', '\n\n483921\n\nIt expires soon.'), ['483921']);
});

test('extractCodes ignores years, prices, phones and URLs', () => {
  assert.deepEqual(
    extractCodes('Receipt', 'Ordered in 2024 for $19.99. Call (555) 123-4567. See https://x.io/order/778899.'),
    [],
  );
});

test('extractCodes works on HTML-only mail', () => {
  assert.equal(bestCode('', htmlToText('<p>Your code is <b>837261</b></p>')), '837261');
});

test('extractLinks mines href values and decodes entities', () => {
  const links = extractLinks('', '<a href="https://x.io/verify?token=abc&amp;id=2">Verify email</a>');
  assert.deepEqual(links, ['https://x.io/verify?token=abc&id=2']);
});

test('extractLinks trims trailing sentence punctuation', () => {
  assert.deepEqual(extractLinks('Click https://x.com/verify?token=abc. Done!'), ['https://x.com/verify?token=abc']);
});

test('bestLink skips logo and unsubscribe-only mail', () => {
  assert.equal(
    bestLink('Unsubscribe https://x.io/unsubscribe and logo https://x.io/logo.png', ''),
    null,
  );
});

test('bestLink prefers the verification link over the homepage', () => {
  const html = '<a href="https://x.io/">Home</a><a href="https://x.io/verify?token=abcdefghijklmnopqrstuvwxyz123456">Verify</a>';
  assert.equal(bestLink('', html), 'https://x.io/verify?token=abcdefghijklmnopqrstuvwxyz123456');
});

test('htmlToText strips scripts, styles and decodes entities', () => {
  const html = '<style>.a{color:red}</style><p>Hello&nbsp;<b>World</b> &amp; friends</p><script>alert(1)</script>';
  assert.equal(htmlToText(html), 'Hello World & friends');
});

if (failures) {
  console.error(`${failures} worker test(s) failed`);
  process.exit(1);
}
console.log('worker tests passed');
