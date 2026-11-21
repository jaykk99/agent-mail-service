/**
 * Agent Mail Service — self-hosted email for AI agents.
 *
 * Receives emails via SMTP and exposes them via a simple REST API
 * so the Error Inbox MCP can poll for provider verification emails
 * without depending on Gmail or temp-mail services.
 *
 * Endpoints:
 *   POST /api/accounts           { name? } -> { account, apiKey } (free signup)
 *   GET  /api/me                 -> calling account + usage (or master summary)
 *   GET  /api/quota              -> send/receive/creation quota usage (caller-scoped)
 *   GET  /api/quota/:address     -> quota usage for one address (send + receive buckets)
 *   GET  /api/relay              -> outbound relay health incl. live SMTP EHLO probe (master only)
 *   GET  /api/accounts           -> every account with usage (master only)
 *   GET  /api/dns                -> MX/SPF/DKIM/DMARC records to publish
 *   POST /api/addresses          { prefix } -> { address }
 *   GET  /api/addresses          -> known addresses with inbox counts
 *   POST /api/send               { from, to, subject, text, html? } -> { messageId }
 *   GET  /api/inbox/:address     -> paginated list (page/per_page AND limit/offset, q, from)
 *   GET  /api/inbox/:address/:id -> full email (subject, body, links, attachment metadata)
 *   DELETE /api/inbox/:address   -> clear inbox
 *   GET  /api/verify-link/:address?from= -> newest verification URL (immediate)
 *   GET  /api/verify-link/:address/wait?from=&timeoutMs= -> long-poll for a link
 *   GET  /api/dead-letters       -> emails that failed to store after retries
 *   GET  /dashboard              -> local browser UI for addresses/inboxes
 *
 * Features: retry-with-backoff store queue + dead-letter log, retention
 * pruning, address TTL auto-cleanup sweep, per-IP rate limiting
 * (RATE_LIMIT_PER_MINUTE) plus hourly quotas (ADDRESS_CREATE_MAX_PER_HOUR,
 * EMAILS_PER_ADDRESS_PER_HOUR), HMAC-signed incoming-mail webhooks,
 * structured request logging, attachment metadata (never content),
 * outbound send (POST /api/send) via SMTP_RELAY_* or a Resend/Brevo HTTP API.
 * Outbound mail is only ever sent FROM an address this service created;
 * foreign From values are rejected.
 *
 * Rate-limit precedence: BOTH creation limits apply — a creation must pass
 * the per-IP per-minute limit AND the global hourly quota; either one can
 * return 429. Pagination precedence: if limit/offset are present they win,
 * otherwise page/per_page are used.
 *
 * Auth: Bearer token. AGENT_MAIL_TOKEN is the master (admin) key and sees
 * every address. POST /api/accounts mints a free per-agent account + API key
 * (only its SHA-256 hash is stored); an account key sees only the addresses
 * that account created and can only send From them. Addresses created with
 * the master token are owned by "master" and stay invisible to accounts.
 *
 * Storage: Supabase table `agent_emails` when SUPABASE_URL and
 * SUPABASE_SERVICE_KEY are set; otherwise falls back to an in-memory
 * Map so local dev keeps working with no config. Failed Supabase stores
 * are retried with exponential backoff before landing in the dead-letter log.
 */

const express = require('express');
const crypto = require('crypto');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const app = express();
// The HTTP inbound route (Cloudflare Email Worker deliveries) carries full
// message bodies, so it gets a larger parser BEFORE the global cap below;
// express marks the body as parsed and the global parser then skips it.
app.use('/api/inbound', express.json({ limit: '3mb' }));
// Bound request bodies so oversized posts can't be used to grow memory.
app.use(express.json({ limit: '50kb' }));

const PORT = process.env.PORT || 3000;
const SMTP_PORT = process.env.SMTP_PORT || 2525;
// Render and other HTTP-only hosts must not try to publish a separate SMTP port.
// A disabled listener does not disable HTTP inbound worker delivery.
const SMTP_ENABLED = String(process.env.SMTP_ENABLED || '1') !== '0';
const TOKEN = process.env.AGENT_MAIL_TOKEN || 'dev-token-change-me';
if (TOKEN === 'dev-token-change-me') {
  console.warn('[security] AGENT_MAIL_TOKEN is the default dev token — set a long random token in production!');
}
// Lowercased once: every comparison below is against lowercased addresses, so
// a MAIL_DOMAIN typed with capitals used to drop all HTTP-inbound mail.
const DOMAIN = String(process.env.MAIL_DOMAIN || 'localhost').trim().toLowerCase().replace(/^@/, '');
// HTTP inbound (Cloudflare Email Worker) auth: a dedicated secret when set,
// otherwise the API token. Use the SAME value as AGENT_MAIL_INBOUND_SECRET on
// error-inbox and INBOUND_SECRET on the worker.
const INBOUND_SECRET = process.env.AGENT_MAIL_INBOUND_SECRET || '';

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

// --- Feature config (union of both sides) ---
// Retention (origin): in-memory mail older than this is pruned on store.
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS) || 7);
// Per-IP address-creation rate limit (origin).
const RATE_LIMIT_PER_MINUTE = Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE) || 30);
// Address TTL (quota): addresses with no activity older than this are
// auto-cleaned. ADDRESS_TTL_HOURS=0 disables the sweep entirely.
const ADDRESS_TTL_HOURS = numEnv('ADDRESS_TTL_HOURS', 72);
const ADDRESS_SWEEP_MS = numEnv('ADDRESS_SWEEP_MS', 30 * 60 * 1000);
// Hourly quotas (quota side). 0 disables each.
const ADDRESS_CREATE_MAX_PER_HOUR = numEnv('ADDRESS_CREATE_MAX_PER_HOUR', 20);
const EMAILS_PER_ADDRESS_PER_HOUR = numEnv('EMAILS_PER_ADDRESS_PER_HOUR', 100);
// Optional webhook fired on every received email (HMAC-signed when the
// secret is set). Leave INCOMING_WEBHOOK_URL unset to disable.
const WEBHOOK_URL = process.env.INCOMING_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.INCOMING_WEBHOOK_SECRET || '';
const WEBHOOK_TIMEOUT_MS = numEnv('INCOMING_WEBHOOK_TIMEOUT_MS', 8000);
// Optional outbound SMTP relay: mail sent by POST /api/send goes through
// here. Validated at boot; when unconfigured, /api/send answers 503.
const SMTP_RELAY_HOST = process.env.SMTP_RELAY_HOST || '';
const SMTP_RELAY_PORT = numEnv('SMTP_RELAY_PORT', 587);
const SMTP_RELAY_USER = process.env.SMTP_RELAY_USER || '';
const SMTP_RELAY_PASS = process.env.SMTP_RELAY_PASS || '';
// Hourly outbound-send quota per From address (0 disables).
const SEND_MAX_PER_HOUR = numEnv('SEND_MAX_PER_HOUR', 100);
// Outbound HTTP API provider: "smtp" (default relay), "resend" (3,000 free
// emails/month) or "brevo" (300 free/day). When OUTBOUND_PROVIDER is unset, a
// configured provider key selects that API automatically. Provider API bases
// are overridable so tests can point at a local server.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const RESEND_API_BASE = String(process.env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
const BREVO_API_BASE = String(process.env.BREVO_API_BASE || 'https://api.brevo.com').replace(/\/+$/, '');
const OUTBOUND_PROVIDER = String(
  process.env.OUTBOUND_PROVIDER || (RESEND_API_KEY ? 'resend' : BREVO_API_KEY ? 'brevo' : 'smtp')
).trim().toLowerCase();
// Global daily cap across every agent (0 disables). Free provider tiers are
// per account, so set this at or below the plan's daily allowance.
const SEND_MAX_PER_DAY = numEnv('SEND_MAX_PER_DAY', 0);

// --- Accounts: a free, isolated mailbox per agent (thousands of agents) ---
// Self-serve signup mints an account + API key. Open by default — this is a
// free service — and bounded per IP and globally so one client cannot
// exhaust the domain. Set SIGNUP_OPEN=0 to require the master token.
const SIGNUP_OPEN = String(process.env.SIGNUP_OPEN ?? '1') !== '0';
const SIGNUP_PER_IP_PER_HOUR = numEnv('SIGNUP_PER_IP_PER_HOUR', 5);
const SIGNUP_MAX_PER_HOUR = numEnv('SIGNUP_MAX_PER_HOUR', 500);
// Addresses one account may own at a time (the master token is unlimited).
const ADDRESS_QUOTA_PER_ACCOUNT = numEnv('ADDRESS_QUOTA_PER_ACCOUNT', 25);
// Reserved owner id for addresses created with the master token.
const OWNER_MASTER = 'master';
// DMARC policy advertised by GET /api/dns. Start at "none" (report only),
// move to "quarantine" once DKIM signing has been verified.
const DMARC_POLICY = String(process.env.DMARC_POLICY || 'none').trim();

// --- DKIM: sign outbound mail so receivers can verify it is really ours ---
// DKIM_PRIVATE_KEY is a PEM RSA private key (literal newlines or \n escapes).
const DKIM_DOMAIN = String(process.env.DKIM_DOMAIN || DOMAIN).trim().toLowerCase();
const DKIM_SELECTOR = String(process.env.DKIM_SELECTOR || 'mail').trim();
const DKIM_PRIVATE_KEY = String(process.env.DKIM_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();

// The public half of the key, ready for the DNS TXT record. Derived from the
// private key so the two can never drift apart.
function dkimPublicKeyRecord() {
  if (!DKIM_PRIVATE_KEY) return '';
  try {
    return crypto.createPublicKey(DKIM_PRIVATE_KEY)
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
  } catch {
    return '';
  }
}

function validateDkimConfig() {
  if (!DKIM_PRIVATE_KEY) return { status: 'unconfigured', publicKey: '' };
  const publicKey = dkimPublicKeyRecord();
  if (!publicKey) {
    console.warn('[dkim] DKIM_PRIVATE_KEY is set but is not a usable PEM RSA private key — outbound mail will NOT be signed');
    return { status: 'misconfigured', publicKey: '' };
  }
  console.log(`[dkim] signing outbound mail as ${DKIM_SELECTOR}._domainkey.${DKIM_DOMAIN}`);
  return { status: 'configured', publicKey };
}
const DKIM_STATUS = validateDkimConfig();

function validateRelayConfig() {
  if (!SMTP_RELAY_HOST) return { status: 'unconfigured', problems: [] };
  const problems = [];
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(SMTP_RELAY_HOST)) {
    problems.push(`SMTP_RELAY_HOST "${SMTP_RELAY_HOST}" is not a valid hostname`);
  }
  if (!Number.isInteger(SMTP_RELAY_PORT) || SMTP_RELAY_PORT < 1 || SMTP_RELAY_PORT > 65535) {
    problems.push(`SMTP_RELAY_PORT "${process.env.SMTP_RELAY_PORT}" is out of range 1-65535`);
  }
  const user = process.env.SMTP_RELAY_USER || '';
  const pass = process.env.SMTP_RELAY_PASS || '';
  if ((user && !pass) || (!user && pass)) {
    problems.push('SMTP_RELAY_USER and SMTP_RELAY_PASS must be set together');
  }
  if (problems.length) {
    for (const p of problems) console.warn(`[relay] misconfigured: ${p}`);
    return { status: 'misconfigured', problems };
  }
  console.log(`[relay] outbound relay configured: ${SMTP_RELAY_HOST}:${SMTP_RELAY_PORT}`);
  return { status: 'configured', problems: [] };
}
const RELAY_STATUS = validateRelayConfig();

