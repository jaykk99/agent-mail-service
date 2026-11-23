import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateSlug,validateAgentId,validateDomain} from '../src/index.js';

test('agents choose unique readable names rather than agent0001', () => {
  assert.equal(validateSlug('Aurora-Design'), 'aurora-design');
  assert.equal(validateSlug(' postmaster '), null);
  assert.equal(validateSlug('a'), null);
  assert.equal(validateSlug('../root'), null);
  assert.equal(validateSlug('good.name'), null);
  assert.equal(validateSlug('good-name'), 'good-name');
});
test('strict agent ID boundaries', () => {
  assert.equal(validateAgentId('0'), 0);
  assert.equal(validateAgentId('1499'), 1499);
  assert.equal(validateAgentId('1500'), null);
  assert.equal(validateAgentId('-1'), null);
  assert.equal(validateAgentId('1/claim'), null);
});
test('public domain requirements', () => {
  assert.equal(validateDomain('mail.example.com'), 'mail.example.com');
  assert.equal(validateDomain('agents.invalid'), null);
  assert.equal(validateDomain('agents.localhost'), null);
  assert.equal(validateDomain('localhost'), null);
});
