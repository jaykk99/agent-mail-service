#!/usr/bin/env node
/**
 * One-shot deploy of Agent City mail to Cloudflare using only the REST API.
 *
 *   CF_API_TOKEN=... CF_ACCOUNT_ID=... MAIL_DOMAINS=a.dpdns.org,b.qzz.io \
 *   BRIDGE_TOKEN=<32+ chars> node deploy.mjs
 *
 * Creates/reuses D1, applies schema.sql, uploads the Worker (bundled with
 * esbuild), enables Email Routing on every domain's zone and points a
 * catch-all rule at the Worker. Sending (EMAIL binding) is attached only when
 * ENABLE_SENDING=1 because arbitrary recipients need Workers Paid.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { CF_API_TOKEN, CF_ACCOUNT_ID, MAIL_DOMAINS, BRIDGE_TOKEN, ENABLE_SENDING } = process.env;
if (!CF_API_TOKEN || !CF_ACCOUNT_ID || !MAIL_DOMAINS || !BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32) {
  console.error('Need CF_API_TOKEN, CF_ACCOUNT_ID, MAIL_DOMAINS and BRIDGE_TOKEN (32+ chars).');
  process.exit(1);
}
const API = 'https://api.cloudflare.com/client/v4';
const NAME = 'agent-city-mail';
async function cf(method, path, body, contentType = 'application/json') {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${CF_API_TOKEN}`, ...(body ? { 'content-type': contentType } : {}) },
    body: body && contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  const data = await res.json();
  if (!data.success) throw new Error(`${method} ${path}: ${JSON.stringify(data.errors)}`);
  return data.result;
}

const domains = MAIL_DOMAINS.split(/[\s,]+/).filter(Boolean);
const acct = `/accounts/${CF_ACCOUNT_ID}`;

// 1. D1
const dbs = await cf('GET', `${acct}/d1/database?name=${NAME}`);
const db = dbs.find((d) => d.name === NAME) ?? (await cf('POST', `${acct}/d1/database`, { name: NAME }));
await cf('POST', `${acct}/d1/database/${db.uuid}/query`, { sql: readFileSync(new URL('./schema.sql', import.meta.url), 'utf8') });
console.log('D1 ready', db.uuid);

// 2. Worker
const code = execFileSync('npx', ['-y', 'esbuild@0.24.0', 'src/index.js', '--bundle', '--format=esm', '--minify'], {
  cwd: new URL('.', import.meta.url).pathname,
}).toString();
const metadata = {
  main_module: 'index.js',
  compatibility_date: '2026-11-20',
  bindings: [
    { type: 'd1', name: 'DB', id: db.uuid },
    { type: 'plain_text', name: 'MAIL_DOMAINS', text: domains.join(',') },
    { type: 'secret_text', name: 'BRIDGE_TOKEN', text: BRIDGE_TOKEN },
    ...(ENABLE_SENDING === '1' ? [{ type: 'send_email', name: 'EMAIL' }] : []),
  ],
};
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
form.append('index.js', new Blob([code], { type: 'application/javascript+module' }), 'index.js');
await cf('PUT', `${acct}/workers/scripts/${NAME}`, form, undefined);
const sub = await cf('GET', `${acct}/workers/subdomain`).catch(() => null);
await cf('POST', `${acct}/workers/scripts/${NAME}/subdomain`, { enabled: true }).catch(() => null);
console.log('Worker live', sub ? `https://${NAME}.${sub.subdomain}.workers.dev` : '');

// 3. Email Routing per domain
for (const domain of domains) {
  const [zone] = await cf('GET', `/zones?name=${domain}`);
  if (!zone) { console.warn('No Cloudflare zone for', domain, '- add it first'); continue; }
  await cf('POST', `/zones/${zone.id}/email/routing/dns`, { name: domain }).catch((e) => console.warn(e.message));
  await cf('PUT', `/zones/${zone.id}/email/routing/rules/catch_all`, {
    enabled: true, name: 'Agent City mailboxes',
    matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [NAME] }],
  });
  console.log('Email routing ->', NAME, 'for', domain, `(zone ${zone.status})`);
}