function validateOutboundConfig() {
  if (OUTBOUND_PROVIDER === 'smtp') {
    return { provider: 'smtp', configured: RELAY_STATUS.status === 'configured', problems: RELAY_STATUS.problems };
  }
  if (OUTBOUND_PROVIDER === 'resend' || OUTBOUND_PROVIDER === 'brevo') {
    const envName = OUTBOUND_PROVIDER === 'resend' ? 'RESEND_API_KEY' : 'BREVO_API_KEY';
    const key = OUTBOUND_PROVIDER === 'resend' ? RESEND_API_KEY : BREVO_API_KEY;
    if (!key) {
      console.warn(`[outbound] ${OUTBOUND_PROVIDER} selected but ${envName} is missing — /api/send will answer 503`);
      return { provider: OUTBOUND_PROVIDER, configured: false, problems: [`${envName} is not set`] };
    }
    console.log(`[outbound] using ${OUTBOUND_PROVIDER} HTTP API`);
    return { provider: OUTBOUND_PROVIDER, configured: true, problems: [] };
  }
  const problem = `OUTBOUND_PROVIDER "${OUTBOUND_PROVIDER}" must be smtp, resend or brevo`;
  console.warn(`[outbound] ${problem} — /api/send will answer 503`);
  return { provider: OUTBOUND_PROVIDER, configured: false, problems: [problem] };
}
const OUTBOUND_STATUS = validateOutboundConfig();

// --- Outbound send path (POST /api/send) ---
// The nodemailer transport is created lazily from the relay env and cached;
// setSendTransport() swaps it for a stub in tests.
let sendTransport = null;

function getSendTransport() {
  if (sendTransport) return sendTransport;
  if (RELAY_STATUS.status !== 'configured') return null;
  const nodemailer = require('nodemailer');
  sendTransport = nodemailer.createTransport({
    host: SMTP_RELAY_HOST,
    port: SMTP_RELAY_PORT,
    secure: SMTP_RELAY_PORT === 465,
    auth: SMTP_RELAY_USER ? { user: SMTP_RELAY_USER, pass: SMTP_RELAY_PASS } : undefined,
    // Transport-level DKIM options are domainName/keySelector (the mail-level
    // ones are domain/selector); with the wrong names the signature is emitted
    // with an empty d=.
    dkim: DKIM_STATUS.status === 'configured'
      ? { domainName: DKIM_DOMAIN, keySelector: DKIM_SELECTOR, privateKey: DKIM_PRIVATE_KEY }
      : undefined,
  });
  return sendTransport;
}

// Test hook: replace the live relay transport with a stub (or null to
// restore lazy creation from env).
function setSendTransport(t) { sendTransport = t || null; }

// How long a relay probe may take before it is reported as a timeout.
const RELAY_PROBE_TIMEOUT_MS = numEnv('RELAY_PROBE_TIMEOUT_MS', 10000);

// Live-check the outbound path WITHOUT sending any mail. SMTP: nodemailer
// transport.verify() opens the connection and runs EHLO, then closes it —
// no message is ever sent. HTTP providers (Resend/Brevo) have no read-only
// probe, so they report "not-probed" honestly instead of faking a check.
// `transport` / `provider` / `configured` / `problems` are overridable so
// unit tests can drive the probe without a real relay.
async function probeRelay({ timeoutMs = RELAY_PROBE_TIMEOUT_MS, transport, provider = OUTBOUND_PROVIDER, configured = OUTBOUND_STATUS.configured, problems = OUTBOUND_STATUS.problems } = {}) {
  const base = { provider, configured, problems };
  if (provider !== 'smtp') {
    return { ...base, probe: 'not-probed', detail: `no read-only probe for the ${provider} HTTP API` };
  }
  if (!configured) {
    return { ...base, probe: 'skipped', detail: 'relay is not configured' };
  }
  const t = transport || getSendTransport();
  if (!t || typeof t.verify !== 'function') {
    return { ...base, probe: 'error', detail: 'no SMTP transport available' };
  }
  try {
    const ok = await Promise.race([
      t.verify(),
      sleep(timeoutMs).then(() => { throw new Error(`relay probe timed out after ${timeoutMs}ms`); }),
    ]);
    if (!ok) return { ...base, probe: 'error', detail: 'relay rejected the connection (verify returned false)' };
    return { ...base, probe: 'ok', detail: `SMTP relay ${SMTP_RELAY_HOST}:${SMTP_RELAY_PORT} answered EHLO` };
  } catch (err) {
    return { ...base, probe: 'error', detail: err.message };
  }
}

