'use strict';

process.env.DATA_DIR = ':memory:';

const assert = require('node:assert/strict');
const {
  agents,
  htmlToText,
  extractLinks,
  extractAttachments,
  findVerifyLink,
  findCode,
  validAddressParam,
  validLocalPart,
  normalizeAddressPrefix,
  sanitizeDomain,
  extractCodes,
  rankLinks,
  decodeEntities,
  validateSendBody,
  pruneExpiredEmails,
  bucketUsage,
  quotaForAddress,
  quotaSummary,
  recordSend,
  recordReceive,
  resetQuotaCounters,
} = require('../server.js');
const { generateLinuxConfigs } = require('../lib/linux-configs.js');

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

test('auto-provisions 1,000 agents (2000..2999) on boot', () => {
  assert.equal(agents.size, 1000);
  assert.equal(agents.get('2000').agentId, 'agent-0001');
  assert.equal(agents.get('2999').agentId, 'agent-1000');
});

test('sanitizeDomain accepts free local and custom domains without rejection', () => {
  assert.equal(sanitizeDomain(''), 'agents.local');
  assert.equal(sanitizeDomain('agents.local'), 'agents.local');
  assert.equal(sanitizeDomain('MyBox.DuckDNS.org'), 'mybox.duckdns.org');
  assert.equal(sanitizeDomain('localhost'), 'localhost');
});

test('validAddressParam supports local and multi-label domains', () => {
  assert.equal(validAddressParam('agent-0001@agents.local'), true);
  assert.equal(validAddressParam('root@localhost'), true);
  assert.equal(validAddressParam('bad..user@agents.local'), false);
  assert.equal(validAddressParam('no-at-sign'), false);
});

test('normalizeAddressPrefix cleans arbitrary text into valid local-part', () => {
  assert.equal(normalizeAddressPrefix('  Support..Team! '), 'support.team');
  assert.equal(normalizeAddressPrefix('...---'), '');
  assert.equal(validLocalPart('agent-0001'), true);
});

test('extractLinks trims trailing punctuation and mines HTML hrefs', () => {
  const links = extractLinks('Visit https://example.local/ok.', '<a href="https://example.local/verify?a=1&amp;b=2">Verify</a>');
  assert.deepEqual(links, ['https://example.local/verify?a=1&b=2', 'https://example.local/ok']);
});

test('htmlToText strips tags and decodes entities', () => {
  assert.equal(htmlToText('<style>x{}</style><p>Hi&nbsp;<b>Agent</b> &amp; team</p>'), 'Hi Agent & team');
});

test('extractCodes pulls OTP codes and ignores years/phones', () => {
  const codes = extractCodes('Verify 2026', 'Call 555-123-4567. Your code is: 483921');
  assert.equal(codes[0], '483921');
});

test('findVerifyLink and findCode locate best items', () => {
  const emails = [{
    id: 'e1',
    from: 'auth@agents.local',
    subject: 'Code',
    text: 'Use code 774411',
    links: ['https://agents.local/unsubscribe', 'https://agents.local/verify?token=abc'],
    codes: ['774411'],
  }];
  assert.equal(findVerifyLink(emails).url, 'https://agents.local/verify?token=abc');
  assert.equal(findCode(emails).code, '774411');
  assert.equal(rankLinks(emails[0].links)[0], 'https://agents.local/verify?token=abc');
  assert.equal(decodeEntities('a&amp;b'), 'a&b');
  assert.equal(extractAttachments({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', size: 5 }] }).length, 1);
});

test('validateSendBody accepts valid payload and rejects missing body', () => {
  const ok = validateSendBody({ from: 'agent-0001@agents.local', to: 'agent-0002@agents.local', subject: 'Hi', text: 'Hello' });
  assert.equal(ok.ok, true);
  const bad = validateSendBody({ from: 'agent-0001@agents.local', to: 'agent-0002@agents.local', subject: 'Hi' });
  assert.equal(bad.ok, false);
});

test('generateLinuxConfigs renders all 1,000 Asterisk extensions and USB SIM bridge', () => {
  const files = generateLinuxConfigs({ domain: 'agents.local', agents: [...agents.values()] });
  assert.ok(files['pjsip_agents.conf'].includes('[2000]'));
  assert.ok(files['pjsip_agents.conf'].includes('[2999]'));
  assert.ok(files['extensions_agents.conf'].includes('Dongle/dongle0'));
  assert.ok(files['sim-modem-bridge.sh'].includes('/api/phone/inbound-sim'));
  assert.ok(files['postfix-main.cf'].includes('agents.local'));
});

test('validAddressParam rejects numeric and single-char TLDs', () => {
  assert.equal(validAddressParam('a@host.123'), false);
  assert.equal(validAddressParam('a@host.x'), false);
  assert.equal(validAddressParam('root@localhost'), true);
  assert.equal(validAddressParam('agent-0001@agents.local'), true);
});

test('pruneExpiredEmails keys on arrival time, not the sender Date header', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const iso = ms => new Date(ms).toISOString();
  // Fresh arrival with a 60-day-old sender date is kept (old code kept it
  // only by accident of order; the bug was the reverse case below).
  // Expired arrival buried behind a new sender date is dropped: the old
  // front-only scan keyed on date never reached it.
  const list = [
    { id: 'new-date-old-arrival', date: iso(now), receivedAt: iso(now - 40 * day) },
    { id: 'old-date-new-arrival', date: iso(now - 60 * day), receivedAt: iso(now) },
    { id: 'no-timestamp', date: '', receivedAt: '' },
    { id: 'date-fallback-expired', date: iso(now - 40 * day) },
  ];
  const kept = pruneExpiredEmails(list, now).map(e => e.id);
  assert.deepEqual(kept, ['old-date-new-arrival', 'no-timestamp']);
});

test('bucketUsage reports limit/used/remaining/resetAt, unlimited when limit is 0', () => {
  const now = Date.now();
  assert.deepEqual(bucketUsage([], 3600000, 10, now), { limit: 10, used: 0, remaining: 10, resetAt: null });
  assert.deepEqual(bucketUsage([], 3600000, 0, now), { limit: 0, used: 0, remaining: null, resetAt: null });
  const one = bucketUsage([now - 1000], 3600000, 2, now);
  assert.equal(one.used, 1);
  assert.equal(one.remaining, 1);
  assert.equal(one.resetAt, new Date(now - 1000 + 3600000).toISOString());
  assert.equal(bucketUsage([now - 7200000, now - 1000], 3600000, 5, now).used, 1);
});

test('quotaForAddress counts sends and receives without consuming quota', () => {
  resetQuotaCounters();
  const addr = 'quota-unit@agents.local';
  recordSend(addr);
  recordSend(addr);
  recordReceive(addr);
  const q = quotaForAddress(addr);
  assert.equal(q.address, addr);
  assert.equal(q.sends.last24h.used, 2);
  assert.equal(q.sends.hourly.used, 2);
  assert.equal(q.sends.last24h.limit, 0);
  assert.equal(q.sends.last24h.remaining, null);
  assert.equal(q.receives.last24h.used, 1);
  assert.equal(q.receives.stored, 0);
  const summary = quotaSummary();
  assert.equal(summary.global.sendsLast24h, 2);
  assert.equal(summary.global.receivesLast24h, 1);
  assert.equal(summary.countersResetOnRestart, true);
  assert.ok(summary.addresses.some(a => a.address === addr));
  resetQuotaCounters();
});

if (failures) process.exit(1);
console.log('All unit tests passed');
