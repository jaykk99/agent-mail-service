#!/usr/bin/env node
/**
 * Deploy the Cloudflare Email Worker with an API token, no `wrangler login`.
 *
 * Required environment (project secrets or exported):
 *   CLOUDFLARE_API_TOKEN   scoped to Workers Scripts:Edit + Zone:Email Routing:Edit
 *   CLOUDFLARE_ACCOUNT_ID  the account that owns the domain
 *
 * Usage:
 *   npm run deploy        # upload
 *   npm run deploy:dry    # bundle only, no account or token needed
 *
 * `--dry-run` still requires the variables so the real deploy path is the one
 * under test; use dummy values if you only want to check the bundle.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const dryRun = process.argv.includes('--dry-run');

const missing = REQUIRED.filter(key => !String(process.env[key] || '').trim());
if (missing.length) {
  console.error(`Cannot deploy the Email Worker: missing ${missing.join(', ')}.`);
  console.error('Create a Cloudflare API token with "Workers Scripts: Edit" and');
  console.error('"Zone: Email Routing: Edit", then set CLOUDFLARE_API_TOKEN and');
  console.error('CLOUDFLARE_ACCOUNT_ID as project secrets (or export them) and re-run.');
  console.error('`npm run deploy:dry` validates the bundle without uploading.');
  process.exit(1);
}

const wrangler = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
if (!existsSync(wrangler)) {
  console.error('wrangler is not installed in cloudflare/email-worker.');
  console.error('Run `npm install` in cloudflare/email-worker first.');
  process.exit(1);
}

let outdir = '';
const args = ['deploy', '--config', path.join(ROOT, 'wrangler.toml')];
if (dryRun) {
  outdir = mkdtempSync(path.join(os.tmpdir(), 'agent-mail-worker-dry-'));
  args.push('--dry-run', '--outdir', outdir);
}

const result = spawnSync(wrangler, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
if (outdir) rmSync(outdir, { recursive: true, force: true });

if (result.error) {
  console.error(`Failed to run wrangler: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