// Build the provider-specific HTTP request. Pure, so the wire shape of both
// providers is unit-testable without network access.
function buildOutboundRequest(provider, { from, fromName, to, subject, text, html }, config = {}) {
  const name = String(fromName || '').replace(/["\\\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (provider === 'resend') {
    return {
      url: `${config.apiBase || RESEND_API_BASE}/emails`,
      headers: {
        authorization: `Bearer ${config.apiKey || RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: {
        from: name ? `${name} <${from}>` : from,
        to,
        subject: subject || '(no subject)',
        ...(text ? { text } : {}),
        ...(html ? { html } : {}),
      },
    };
  }
  if (provider === 'brevo') {
    return {
      url: `${config.apiBase || BREVO_API_BASE}/v3/smtp/email`,
      headers: {
        'api-key': config.apiKey || BREVO_API_KEY,
        'content-type': 'application/json',
      },
      body: {
        sender: { email: from, ...(name ? { name } : {}) },
        to: to.map(email => ({ email })),
        subject: subject || '(no subject)',
        ...(text ? { textContent: text } : {}),
        ...(html ? { htmlContent: html } : {}),
      },
    };
  }
  throw new Error(`Unsupported outbound provider: ${provider}`);
}

// Test hook: swap the HTTP client used for provider sends.
let providerFetch = (...args) => fetch(...args);
function setProviderFetch(fn) { providerFetch = typeof fn === 'function' ? fn : (...args) => fetch(...args); }

async function sendViaProvider(msg) {
  const req = buildOutboundRequest(OUTBOUND_PROVIDER, msg);
  const res = await providerFetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  const raw = await res.text().catch(() => '');
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = {}; }
  }
  if (!res.ok) {
    const detail = payload.message || (payload.error && payload.error.message) || raw.slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`${OUTBOUND_PROVIDER} API ${res.status}: ${detail}`);
    err.status = res.status === 429 ? 429 : 502;
    throw err;
  }
  return { messageId: payload.id || payload.messageId || null, accepted: msg.to, rejected: [] };
}

const MAX_SEND_RECIPIENTS = 10;
const MAX_SEND_BODY_CHARS = 100000;
const MAX_SEND_SUBJECT_CHARS = 1000;

// Validate + normalize a POST /api/send body.
// Returns { ok: true, value: { from, to, subject, text, html } }
// or { ok: false, error }.
function validateSendBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const from = typeof body.from === 'string' ? body.from.trim().toLowerCase() : '';
  if (!validAddressParam(from)) {
    return { ok: false, error: 'from must be a valid email address' };
  }
  let to = body.to;
  if (typeof to === 'string') to = [to];
  if (!Array.isArray(to) || to.length === 0) {
    return { ok: false, error: 'to is required (address or array of addresses)' };
  }
  if (to.length > MAX_SEND_RECIPIENTS) {
    return { ok: false, error: `at most ${MAX_SEND_RECIPIENTS} recipients per send` };
  }
  const recipients = [];
  for (const r of to) {
    const addr = typeof r === 'string' ? r.trim().toLowerCase() : '';
    if (!validAddressParam(addr)) {
      return { ok: false, error: `to contains an invalid address: ${String(r).slice(0, 80)}` };
    }
    recipients.push(addr);
  }
  const subject = body.subject === undefined || body.subject === null ? '' : String(body.subject);
  if (subject.length > MAX_SEND_SUBJECT_CHARS) {
    return { ok: false, error: 'subject is too long' };
  }
  const text = body.text === undefined || body.text === null ? '' : String(body.text);
  const html = body.html === undefined || body.html === null ? '' : String(body.html);
  if (!text && !html) {
    return { ok: false, error: 'text or html body is required' };
  }
  if (text.length > MAX_SEND_BODY_CHARS || html.length > MAX_SEND_BODY_CHARS) {
    return { ok: false, error: 'message body is too long' };
  }
  const rawFromName = body.fromName === undefined || body.fromName === null ? '' : String(body.fromName);
  if (rawFromName.length > 120) {
    return { ok: false, error: 'fromName is too long' };
  }
  // Strip characters that could break or inject a header.
  const fromName = rawFromName.replace(/["\\\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return { ok: true, value: { from, fromName, to: recipients, subject, text, html: html || undefined } };
}

// Core outbound send. Throws an Error with .status for HTTP mapping.
// The From address must be one this service created (in the address
// registry) and, for account keys, one the caller owns; foreign From values
// are rejected so the service can never be used to send mail as someone else.
async function sendAgentMail({ from, fromName, to, subject, text, html }, actor) {
  const role = actor && actor.role ? actor.role : 'master';
  const owner = await ownershipFor(from);
  if (owner === undefined) {
    const err = new Error('from address was not created by this service');
    err.status = 403;
    throw err;
  }
  if (role !== 'master' && (!actor || !actor.account || owner !== actor.account.id)) {
    const err = new Error('from address is owned by another account');
    err.status = 403;
    throw err;
  }
  if (rateLimitExceeded(`send:${from}`, SEND_MAX_PER_HOUR)) {
    const err = new Error('Send rate limit exceeded for this address');
    err.status = 429;
    throw err;
  }
  if (SEND_MAX_PER_DAY > 0 && !rateLimitWindow('send:day:all', SEND_MAX_PER_DAY, 24 * 60 * 60 * 1000)) {
    const err = new Error(`Daily send cap reached (${SEND_MAX_PER_DAY} per day across all agents)`);
    err.status = 429;
    throw err;
  }
  if (OUTBOUND_PROVIDER !== 'smtp' && !OUTBOUND_STATUS.configured) {
    const detail = OUTBOUND_STATUS.problems[0] || `${OUTBOUND_PROVIDER} is not configured`;
    const err = new Error(`Outbound is not configured: ${detail}`);
    err.status = 503;
    throw err;
  }
  try {
    let info;
    if (OUTBOUND_PROVIDER === 'smtp') {
      const transport = getSendTransport();
      if (!transport) {
        const err = new Error(`Outbound relay is not configured (status: ${RELAY_STATUS.status})`);
        err.status = 503;
        throw err;
      }
      info = await transport.sendMail({ from, to, subject, text, html });
    } else {
      info = await sendViaProvider({ from, fromName, to, subject, text, html });
    }
    console.log(JSON.stringify({
      level: 'info', type: 'outbound-send', provider: OUTBOUND_PROVIDER,
      from, to, messageId: info.messageId || null,
    }));
    return {
      provider: OUTBOUND_PROVIDER,
      messageId: info.messageId || null,
      accepted: info.accepted || to,
      rejected: info.rejected || [],
    };
  } catch (err) {
    if (err.status === 429) throw err;
    console.error(`[outbound:${OUTBOUND_PROVIDER}] send failed for ${from}: ${err.message}`);
    const wrapped = new Error(`Send failed: ${err.message}`);
    wrapped.status = err.status || 502;
    throw wrapped;
  }
}

// --- Storage backend: Supabase if configured, else in-memory ---
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  console.log('[storage] using Supabase agent_emails table');
} else {
  console.log('[storage] SUPABASE_URL/SUPABASE_SERVICE_KEY not set, using in-memory storage');
}
const useSupabase = !!supabase;

// --- Accounts: one free, isolated mailbox per agent ---
// Each account holds one API key and only its SHA-256 hash is stored, so a
// database leak never exposes a working credential. The key is shown once,
// at signup. `master` is the reserved owner of addresses created with
// AGENT_MAIL_TOKEN; it is never a real account.
const API_KEY_PREFIX = 'am_';
const accountByHash = new Map(); // hash -> { at, account } (Supabase cache)
const accountsById = new Map(); // in-memory fallback
const ACCOUNT_CACHE_MS = 60 * 1000;

function newApiKey() {
  return API_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    plan: a.plan,
    createdAt: a.createdAt,
    addressQuota: a.addressQuota,
  };
}

function accountFromRow(row) {
  return {
    id: row.id,
    name: row.name || 'agent',
    plan: row.plan || 'free',
    apiKeyHash: row.api_key_hash,
    apiKeyPrefix: row.api_key_prefix || '',
    createdAt: row.created_at,
    addressQuota: Number(row.address_quota) || ADDRESS_QUOTA_PER_ACCOUNT,
  };
}

// Mint an account + its one-and-only API key (not persisted).
function newAccountRow({ name } = {}) {
  const apiKey = newApiKey();
  const now = new Date().toISOString();
  const account = {
    id: `acct_${crypto.randomBytes(8).toString('hex')}`,
    name: String(name || 'agent').replace(/[^A-Za-z0-9 ._@-]/g, '').trim().slice(0, 60) || 'agent',
    plan: 'free',
    apiKeyHash: hashApiKey(apiKey),
    apiKeyPrefix: apiKey.slice(0, API_KEY_PREFIX.length + 6),
    createdAt: now,
    addressQuota: ADDRESS_QUOTA_PER_ACCOUNT,
  };
  return { account, apiKey };
}

async function createAccount({ name } = {}) {
  const { account, apiKey } = newAccountRow({ name });
  if (useSupabase) {
    const { error } = await supabase.from('agent_accounts').insert({
      id: account.id,
      name: account.name,
      plan: account.plan,
      api_key_hash: account.apiKeyHash,
      api_key_prefix: account.apiKeyPrefix,
      created_at: account.createdAt,
      address_quota: account.addressQuota,
    });
    if (error) throw new Error(`account store failed (run supabase-migration.sql): ${error.message}`);
  } else {
    accountsById.set(account.id, account);
  }
  accountByHash.set(account.apiKeyHash, { at: Date.now(), account });
  console.log(JSON.stringify({ level: 'info', type: 'account-created', id: account.id }));
  return { account, apiKey };
}

async function findAccountByKeyHash(hash) {
  const cached = accountByHash.get(hash);
  if (cached && Date.now() - cached.at < ACCOUNT_CACHE_MS) return cached.account;
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_accounts')
      .select('*')
      .eq('api_key_hash', hash)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const account = accountFromRow(data);
    accountByHash.set(hash, { at: Date.now(), account });
    return account;
  }
  for (const account of accountsById.values()) {
    if (account.apiKeyHash === hash) return account;
  }
  return null;
}

async function allAccounts() {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_accounts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    return (data || []).map(accountFromRow);
  }
  return [...accountsById.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function countAccounts() {
  if (useSupabase) {
    const { count, error } = await supabase
      .from('agent_accounts')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  }
  return accountsById.size;
}

async function accountAddressCount(accountId) {
  if (useSupabase) {
    const { count, error } = await supabase
      .from('agent_addresses')
      .select('address', { count: 'exact', head: true })
      .eq('account_id', accountId);
    if (error) throw error;
    return count || 0;
  }
  let n = 0;
  for (const meta of addressRegistry.values()) {
    if (meta.accountId === accountId) n++;
  }
  return n;
}

async function listAccountsWithUsage() {
  const accounts = await allAccounts();
  return Promise.all(accounts.map(async a => ({
    ...publicAccount(a),
    apiKeyPrefix: a.apiKeyPrefix,
    addresses: await accountAddressCount(a.id).catch(() => 0),
  })));
}

// In-memory fallback: address -> [{ id, from, subject, date, text, links, attachments }]
const inboxes = new Map();

// --- Address registry: owner + creation/last activity (TTL cleanup) ---
// address -> { accountId, createdAt, lastSeenAt }. accountId is undefined
// while ownership is unknown, null for catch-all mail nobody claimed,
// OWNER_MASTER for addresses created with the master token, else an account id.
const addressRegistry = new Map();

// Persist an address (and its owner) when Supabase is configured, so
// ownership survives restarts. Fire-and-forget: mail never waits on it.
async function persistAddress(address, accountId) {
  if (!useSupabase) return;
  const now = new Date().toISOString();
  // Insert-if-absent first, so an existing row keeps its created_at and
  // owner. `ignoreDuplicates` makes this ON CONFLICT DO NOTHING.
  const { error } = await supabase.from('agent_addresses')
    .upsert({ address, last_seen_at: now }, { onConflict: 'address', ignoreDuplicates: true });
  if (error) throw error;
  const patch = { last_seen_at: now };
  if (typeof accountId === 'string' && accountId) patch.account_id = accountId;
  const { error: updateError } = await supabase.from('agent_addresses')
    .update(patch).eq('address', address);
  if (updateError) throw updateError;
}

function registerAddress(address, accountId) {
  const now = new Date().toISOString();
  const entry = addressRegistry.get(address);
  if (entry) {
    entry.lastSeenAt = now;
    if (entry.accountId === undefined && accountId !== undefined) entry.accountId = accountId;
  } else {
    addressRegistry.set(address, { accountId, createdAt: now, lastSeenAt: now });
  }
  persistAddress(address, accountId).catch(err => {
    console.warn(`[storage] address persist failed for ${address}: ${err.message}`);
  });
}

// Who owns this address? An account id, OWNER_MASTER, null (unowned), or
// undefined (unknown to this service). Supabase rows are authoritative after
// a restart; the result is cached in the registry.
async function ownershipFor(address) {
  const meta = addressRegistry.get(address);
  if (meta && meta.accountId !== undefined) return meta.accountId;
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_addresses').select('account_id').eq('address', address).maybeSingle();
    if (error) throw error;
    if (data) {
      const owner = data.account_id || null;
      if (meta) meta.accountId = owner;
      else addressRegistry.set(address, {
        accountId: owner,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });
      return owner;
    }
  }
  return meta ? null : undefined;
}

// An address is visible to the master token, or to the account that owns it.
// Foreign addresses answer 404 so an account cannot probe for others' mail.
async function canAccessAddress(req, address) {
  if (req.auth && req.auth.role === 'master') return true;
  if (!req.auth || !req.auth.account) return false;
  const owner = await ownershipFor(address);
  return typeof owner === 'string' && owner === req.auth.account.id;
}

function addressInfo(address) {
  const meta = addressRegistry.get(address);
  if (!meta) return null;
  return {
    address,
    createdAt: meta.createdAt,
    lastSeenAt: meta.lastSeenAt,
    emails: (inboxes.get(address) || []).length,
  };
}

// --- Arrival events: long-poll waiters wake the instant mail is stored ---
const { EventEmitter } = require('events');
const mailEvents = new EventEmitter();
mailEvents.setMaxListeners(0);

// Resolve on the next stored mail for `address`, or after `ms` (whichever is
// first). The timer is the fallback for mail stored by another instance.
function waitForArrival(address, ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); mailEvents.off(address, done); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    mailEvents.once(address, done);
  });
}

// --- Duplicate suppression: a forwarder that retries a delivery (or mirrors
// it over both SMTP and HTTP) must not store the same message twice. Keyed by
// address + Message-ID; messages without a Message-ID are never deduped. ---
const seenMessages = new Map(); // key -> stored email id (bounded, oldest evicted)
const SEEN_MAX = 5000;
function seenKey(address, messageId) {
  const id = String(messageId || '').trim().replace(/^<|>$/g, '');
  return id ? `${address}|${id}` : '';
}
function rememberMessage(key, id) {
  if (!key) return;
  seenMessages.set(key, id);
  if (seenMessages.size > SEEN_MAX) seenMessages.delete(seenMessages.keys().next().value);
}

// --- Sliding-window rate limiter (per key, events per rolling hour) ---
const rateBuckets = new Map(); // key -> [timestamps]

function rateLimitExceeded(key, maxPerHour) {
  if (maxPerHour <= 0) return false; // 0 disables
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  let hits = rateBuckets.get(key) || [];
  hits = hits.filter(t => now - t < windowMs);
  if (hits.length >= maxPerHour) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}

// --- Fixed-window rate limiter (origin, per IP per minute) ---
const bucketState = new Map();
function rateLimitWindow(key, max, windowMs) {
  const now = Date.now();
  const entry = bucketState.get(key) || { count: 0, resetAt: now + windowMs };
  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  bucketState.set(key, entry);
  return entry.count <= max;
}
// --- Quota usage reporting (read-only peek at the rate buckets) ---
// rateLimitExceeded() mutates (it records a hit); these peeks never do, so
// an agent can ask "how much quota do I have left?" without spending any.
// resetAt is when the oldest hit in the current window ages out; null when
// nothing has been used in this window. A limit of 0 means disabled:
// `remaining` is null (unlimited) and `used` still counts activity.
function rateBucketUsage(key, maxPerHour, now = Date.now()) {
  const windowMs = 60 * 60 * 1000;
  const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  const used = hits.length;
  const resetAt = hits.length ? new Date(hits[0] + windowMs).toISOString() : null;
  if (maxPerHour <= 0) return { limit: 0, used, remaining: null, resetAt };
  return { limit: maxPerHour, used, remaining: Math.max(0, maxPerHour - used), resetAt };
}

// Fixed-window bucket peek (the global daily send cap and per-IP minute
// limits live here, not in rateBuckets).
function windowBucketUsage(key) {
  const entry = bucketState.get(key);
  if (!entry) return { count: 0, resetAt: null };
  return { count: entry.count, resetAt: new Date(entry.resetAt).toISOString() };
}

// Send/receive quota + mailbox stats for one address. Unknown addresses
// report null timestamps and zero counts rather than erroring, so a caller
// can probe quota for an address it is about to use.
function quotaForAddress(address) {
  const info = addressInfo(address);
  return {
    address,
    createdAt: info ? info.createdAt : null,
    lastSeenAt: info ? info.lastSeenAt : null,
    emails: info ? info.emails : 0,
    sendPerHour: rateBucketUsage(`send:${address}`, SEND_MAX_PER_HOUR),
    receivePerHour: rateBucketUsage(`recv:${address}`, EMAILS_PER_ADDRESS_PER_HOUR),
  };
}

function addressRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimitWindow(`addr:${ip}`, RATE_LIMIT_PER_MINUTE, 60000)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded — try again in a minute' });
  }
  next();
}

// Globally unique email ids (safe across restarts and storage backends)
function newId() {
  return `em_${crypto.randomUUID().replace(/-/g, '')}`;
}

// --- Retry queue + dead letters for failed stores (origin) ---
const MAX_STORE_ATTEMPTS = 5;
const retryQueue = []; // [{ email, attempts, nextRetryAt }]
const deadLetters = []; // [{ id, address, from, subject, attempts, lastError, deadAt }] (bounded 100)

function backoffMs(attempt) {
  // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s (+ up to 25% jitter), capped at 60s.
  const base = Math.min(60000, 1000 * 2 ** attempt);
  return Math.round(base * (1 + Math.random() * 0.25));
}

function recordDeadLetter(email, lastError) {
  deadLetters.push({
    id: newId(),
    address: email.address,
    from: email.from,
    subject: email.subject,
    attempts: MAX_STORE_ATTEMPTS,
    lastError: String(lastError && lastError.message || lastError),
    deadAt: new Date().toISOString(),
  });
  if (deadLetters.length > 100) deadLetters.shift();
  console.error(`[storage] dead-lettered mail for ${email.address}: ${lastError && lastError.message}`);
}

function scheduleRetry(email, err, attempts) {
  if (attempts >= MAX_STORE_ATTEMPTS) {
    recordDeadLetter(email, err);
    return;
  }
  retryQueue.push({ email, attempts, nextRetryAt: Date.now() + backoffMs(attempts) });
}

setInterval(async () => {
  if (!retryQueue.length) return;
  const now = Date.now();
  const due = retryQueue.filter(j => j.nextRetryAt <= now);
  if (!due.length) return;
  for (const job of due) {
    const i = retryQueue.indexOf(job);
    if (i !== -1) retryQueue.splice(i, 1);
    try {
      await storeEmailRaw(job.email);
      mailEvents.emit(job.email.address);
      console.log(`[storage] retry succeeded for ${job.email.address} (attempt ${job.attempts + 1})`);
    } catch (err) {
      scheduleRetry(job.email, err, job.attempts + 1);
    }
  }
}, 1000).unref();

// --- Request ids + structured request logging (origin) ---
app.use((req, res, next) => {
  req.id = crypto.randomUUID().slice(0, 8);
  const started = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      level: 'info', type: 'http', req: req.id,
      method: req.method, path: req.path,
      status: res.statusCode, ms: Date.now() - started,
    }));
  });
  next();
});

// --- Incoming-mail webhook (fire-and-forget, HMAC-signed) ---
async function fireIncomingWebhook({ address, email }) {
  if (!WEBHOOK_URL) return;
  const payload = {
    event: 'mail.received',
    address,
    receivedAt: new Date().toISOString(),
    email: {
      id: email.id,
      from: email.from,
      subject: email.subject,
      date: email.date,
      links: email.links || [],
      attachments: (email.attachments || []).map(a => ({
        filename: a.filename, contentType: a.contentType, size: a.size,
      })),
    },
  };
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-AgentMail-Event': 'mail.received' };
  if (WEBHOOK_SECRET) {
    headers['X-AgentMail-Signature'] =
      'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST', headers, body, signal: ctrl.signal,
    });
    if (!res.ok) console.error(`[webhook] delivery failed: HTTP ${res.status} for ${address}`);
  } catch (err) {
    console.error(`[webhook] delivery error for ${address}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// --- Address TTL sweep: purge stale addresses (memory) and old mail rows ---
async function sweepExpiredAddresses() {
  if (ADDRESS_TTL_HOURS <= 0) return { removed: 0, rows: 0 };
  const cutoff = new Date(Date.now() - ADDRESS_TTL_HOURS * 60 * 60 * 1000);
  let removed = 0;
  for (const [addr, meta] of addressRegistry) {
    if (Date.parse(meta.lastSeenAt) <= cutoff.getTime()) {
      addressRegistry.delete(addr);
      inboxes.delete(addr);
      rateBuckets.delete(`recv:${addr}`);
      rateBuckets.delete(`send:${addr}`);
      removed++;
    }
  }
  // Drop expired per-IP counters so a long-running service does not grow
  // them without bound.
  for (const [key, entry] of bucketState) {
    if (entry.resetAt < Date.now() - 60 * 60 * 1000) bucketState.delete(key);
  }
  let rows = 0;
  if (useSupabase) {
    const { error, count } = await supabase
      .from('agent_emails')
      .delete({ count: 'exact' })
      .lt('created_at', cutoff.toISOString());
    if (error) {
      console.error('[ttl] supabase cleanup error:', error.message);
    } else {
      rows = count || 0;
    }
    // Retire the address rows too, so ownership of a dead address is not
    // kept forever (ignored when the migration has not been applied).
    await supabase.from('agent_addresses')
      .delete().lt('last_seen_at', cutoff.toISOString())
      .then(r => r.error && console.error('[ttl] address cleanup error:', r.error.message))
      .catch(() => {});
  }
  if (removed || rows) console.log(`[ttl] swept ${removed} address(es), ${rows} old row(s)`);
  return { removed, rows };
}

if (ADDRESS_TTL_HOURS > 0 && ADDRESS_SWEEP_MS > 0) {
  setInterval(() => {
    sweepExpiredAddresses().catch(err => console.error('[ttl] sweep error:', err.message));
  }, ADDRESS_SWEEP_MS).unref();
  console.log(`[ttl] address sweep every ${Math.round(ADDRESS_SWEEP_MS / 1000)}s, TTL ${ADDRESS_TTL_HOURS}h`);
} else {
  console.log('[ttl] address TTL sweep disabled');
}

// Local part of an address: 1-64 chars from the RFC-allowed set, no
// leading/trailing dot, no consecutive dots. A prefix that violates any of
// these used to be created anyway and then failed every later read (the
// inbox routes validate the full address), so the address was unusable
// from birth.
function validLocalPart(local) {
  return typeof local === 'string'
    && local.length >= 1 && local.length <= 64
    && /^[a-z0-9._%+-]+$/.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

// Validate an address path parameter: local@domain shape, bounded length.
// Domain: labels of 1-63 chars, no leading/trailing hyphen, TLD 2-63 alpha.
function validAddressParam(addr) {
  if (typeof addr !== 'string' || addr.length === 0 || addr.length > 254) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@') || at === addr.length - 1) return false;
  if (!validLocalPart(addr.slice(0, at))) return false;
  const domain = addr.slice(at + 1);
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return false;
  return true;
}

// Normalize a requested address prefix into a safe local part: lowercase,
// drop characters outside the allowed set, collapse runs of dots, strip
// leading/trailing dots and hyphens. Returns '' when nothing usable
// remains (the caller falls back to a generated prefix).
function normalizeAddressPrefix(prefix) {
  return String(prefix || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 64);
}

// Normalize a Supabase row or in-memory object to the API email shape
function toEmailShape(e) {
  return {
    id: e.id,
    from: e.from_addr !== undefined ? e.from_addr : e.from,
    subject: e.subject || '',
    date: e.date || e.created_at || new Date().toISOString(),
    // When THIS service stored it (the Date header is sender-controlled and
    // can be skewed); `since` filters compare against this.
    receivedAt: e.created_at || e.receivedAt || e.date || new Date().toISOString(),
    text: e.text_body !== undefined ? e.text_body : (e.text || ''),
    links: e.links || [],
    // One-time codes are derived on read (no schema change needed), so mail
    // stored before this feature existed gets codes too.
    codes: extractCodes(e.subject || '', e.text_body !== undefined ? e.text_body : (e.text || '')),
    // Attachment METADATA only (filename, type, size) — never content.
    attachments: e.attachments || [],
  };
}

// Raw store without retry bookkeeping (used by both the direct path and retries).
async function storeEmailRaw(record) {
  const { address, from, subject, date, text, links } = record;
  const attachments = record.attachments || [];
  if (useSupabase) {
    const row = {
      id: record.id || newId(),
      address,
      from_addr: from,
      subject,
      date,
      text_body: text,
      links,
      attachments,
    };
    let { error } = await supabase.from('agent_emails').insert(row);
    if (error && /attachments/i.test(error.message || '')) {
      // Older DB without the attachments column (pre-migration): store
      // without it rather than dropping the email. Run the ALTER TABLE in
      // supabase-migration.sql to keep attachment metadata.
      console.warn('[storage] attachments column missing, storing email without attachment metadata');
      delete row.attachments;
      ({ error } = await supabase.from('agent_emails').insert(row));
    }
    if (error) throw error;
    return { ...record, id: row.id, attachments };
  }
  if (!inboxes.has(address)) inboxes.set(address, []);
  const emails = inboxes.get(address);
  const stored = {
    id: record.id || newId(),
    from, subject, date, text, links, attachments,
    receivedAt: new Date().toISOString(),
  };
  emails.push(stored);
  // Keep inbox bounded, and prune entries older than the retention window.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  while (emails.length && new Date(emails[0].date).getTime() < cutoff) emails.shift();
  if (emails.length > 50) emails.splice(0, emails.length - 50);
  return stored;
}

async function storeEmail(email) {
  const record = { ...email, id: email.id || newId(), attachments: email.attachments || [] };
  try {
    const stored = await storeEmailRaw(record);
    mailEvents.emit(record.address);
    return stored;
  } catch (err) {
    scheduleRetry(record, err, 1);
    throw err;
  }
}

// Newest first, with optional search + BOTH pagination styles.
// Precedence: explicit limit/offset win; otherwise page/perPage are used.
// Returns { emails, total, page, perPage, pages, limit, offset }.
async function listEmails(address, { q = '', from = '', since, page, perPage, limit, offset } = {}) {
  q = String(q || '').toLowerCase();
  from = String(from || '').toLowerCase();

  async function fetchAll() {
    if (useSupabase) {
      const { data, error } = await supabase
        .from('agent_emails')
        .select('id, address, from_addr, subject, date, text_body, links, attachments, created_at')
        .eq('address', address)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []).map(toEmailShape);
    }
    const emails = inboxes.get(address) || [];
    return emails.slice().reverse().map(toEmailShape);
  }

  let emails = await fetchAll();
  if (q) {
    emails = emails.filter(e =>
      e.subject.toLowerCase().includes(q) ||
      String(e.from || '').toLowerCase().includes(q) ||
      String(e.text || '').toLowerCase().includes(q));
  }
  if (from) {
    emails = emails.filter(e => String(e.from || '').toLowerCase().includes(from));
  }
  if (since) {
    // "Only mail newer than this" — lets a caller ignore whatever was already
    // in the inbox before it triggered a new verification email.
    const t = Date.parse(since);
    if (!Number.isNaN(t)) emails = emails.filter(e => Date.parse(e.receivedAt || e.date) > t);
  }
  const total = emails.length;

  let effLimit, effOffset, effPage, effPerPage, pages;
  if (limit !== undefined || offset !== undefined) {
    effLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    effOffset = Math.max(0, parseInt(offset, 10) || 0);
    effPerPage = effLimit;
    pages = Math.max(1, Math.ceil(total / effLimit));
    effPage = Math.floor(effOffset / effLimit) + 1;
  } else {
    effPerPage = Math.min(100, Math.max(1, parseInt(perPage, 10) || 20));
    const reqPage = Math.max(1, parseInt(page, 10) || 1);
    pages = Math.max(1, Math.ceil(total / effPerPage));
    effPage = Math.min(reqPage, pages);
    effLimit = effPerPage;
    effOffset = (effPage - 1) * effPerPage;
  }
  const slice = emails.slice(effOffset, effOffset + effLimit);
  return { emails: slice, total, page: effPage, perPage: effPerPage, pages, limit: effLimit, offset: effOffset };
}

async function getEmail(address, id) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_emails')
      .select('id, address, from_addr, subject, date, text_body, links, attachments, created_at')
      .eq('address', address)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return data ? toEmailShape(data) : null;
  }
  const emails = inboxes.get(address) || [];
  const email = emails.find(e => e.id === id);
  return email ? toEmailShape(email) : null;
}

async function clearInbox(address) {
  if (useSupabase) {
    const { error } = await supabase.from('agent_emails').delete().eq('address', address);
    if (error) throw error;
    return;
  }
  inboxes.set(address, []);
}

// Every address this service knows about, with mail counts. The in-process
// registry is lost on restart (Render free instances sleep after 15 idle
// minutes), so with Supabase the list is rebuilt from stored mail and then
// merged with addresses created since boot that have no mail yet.
async function knownAddresses(actor) {
  const master = !actor || actor.role === 'master';
  const accountId = master ? null : actor.account.id;
  const out = new Map(); // address -> { address, accountId, createdAt, lastSeenAt, emails }

  if (useSupabase) {
    let q = supabase
      .from('agent_addresses')
      .select('address, account_id, created_at, last_seen_at')
      .order('last_seen_at', { ascending: false })
      .limit(5000);
    if (!master) q = q.eq('account_id', accountId);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data || []) {
      out.set(r.address, {
        address: r.address,
        accountId: r.account_id || null,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        emails: 0,
      });
    }
  }

  for (const [address, meta] of addressRegistry) {
    if (!master && meta.accountId !== accountId) continue;
    const cur = out.get(address);
    if (cur) {
      if (meta.createdAt && (!cur.createdAt || meta.createdAt < cur.createdAt)) cur.createdAt = meta.createdAt;
      if (meta.lastSeenAt && (!cur.lastSeenAt || meta.lastSeenAt > cur.lastSeenAt)) cur.lastSeenAt = meta.lastSeenAt;
      if (cur.accountId == null && meta.accountId) cur.accountId = meta.accountId;
    } else {
      out.set(address, {
        address,
        accountId: meta.accountId === undefined ? null : meta.accountId,
        createdAt: meta.createdAt,
        lastSeenAt: meta.lastSeenAt,
        emails: (inboxes.get(address) || []).length,
      });
    }
  }

  // Legacy rows: mail stored before the address table existed, plus catch-all
  // mail to an address nobody claimed. Only the master token may see those.
  if (master && useSupabase) {
    const { data, error } = await supabase
      .from('agent_emails')
      .select('address, created_at')
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    for (const r of data || []) {
      const cur = out.get(r.address);
      if (cur) {
        cur.emails++;
        if (!cur.createdAt) cur.createdAt = r.created_at;
      } else {
        out.set(r.address, {
          address: r.address,
          accountId: null,
          createdAt: r.created_at,
          lastSeenAt: r.created_at,
          emails: 1,
        });
      }
    }
    return [...out.values()].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
  }

  if (useSupabase) {
    // Count mail per address in a few batched reads instead of one query each.
    const addrs = [...out.keys()];
    const counts = new Map();
    for (let i = 0; i < addrs.length; i += 200) {
      const chunk = addrs.slice(i, i + 200);
      const { data, error } = await supabase
        .from('agent_emails')
        .select('address')
        .in('address', chunk)
        .limit(20000);
      if (error) throw error;
      for (const r of data || []) counts.set(r.address, (counts.get(r.address) || 0) + 1);
    }
    for (const [address, info] of out) info.emails = counts.get(address) || 0;
  }

  return [...out.values()].sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
}

async function countAddresses(actor) {
  return (await knownAddresses(actor || { role: 'master' })).length;
}

// Resolve a request's Bearer credential to the master key or an account.
async function resolveAuth(req) {
  const header = req.headers.authorization;
  if (bearerOk(header, TOKEN)) return { role: 'master' };
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!m) return null;
  const account = await findAccountByKeyHash(hashApiKey(m[1]));
  return account ? { role: 'account', account } : null;
}

function auth(req, res, next) {
  resolveAuth(req)
    .then(who => {
      if (!who) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      req.auth = who;
      next();
    })
    .catch(err => {
      console.error(`[auth] ${err.message}`);
      res.status(500).json({ ok: false, error: 'Auth lookup failed' });
    });
}

function requireMaster(req, res, next) {
  if (!req.auth || req.auth.role !== 'master') {
    return res.status(403).json({ ok: false, error: 'Master token required' });
  }
  next();
}

// Constant-time bearer check (mirrors error-inbox's bearerMatches).
function bearerOk(header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

// Decode the HTML entities that show up in mail bodies and href values.
function decodeEntities(str) {
  return String(str || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&amp;/gi, '&');
}
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

// Plain-text fallback for deliveries that carry only HTML. Block tags become
// line breaks so a code on its own row stays on its own line.
function htmlToText(html) {
  const text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|th|h\d|li|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t ​‌‍﻿]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    // Single-line input stays single-line (old behaviour callers rely on).
    .replace(/^[^\n]*$/, m => m.replace(/\s+/g, ' '));
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
// Never useful to an agent: static assets, tracking pixels, list management.
const JUNK_LINK = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf)(\?|#|$)|unsubscribe|list-manage|\/opt-?out|email-preferences|\/preferences|\/pixel|\/open\?|\/track\/open|w3\.org\/|schema\.org/i;
const SOCIAL_LINK = /^https?:\/\/(www\.)?(facebook|twitter|x|instagram|linkedin|youtube|tiktok|apple|play\.google)\.com\//i;
const VERIFY_STRONG = /verif|confirm|activat|validat|magic[-_]?link|reset|one[-_]?time|otp|email[-_]?link|\/auth\/|callback|token=|code=|signup\/complete|ticket=/i;
const VERIFY_WEAK = /sign[-_]?in|log[-_]?in|auth|invite|accept|welcome|continue|complete|click/i;

// Extract URLs. `html` (optional) is mined for href values first, since a
// verification link often exists ONLY in an <a href> (the visible text says
// "Verify email"), with entities decoded so `&amp;` does not corrupt the query
// string. Bare URLs in the text follow; trailing sentence punctuation is
// trimmed. Order is preserved and duplicates removed.
function extractLinks(text, html) {
  const found = [];
  const add = u => {
    const url = String(u || '').trim().replace(/[.,;:!?]+$/, '');
    if (/^https?:\/\/[^\s]+$/i.test(url) && url.length <= 2000 && !found.includes(url)) found.push(url);
  };
  if (html) {
    for (const m of String(html).matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) add(decodeEntities(m[1] || m[2]));
  }
  for (const m of String(text || '').match(URL_RE) || []) add(m);
  return found.slice(0, 50);
}

// Higher = more likely to be THE link the email wants clicked. Junk scores
// below zero so it is never chosen while any real link exists.
function scoreLink(url) {
  if (JUNK_LINK.test(url)) return -10;
  let score = 0;
  if (VERIFY_STRONG.test(url)) score += 10;
  else if (VERIFY_WEAK.test(url)) score += 4;
  if (SOCIAL_LINK.test(url)) score -= 6;
  // A long opaque token in the path/query is the signature of a one-off link.
  if (/[A-Za-z0-9_-]{24,}/.test(url.replace(/^https?:\/\/[^/]+/, ''))) score += 3;
  // Bare homepage: almost never the action link.
  if (/^https?:\/\/[^/]+\/?$/.test(url)) score -= 3;
  return score;
}

// Best-first ordering of an email's links (stable for equal scores).
function rankLinks(links) {
  return (links || [])
    .map((url, i) => ({ url, i, score: scoreLink(url) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.url);
}

// Pull likely one-time codes from a subject + plain-text body, best first.
// Pass 1 takes codes on (or right after) a line that mentions a code keyword;
// pass 2 falls back to any lone 4-8 digit number. Phone numbers, years,
// currency amounts and URLs are ignored.
function extractCodes(subject, text) {
  const hay = `${subject || ''}\n${text || ''}`
    .replace(URL_RE, ' ')
    .replace(/\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g, ' ')
    .replace(/\+?\d{1,3}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/\b\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/[$€£]\s?\d[\d,.]*/g, ' ');
  const out = [];
  const push = c => { if (!out.includes(c)) out.push(c); };
  const isYear = c => c.length === 4 && Number(c) >= 1900 && Number(c) <= 2100;
  const keyword = /(code|otp|pin\b|verification|verify|one[- ]time|passcode|password|security|confirm)/i;
  const scan = line => {
    for (const m of line.matchAll(/\b(\d{3})[\s-](\d{3})\b/g)) push(m[1] + m[2]);
    for (const m of line.matchAll(/\b\d{4,8}\b/g)) if (!isYear(m[0])) push(m[0]);
    for (const m of line.matchAll(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}\b/g)) push(m[0]);
  };
  const lines = hay.split(/\n+/).map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!keyword.test(lines[i])) continue;
    scan(lines[i]);
    // "Your verification code is:" with the code alone on the next line(s).
    for (const next of lines.slice(i + 1, i + 3)) {
      if (/^[A-Z0-9][A-Z0-9 -]{2,10}$/.test(next)) scan(next);
    }
  }
  if (!out.length) {
    for (const m of hay.matchAll(/\b\d{4,8}\b/g)) if (!isYear(m[0])) push(m[0]);
  }
  return out.slice(0, 5);
}

// Attachment metadata only (filename/type/size) — content is not stored.
function extractAttachments(parsed) {
  return (parsed.attachments || []).map(a => ({
    filename: a.filename || 'unnamed',
    contentType: a.contentType || 'application/octet-stream',
    size: typeof a.size === 'number' ? a.size : (a.content ? a.content.length : 0),
  }));
}

// Find the best verification-style link in a newest-first email list: the
// highest-scoring link of the newest email that has any usable link. Emails
// whose only links are junk (logos, unsubscribe) are skipped.
function findVerifyLink(emails, fromFilter) {
  const candidates = fromFilter
    ? emails.filter(e => String(e.from || '').toLowerCase().includes(fromFilter))
    : emails;
  for (const email of candidates) {
    const ranked = rankLinks(email.links).filter(u => scoreLink(u) > -10);
    if (ranked.length > 0) return { url: ranked[0], emailId: email.id };
  }
  return null;
}

// Find the newest one-time code in a newest-first email list.
function findCode(emails, fromFilter) {
  const candidates = fromFilter
    ? emails.filter(e => String(e.from || '').toLowerCase().includes(fromFilter))
    : emails;
  for (const email of candidates) {
    const codes = email.codes || extractCodes(email.subject, email.text);
    if (codes.length) return { code: codes[0], codes, emailId: email.id, subject: email.subject, from: email.from };
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

// --- SMTP server: receives incoming mail ---
// Public port 25 is an internet-facing listener, so only accept mail for our
// own domain (set SMTP_ACCEPT_ANY_DOMAIN=1 to disable, e.g. for local dev).
const ACCEPT_ANY_DOMAIN = process.env.SMTP_ACCEPT_ANY_DOMAIN === '1';

const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  // Reject absurdly large messages before parsing.
  size: 10 * 1024 * 1024,
  onRcptTo(address, session, callback) {
    if (!ACCEPT_ANY_DOMAIN && !address.address.toLowerCase().endsWith(`@${DOMAIN.toLowerCase()}`)) {
      const err = new Error(`Relaying denied: we only accept mail for @${DOMAIN}`);
      err.responseCode = 550;
      return callback(err);
    }
    callback();
  },
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async parsed => {
        try {
          // Envelope recipients are authoritative: catch-all mail is often
          // addressed via Bcc/lists, so the To header may not name us at all.
          const envelope = (session.envelope?.rcptTo || []).map(a => a.address.toLowerCase());
          const toAddrs = envelope.length
            ? envelope
            : (parsed.to?.value || []).map(a => a.address.toLowerCase());
          const html = typeof parsed.html === 'string' ? parsed.html : '';
          const bodyText = parsed.text || (html ? htmlToText(html) : '');
          const links = extractLinks(`${parsed.subject || ''}\n${bodyText}`, html);
          const attachments = extractAttachments(parsed);
          for (const addr of toAddrs) {
            // Resolve ownership first so mail to an account's address keeps
            // belonging to that account after a restart.
            registerAddress(addr, await ownershipFor(addr));
            const dedupeKey = seenKey(addr, parsed.messageId);
            if (dedupeKey && seenMessages.has(dedupeKey)) continue;
            if (rateLimitExceeded(`recv:${addr}`, EMAILS_PER_ADDRESS_PER_HOUR)) {
              console.warn(`[smtp] per-address receive rate limit hit for ${addr}, email dropped`);
              continue;
            }
            try {
              const record = await storeEmail({
                address: addr,
                from: parsed.from?.text || '',
                subject: parsed.subject || '',
                date: parsed.date?.toISOString() || new Date().toISOString(),
                text: bodyText.slice(0, 10000),
                links,
                attachments,
              });
              rememberMessage(dedupeKey, record.id);
              // Webhook is fire-and-forget; SMTP accept must not wait on it.
              fireIncomingWebhook({ address: addr, email: record }).catch(() => {});
            } catch (err) {
              // Already queued for retry; the SMTP session still succeeds so the
              // sender does not bounce a message we intend to deliver later.
              console.error(`[smtp] store failed for ${addr}, queued for retry: ${err.message}`);
            }
          }
          console.log(JSON.stringify({
            level: 'info', type: 'smtp',
            to: toAddrs, attachments: attachments.length,
          }));
        } catch (err) {
          console.error('[smtp] store error', err.message);
        }
        callback();
      })
      .catch(err => {
        console.error('[smtp] parse error', err.message);
        callback();
      });
  },
});

