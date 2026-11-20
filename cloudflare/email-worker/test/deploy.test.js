/**
 * Deploy-script checks: the failure path always runs; the dry-run bundle runs
 * when wrangler is installed (it is a devDependency of this package).
 *
 * Run: node cloudflare/email-worker/test/deploy.test.js
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'deploy.mjs');
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');

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

function run(env) {
  const base = { ...process.env };
  delete base.CLOUDFLARE_API_TOKEN;
  delete base.CLOUDFLARE_ACCOUNT_ID;
  return spawnSync(process.execPath, [SCRIPT, '--dry-run'], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
}

test('fails with a clear message when both secrets are missing', () => {
  const res = run({});
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CLOUDFLARE_API_TOKEN/);
  assert.match(res.stderr, /CLOUDFLARE_ACCOUNT_ID/);
});

test('names the one missing secret', () => {
  const res = run({ CLOUDFLARE_API_TOKEN: 'test-token' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing CLOUDFLARE_ACCOUNT_ID/);
});

test('bundles through the deploy script with dummy credentials', () => {
  if (!existsSync(WRANGLER)) {
    console.log('skip - wrangler not installed (run npm install in cloudflare/email-worker)');
    return;
  }
  const res = run({ CLOUDFLARE_API_TOKEN: 'dummy-token', CLOUDFLARE_ACCOUNT_ID: 'dummy-account' });
  assert.equal(res.status, 0, `wrangler dry-run failed:\n${res.stdout}\n${res.stderr}`);
  assert.match(`${res.stdout}${res.stderr}`, /dry-run|Total Upload/i);
});

if (failures) {
  console.error(`${failures} deploy test(s) failed`);
  process.exit(1);
}
console.log('deploy tests passed');
