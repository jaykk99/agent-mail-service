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

if (failures) process.exit(1);
console.log('All unit tests passed');