// --- REST API ---

app.get('/health', async (req, res) => {
  try {
    res.json({
      ok: true,
      domain: DOMAIN,
      storage: useSupabase ? 'supabase' : 'memory',
      durableStorage: useSupabase,
      smtpListenerEnabled: SMTP_ENABLED,
      // HTTP reachability is NOT proof of Internet SMTP or mailbox delivery.
      externalEmailVerified: false,
      addresses: await countAddresses().catch(() => null),
      accounts: await countAccounts().catch(() => null),
      signup: SIGNUP_OPEN ? 'open' : 'closed',
      dkim: DKIM_STATUS.status,
      addressQuotaPerAccount: ADDRESS_QUOTA_PER_ACCOUNT,
      relay: RELAY_STATUS.status,
      outbound: OUTBOUND_STATUS.provider,
      outboundConfigured: OUTBOUND_STATUS.configured,
      httpInbound: INBOUND_SECRET ? 'secret' : 'api-token',
      webhook: WEBHOOK_URL ? 'configured' : 'disabled',
      addressTtlHours: ADDRESS_TTL_HOURS,
      retentionDays: RETENTION_DAYS,
      deadLetters: deadLetters.length,
      retryQueue: retryQueue.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Operational readiness is separate from cheap HTTP liveness (/health).
// A Render Free instance can answer HTTP while losing every in-memory
// address on restart; never report that state as production-ready mail.
app.get('/ready', async (_req, res) => {
  const issues = [];
  if (TOKEN === 'dev-token-change-me' || TOKEN.length < 32) {
    issues.push('operator_token_insecure_or_missing');
  }
  // A web app responding to HTTPS does not make 'name@localhost' a
  // deliverable public email address. Validate the configured mail identity.
  const validMailDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(DOMAIN)
    && !/(?:\.(?:invalid|test|example|localhost))$/.test(DOMAIN)
    && !['example.com', 'example.net', 'example.org'].includes(DOMAIN);
  if (!validMailDomain) {
    issues.push('public_mail_domain_not_configured');
  }
  if (!useSupabase) {
    issues.push('persistent_storage_not_configured');
  } else {
    try {
      const { error } = await supabase
        .from('agent_emails').select('id').limit(1)
        .abortSignal(AbortSignal.timeout(5000));
      if (error) issues.push('persistent_storage_unavailable');
    } catch (_error) {
      issues.push('persistent_storage_unavailable');
    }
  }
  const ready = issues.length === 0;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    component: 'legacy_node_http_api',
    readiness: ready ? 'http_api_dependencies_available' : 'blocked',
    issues,
    durableStorageConfigured: useSupabase,
    browserHttpOnly: !SMTP_ENABLED,
    internetEmailDeliveryVerified: false,
    pstnSmsVerified: false,
    note: 'An HTTP readiness pass never proves real SMTP ingress, MX or email delivery',
  });
});

// DNS records a domain owner must publish for this service to send and
// receive real internet mail. Public by design: DNS is public, and this lets
// a fresh deployment go live without transcribing values by hand. The DKIM
// record is derived from DKIM_PRIVATE_KEY, so it can never drift.
app.get('/api/dns', (req, res) => {
  const host = String(process.env.MX_HOST || DOMAIN).trim().toLowerCase();
  const records = [
    { type: 'MX', name: DOMAIN, priority: 10, value: host, purpose: 'deliver inbound mail to this host' },
    { type: 'A', name: host, value: '<public IP of the host running server.js>', purpose: 'the mail host must resolve' },
    { type: 'TXT', name: DOMAIN, value: 'v=spf1 a mx ~all', purpose: 'SPF — only this host may send as the domain' },
    { type: 'TXT', name: `_dmarc.${DOMAIN}`, value: `v=DMARC1; p=${DMARC_POLICY}; rua=mailto:dmarc@${DOMAIN}`, purpose: 'DMARC policy + aggregate reports' },
  ];
  if (DKIM_STATUS.publicKey) {
    records.push({
      type: 'TXT',
      name: `${DKIM_SELECTOR}._domainkey.${DKIM_DOMAIN}`,
      value: `v=DKIM1; k=rsa; p=${DKIM_STATUS.publicKey}`,
      purpose: 'DKIM — lets receivers verify our outbound signatures',
    });
  }
  res.json({ ok: true, domain: DOMAIN, dkim: DKIM_STATUS.status, records });
});

// HTTP inbound: the Cloudflare Email Worker POSTs parsed mail here because
// Render web services cannot expose the SMTP port publicly, so internet mail
// can never reach the SMTP listener directly. Auth: Bearer
// AGENT_MAIL_INBOUND_SECRET when set, else Bearer AGENT_MAIL_TOKEN.
// Body: { to, from, subject, text, html } — same shape error-inbox accepts,
// so one worker can deliver to both.
app.post('/api/inbound', async (req, res) => {
  if (!bearerOk(req.headers.authorization, INBOUND_SECRET || TOKEN)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const body = req.body || {};
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  if (!validAddressParam(to)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid "to".' });
  }
  if (!to.endsWith(`@${DOMAIN}`)) {
    // Not our domain: accept + drop so the worker does not retry it forever.
    return res.json({ ok: true, stored: false });
  }
  // A retried delivery of a message we already stored is acknowledged, not
  // stored again (needs the forwarder to pass the Message-ID).
  const dedupeKey = seenKey(to, body.messageId);
  if (dedupeKey && seenMessages.has(dedupeKey)) {
    return res.json({ ok: true, stored: true, duplicate: true, id: seenMessages.get(dedupeKey) });
  }
  const toOwner = await ownershipFor(to);
  registerAddress(to, toOwner === undefined ? null : toOwner);
  if (rateLimitExceeded(`recv:${to}`, EMAILS_PER_ADDRESS_PER_HOUR)) {
    console.warn(`[inbound] per-address receive rate limit hit for ${to}, email dropped`);
    return res.json({ ok: true, stored: false, error: 'rate-limited' });
  }
  const subject = typeof body.subject === 'string' ? body.subject : '';
  let text = typeof body.text === 'string' ? body.text : '';
  if (!text && body.html) text = htmlToText(body.html);
  text = text.slice(0, 10000);
  // Mine links from the text AND the raw HTML (verification links often live
  // only in href attributes); the stored body stays text-only, like SMTP.
  const links = extractLinks(`${subject}\n${text}`, typeof body.html === 'string' ? body.html : '');
  const sentAt = typeof body.date === 'string' && !Number.isNaN(Date.parse(body.date))
    ? new Date(body.date).toISOString() : new Date().toISOString();
  try {
    const record = await storeEmail({
      address: to,
      from: typeof body.from === 'string' ? body.from : '',
      subject,
      date: sentAt,
      text,
      links,
      attachments: [],
    });
    rememberMessage(dedupeKey, record.id);
    fireIncomingWebhook({ address: to, email: record }).catch(() => {});
    return res.json({ ok: true, stored: true, id: record.id });
  } catch (err) {
    // storeEmail already queued a retry; still report failure so the
    // worker's delivery retry has a chance instead of a silent drop.
    console.error(`[inbound] store failed for ${to}: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'store failed' });
  }
});

// Create a new email address owned by the caller. BOTH creation limits
// apply: the per-IP per-minute limit (middleware) and the per-account hourly
// quota (handler). Accounts also have a standing address quota; the master
// token is unlimited.
app.post('/api/addresses', auth, addressRateLimit, async (req, res) => {
  try {
    const actor = req.auth;
    const quotaKey = actor.role === 'master' ? 'create:master' : `create:${actor.account.id}`;
    if (rateLimitExceeded(quotaKey, ADDRESS_CREATE_MAX_PER_HOUR)) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ ok: false, error: 'Address creation rate limit exceeded. Try again later.' });
    }
    let prefix = normalizeAddressPrefix(req.body.prefix);
    // Fall back to a generated prefix if the sanitized input is empty
    if (!prefix) prefix = `agent${Date.now().toString(36)}`;
    const address = `${prefix}@${DOMAIN}`;
    // Defensive guard: normalization above guarantees a valid local part,
    // so this only fires if the normalizer is ever changed. The domain is
    // operator config, not user input, so only the local part is checked
    // here — a single-label dev domain (localhost) must still create.
    if (!validLocalPart(prefix)) {
      return res.status(400).json({ ok: false, error: 'That prefix does not make a valid address' });
    }

    const owner = await ownershipFor(address);
    if (typeof owner === 'string' && actor.role !== 'master' && owner !== actor.account.id) {
      return res.status(409).json({ ok: false, error: 'That address is already claimed by another account' });
    }

    if (actor.role === 'master') {
      // Keep an existing account's claim; otherwise the master owns it.
      registerAddress(address, typeof owner === 'string' ? owner : OWNER_MASTER);
    } else {
      const used = await accountAddressCount(actor.account.id);
      if (used >= actor.account.addressQuota) {
        return res.status(403).json({
          ok: false,
          error: `Address quota reached (${actor.account.addressQuota} per account)`,
          quota: actor.account.addressQuota,
          used,
        });
      }
      registerAddress(address, actor.account.id);
    }
    // No DB write needed until mail arrives; memory path keeps a local entry
    if (!useSupabase && !inboxes.has(address)) inboxes.set(address, []);
    res.json({ ok: true, address, owner: actor.role === 'master' ? OWNER_MASTER : actor.account.id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// List the addresses the caller may see, with inbox counts.
app.get('/api/addresses', auth, async (req, res) => {
  try {
    const list = await knownAddresses(req.auth);
    res.json({ ok: true, count: list.length, addresses: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Free self-serve signup: one agent, one API key, one isolated namespace.
// Open by default; the master token can always create accounts. The API key
// is returned exactly once, and only its hash is stored.
app.post('/api/accounts', addressRateLimit, async (req, res) => {
  try {
    const admin = bearerOk(req.headers.authorization, TOKEN);
    if (!admin) {
      if (!SIGNUP_OPEN) {
        return res.status(403).json({ ok: false, error: 'Signup is closed; an admin must create accounts' });
      }
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!rateLimitWindow(`signup:${ip}`, SIGNUP_PER_IP_PER_HOUR, 60 * 60 * 1000)) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ ok: false, error: 'Too many accounts from this IP — try again later' });
      }
      if (rateLimitExceeded('signup:global', SIGNUP_MAX_PER_HOUR)) {
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ ok: false, error: 'Signup capacity reached — try again later' });
      }
    }
    const { account, apiKey } = await createAccount({ name: (req.body || {}).name });
    res.status(201).json({
      ok: true,
      apiKey,
      account: publicAccount(account),
      limits: {
        addressQuota: account.addressQuota,
        emailsPerAddressPerHour: EMAILS_PER_ADDRESS_PER_HOUR,
        sendPerHour: SEND_MAX_PER_HOUR,
      },
      note: 'Store this API key now — it is shown once. Use it as Authorization: Bearer <apiKey>.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The caller's own account + usage (works for the master token too).
app.get('/api/me', auth, async (req, res) => {
  try {
    if (req.auth.role === 'master') {
      return res.json({
        ok: true,
        role: 'master',
        domain: DOMAIN,
        addresses: await countAddresses(),
        accounts: await countAccounts().catch(() => null),
      });
    }
    const account = req.auth.account;
    res.json({
      ok: true,
      role: 'account',
      domain: DOMAIN,
      account: { ...publicAccount(account), apiKeyPrefix: account.apiKeyPrefix },
      usage: {
        addresses: await accountAddressCount(account.id),
        addressQuota: account.addressQuota,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Quota usage for the caller: per-address send/receive buckets, the
// address-creation hourly bucket, and the global daily send cap. An account
// sees only its own addresses; the master token sees every address. Reading
// quota never consumes any of it (see rateBucketUsage).
app.get('/api/quota', auth, async (req, res) => {
  try {
    const actor = req.auth;
    const list = await knownAddresses(actor);
    const createKey = actor.role === 'master' ? 'create:master' : `create:${actor.account.id}`;
    const daily = windowBucketUsage('send:day:all');
    const body = {
      ok: true,
      role: actor.role,
      domain: DOMAIN,
      addresses: list.map(a => quotaForAddress(a.address)),
      addressCreationPerHour: rateBucketUsage(createKey, ADDRESS_CREATE_MAX_PER_HOUR),
      sendPerDay: SEND_MAX_PER_DAY > 0
        ? {
            limit: SEND_MAX_PER_DAY,
            used: daily.count,
            remaining: Math.max(0, SEND_MAX_PER_DAY - daily.count),
            resetAt: daily.resetAt,
          }
        : { limit: 0, used: daily.count, remaining: null, resetAt: daily.resetAt },
    };
    if (actor.role !== 'master') {
      body.addressQuota = {
        limit: actor.account.addressQuota,
        used: list.length,
        remaining: Math.max(0, actor.account.addressQuota - list.length),
      };
    }
    res.json(body);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Quota usage for one address. 404 when the address is unknown to the
// service or belongs to another account; 400 for a malformed address.
app.get('/api/quota/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    if ((await ownershipFor(addr)) === undefined) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    res.json({ ok: true, ...quotaForAddress(addr) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Live relay health (master only): config status plus a real SMTP EHLO
// probe against the relay — no mail is sent. 200 when the outbound path is
// usable (or configured via an HTTP provider, which has no read-only
// probe), 503 when the relay is unconfigured or the probe fails, so a
// monitor can alert on the status code alone.
app.get('/api/relay', auth, requireMaster, async (req, res) => {
  try {
    const result = await probeRelay();
    const ok = result.configured && (result.probe === 'ok' || result.probe === 'not-probed');
    res.status(ok ? 200 : 503).json({
      ok,
      ...result,
      limits: { sendPerHour: SEND_MAX_PER_HOUR, sendPerDay: SEND_MAX_PER_DAY },
      dkim: DKIM_STATUS.status,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Every account with usage — admin only. API keys are never returned, only
// their prefixes so an operator can tell accounts apart.
app.get('/api/accounts', auth, requireMaster, async (req, res) => {
  try {
    const accounts = await listAccountsWithUsage();
    res.json({ ok: true, count: accounts.length, accounts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send mail FROM one of this service's own addresses, via the SMTP relay or
// the configured Resend/Brevo HTTP API. Auth: same Bearer token as the other
// routes. The From address must have been created by this service; foreign
// From values get 403. Unconfigured -> 503. Provider 429 -> 429. Other
// provider/relay failure -> 502.
app.post('/api/send', auth, async (req, res) => {
  try {
    const v = validateSendBody(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const result = await sendAgentMail(v.value, req.auth);
    res.json({
      ok: true,
      from: v.value.from,
      ...(v.value.fromName ? { fromName: v.value.fromName } : {}),
      to: v.value.to,
      ...result,
    });
  } catch (err) {
    if (err.status === 429) res.setHeader('Retry-After', '3600');
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// List emails for an address, with pagination + search.
// Pagination: page/per_page (1-based) OR limit/offset (limit/offset win if
// present). Search: q (subject/from/body), from (sender substring).
// List items carry the attachment count under BOTH `attachments` (number,
// origin shape) and `attachmentCount` (quota shape).
app.get('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const hasLimitOffset = req.query.limit !== undefined || req.query.offset !== undefined;
    const { emails, total, page, perPage, pages, limit, offset } = await listEmails(addr, {
      q: req.query.q,
      from: req.query.from,
      since: req.query.since,
      page: req.query.page,
      perPage: req.query.per_page,
      limit: hasLimitOffset ? req.query.limit : undefined,
      offset: hasLimitOffset ? req.query.offset : undefined,
    });
    res.json({
      ok: true,
      address: addr,
      count: emails.length,
      total,
      page,
      perPage,
      pages,
      limit,
      offset,
      emails: emails.map(e => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        receivedAt: e.receivedAt,
        codes: e.codes || [],
        linkCount: (e.links || []).length,
        preview: String(e.text || '').replace(/\s+/g, ' ').slice(0, 140),
        attachments: (e.attachments || []).length,
        attachmentCount: (e.attachments || []).length,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get full email
app.get('/api/inbox/:address/:id', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const email = await getEmail(addr, req.params.id);
    if (!email) return res.status(404).json({ ok: false, error: 'Not found' });
    // `links` keeps arrival order; `bestLinks` is the same set ranked so the
    // action link comes first and logos/unsubscribe links come last.
    res.json({ ok: true, email: { ...email, bestLinks: rankLinks(email.links) } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Poll for verification link (newest email matching sender filter) — immediate.
app.get('/api/verify-link/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const fromFilter = String(req.query.from || '').toLowerCase();
    const { emails } = await listEmails(addr, { perPage: 50, since: req.query.since }); // newest first
    const found = findVerifyLink(emails, fromFilter);
    if (found) return res.json({ ok: true, ...found });
    res.json({ ok: false, error: 'No verification email yet' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Shared long-poll loop: re-check the inbox whenever mail arrives for the
// address (instant, via mailEvents) and at most every 2s otherwise, until
// `pick(emails)` returns something or the timeout passes.
async function longPoll(req, res, pick, timeoutError) {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const fromFilter = String(req.query.from || '').toLowerCase();
    const since = req.query.since;
    if (since && Number.isNaN(Date.parse(since))) {
      return res.status(400).json({ ok: false, error: 'since must be an ISO time' });
    }
    const timeoutMs = Math.min(120000, Math.max(1000, Number(req.query.timeoutMs) || 30000));
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let closed = false;
    req.on('close', () => { closed = true; mailEvents.emit(addr); });
    for (;;) {
      const { emails } = await listEmails(addr, { perPage: 50, since });
      const found = pick(emails, fromFilter);
      if (found) {
        return res.json({ ok: true, waitedMs: Math.round(Date.now() - startedAt), ...found });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || closed) break;
      await waitForArrival(addr, Math.min(2000, remaining));
    }
    if (!closed) res.json({ ok: false, error: timeoutError, timeoutMs });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
}

// Long-poll for a verification link: waits up to timeoutMs (default 30s,
// max 120s) instead of requiring the caller to busy-poll.
app.get('/api/verify-link/:address/wait', auth, (req, res) =>
  longPoll(req, res, findVerifyLink, 'Timed out waiting for verification email'));

// Newest one-time code for the address (immediate).
app.get('/api/code/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const { emails } = await listEmails(addr, { perPage: 50, since: req.query.since });
    const found = findCode(emails, String(req.query.from || '').toLowerCase());
    if (found) return res.json({ ok: true, ...found });
    res.json({ ok: false, error: 'No email with a code yet' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Long-poll for a one-time code.
app.get('/api/code/:address/wait', auth, (req, res) =>
  longPoll(req, res, findCode, 'Timed out waiting for a code'));

// Long-poll for the next email of any kind: returns the newest matching
// message in full, with its codes and ranked links, in ONE call. Pass
// since=<ISO time you triggered the email> to ignore older mail.
app.get('/api/wait/:address', auth, (req, res) =>
  longPoll(req, res, (emails, fromFilter) => {
    const e = fromFilter
      ? emails.find(x => String(x.from || '').toLowerCase().includes(fromFilter))
      : emails[0];
    if (!e) return null;
    const best = rankLinks(e.links).filter(u => scoreLink(u) > -10);
    return { email: { ...e, bestLinks: rankLinks(e.links) }, code: (e.codes || [])[0] || null, link: best[0] || null };
  }, 'Timed out waiting for mail'));

// Clear inbox
app.delete('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    if (!(await canAccessAddress(req, addr))) {
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    await clearInbox(addr);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dead-letter log: emails that exhausted the store retry budget. An account
// key only ever sees entries for addresses it owns.
app.get('/api/dead-letters', auth, async (req, res) => {
  let list = deadLetters;
  if (req.auth.role !== 'master') {
    list = [];
    for (const d of deadLetters) {
      if (await canAccessAddress(req, d.address)) list.push(d);
    }
  }
  res.json({ ok: true, count: list.length, deadLetters: list.slice(-50) });
});

// --- Local-only dashboard: browse addresses and inboxes in a browser ---
// Token is entered once and kept in sessionStorage; nothing leaves localhost.
app.get('/dashboard', (req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Agent Mail Service — local dashboard</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 16px}h2{font-size:15px;margin:24px 0 8px;color:#9fb4ff}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #2a2e38;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#171a21}tr:nth-child(even) td{background:#13151b}
a{color:#7fb3ff;cursor:pointer}a:hover{text-decoration:underline}
input,button{background:#171a21;color:#e6e6e6;border:1px solid #2a2e38;border-radius:6px;padding:8px 10px;font-size:13px}
button{cursor:pointer}button:hover{background:#1f2330}
#login{margin-bottom:16px}.meta{color:#8a93a6;font-size:12px}
pre{white-space:pre-wrap;background:#13151b;padding:12px;border-radius:6px;border:1px solid #2a2e38}
.tag{display:inline-block;background:#1d2b1d;color:#9fe09f;border-radius:4px;padding:1px 6px;font-size:11px;margin-left:6px}
</style></head><body>
<h1>Agent Mail Service <span class="meta">local dashboard</span></h1>
<div id="login"><input id="token" type="password" placeholder="AGENT_MAIL_TOKEN" size="40">
<button onclick="save()">Use token</button>
<span class="meta">stored in sessionStorage only</span></div>
<div id="app" style="display:none">
<h2>Relay</h2><div id="relay"><span class="meta">loading…</span></div>
<h2>Quota</h2><div id="quota"><span class="meta">loading…</span></div>
<h2>Addresses</h2><div id="addrs"></div>
<h2 id="inboxtitle">Inbox</h2>
<div><input id="q" placeholder="search subject/from/body" size="32">
<button onclick="loadInbox(current,1)">Search</button>
<span class="meta" id="pageinfo"></span></div>
<div id="inbox"></div>
<h2>Email</h2><div id="email"><span class="meta">click a subject to view</span></div>
</div>
<script>
let current=null,page=1;
function save(){const t=document.getElementById('token').value.trim();if(!t)return;
sessionStorage.setItem('amt',t);document.getElementById('app').style.display='block';loadRelay();loadQuota();loadAddrs();}
function H(){return {Authorization:'Bearer '+sessionStorage.getItem('amt')};}
async function j(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function loadRelay(){
 try{
  const d=await j(await fetch('/api/relay',{headers:H()}));
  document.getElementById('relay').innerHTML='<span class="meta">'+esc(d.provider)+' relay — probe: <b>'+esc(d.probe)+'</b> — '+esc(d.detail||'')+'</span> <span class="tag">'+esc(d.configured?'configured':'unconfigured')+'</span>';
 }catch(e){
  document.getElementById('relay').innerHTML='<span class="meta">relay status unavailable (master token required)</span>';
 }
}
async function loadQuota(){
 try{
  const d=await j(await fetch('/api/quota',{headers:H()}));
  let h='<table><tr><th>Address</th><th>Send / hour</th><th>Receive / hour</th><th>Resets</th></tr>';
  for(const a of d.addresses){
   const s=a.sendPerHour,r=a.receivePerHour;
   h+='<tr><td>'+esc(a.address)+'</td><td>'+s.used+' / '+s.limit+(s.remaining===null?'':' ('+s.remaining+' left)')+'</td><td>'+r.used+' / '+r.limit+(r.remaining===null?'':' ('+r.remaining+' left)')+'</td><td>'+esc(s.resetAt||r.resetAt||'—')+'</td></tr>';
  }
  h+='</table><div class="meta">address creation this hour: '+d.addressCreationPerHour.used+' / '+d.addressCreationPerHour.limit+'</div>';
  document.getElementById('quota').innerHTML=h;
 }catch(e){
  document.getElementById('quota').innerHTML='<span class="meta">quota unavailable</span>';
 }
}
async function loadAddrs(){
 const d=await j(await fetch('/api/addresses',{headers:H()}));
 document.getElementById('addrs').innerHTML='<table><tr><th>Address</th><th>Emails</th><th>Created</th><th>Last seen</th></tr>'+
 d.addresses.map(a=>'<tr><td><a onclick="loadInbox(\\''+a.address+'\\',1)">'+a.address+'</a></td><td>'+a.emails+'</td><td>'+a.createdAt+'</td><td>'+a.lastSeenAt+'</td></tr>').join('')+'</table>';
}
async function loadInbox(addr,p){
 current=addr;page=p||1;
 const q=document.getElementById('q').value.trim();
 const d=await j(await fetch('/api/inbox/'+encodeURIComponent(addr)+'?page='+page+'&per_page=20&q='+encodeURIComponent(q),{headers:H()}));
 document.getElementById('inboxtitle').textContent='Inbox: '+addr;
 document.getElementById('pageinfo').textContent='page '+d.page+' of '+d.pages+' ('+d.total+' total)';
 let h='<table><tr><th>From</th><th>Subject</th><th>Code</th><th>Date</th></tr>';
 for(const e of d.emails){
  h+='<tr><td>'+esc(e.from)+'</td><td><a onclick="viewEmail(\\''+e.id+'\\')">'+esc(e.subject)+'</a>'+(e.attachmentCount?' <span class="tag">'+e.attachmentCount+' att</span>':'')+'</td><td>'+(e.codes&&e.codes.length?'<span class="tag">'+esc(e.codes[0])+'</span>':'')+'</td><td>'+esc(e.date)+'</td></tr>';
 }
 h+='</table><div style="margin-top:8px">';
 if(d.page>1)h+='<button onclick="loadInbox(current,'+(d.page-1)+')">Prev</button> ';
 if(d.page<d.pages)h+='<button onclick="loadInbox(current,'+(d.page+1)+')">Next</button>';
 h+='</div>';
 document.getElementById('inbox').innerHTML=h;
}
async function viewEmail(id){
 const d=await j(await fetch('/api/inbox/'+encodeURIComponent(current)+'/'+id,{headers:H()}));
 const e=d.email;
 let at='';if(e.attachments&&e.attachments.length){
  at='<h3>Attachments (metadata only)</h3><table><tr><th>Filename</th><th>Type</th><th>Size</th></tr>'+
  e.attachments.map(a=>'<tr><td>'+esc(a.filename)+'</td><td>'+esc(a.contentType)+'</td><td>'+a.size+' bytes</td></tr>').join('')+'</table>';
 }
 const links=(e.bestLinks||e.links||[]).map(u=>'<div><a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(u)+'</a></div>').join('');
 document.getElementById('email').innerHTML='<table><tr><th>From</th><td>'+esc(e.from)+'</td></tr><tr><th>Subject</th><td>'+esc(e.subject)+'</td></tr><tr><th>Date</th><td>'+esc(e.date)+'</td></tr><tr><th>Codes</th><td>'+esc((e.codes||[]).join(', ')||'none')+'</td></tr></table>'+at+'<h3>Links</h3>'+(links||'<span class="meta">none</span>')+'<h3>Body</h3><pre>'+esc(e.text||'')+'</pre>';
 window.scrollTo(0,document.body.scrollHeight);
}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
if(sessionStorage.getItem('amt')){document.getElementById('app').style.display='block';loadRelay();loadQuota();loadAddrs();}
</script></body></html>`);
});

// Only bind listeners when run directly; requiring this file (unit tests)
// must not start servers.
if (require.main === module) {
  smtp.on('error', err => {
    console.error(`[smtp] server error: ${err.message}` +
      (err.code === 'EACCES' ? ' (ports below 1024 need root or CAP_NET_BIND_SERVICE; see README)' : ''));
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') process.exit(1);
  });
  if (SMTP_ENABLED) {
    smtp.listen(SMTP_PORT, process.env.SMTP_HOST || '0.0.0.0', () => {
      console.log(`[smtp] listening on port ${SMTP_PORT}`);
    });
  } else {
    console.log('[smtp] listener disabled (HTTP-only deployment); external SMTP receipt not available');
  }

  app.listen(PORT, () => {
    console.log(`[api] listening on port ${PORT}, domain=${DOMAIN}`);
  });
}

module.exports = {
  app,
  htmlToText,
  extractLinks,
  extractAttachments,
  findVerifyLink,
  findCode,
  extractCodes,
  rankLinks,
  scoreLink,
  decodeEntities,
  validAddressParam,
  validLocalPart,
  normalizeAddressPrefix,
  backoffMs,
  sweepExpiredAddresses,
  validateSendBody,
  buildOutboundRequest,
  setProviderFetch,
  outboundStatus: () => OUTBOUND_STATUS,
  sendAgentMail,
  getSendTransport,
  setSendTransport,
  probeRelay,
  registerAddress,
  ownershipFor,
  canAccessAddress,
  rateBucketUsage,
  windowBucketUsage,
  quotaForAddress,
  newApiKey,
  hashApiKey,
  newAccountRow,
  createAccount,
  findAccountByKeyHash,
  dkimPublicKeyRecord,
};
