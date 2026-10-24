/**
 * Agent Mail Service — self-hosted email for AI agents.
 *
 * Receives emails via SMTP and exposes them via a simple REST API
 * so the Error Inbox MCP can poll for provider verification emails
 * without depending on Gmail or temp-mail services.
 *
 * Endpoints:
 *   POST /api/addresses          { prefix } -> { address }
 *   GET  /api/addresses          -> known addresses with inbox counts
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
 * outbound SMTP relay config validation.
 *
 * Rate-limit precedence: BOTH creation limits apply — a creation must pass
 * the per-IP per-minute limit AND the global hourly quota; either one can
 * return 429. Pagination precedence: if limit/offset are present they win,
 * otherwise page/per_page are used.
 *
 * Auth: Bearer token from AGENT_MAIL_TOKEN env var.
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
// Bound request bodies so oversized posts can't be used to grow memory.
app.use(express.json({ limit: '50kb' }));

const PORT = process.env.PORT || 3000;
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const TOKEN = process.env.AGENT_MAIL_TOKEN || 'dev-token-change-me';
if (TOKEN === 'dev-token-change-me') {
  console.warn('[security] AGENT_MAIL_TOKEN is the default dev token — set a long random token in production!');
}
const DOMAIN = process.env.MAIL_DOMAIN || 'localhost';

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
// Optional outbound SMTP relay config (validated at boot; no mail is ever
// sent by this service today — validation exists so a future relay or
// misconfig surfaces loudly instead of silently).
const SMTP_RELAY_HOST = process.env.SMTP_RELAY_HOST || '';
const SMTP_RELAY_PORT = numEnv('SMTP_RELAY_PORT', 587);

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

// In-memory fallback: address -> [{ id, from, subject, date, text, links, attachments }]
const inboxes = new Map();

// --- Address registry: tracks creation/last activity for TTL cleanup ---
// address -> { createdAt, lastSeenAt } (ISO strings)
const addressRegistry = new Map();

function registerAddress(address) {
  const now = new Date().toISOString();
  const entry = addressRegistry.get(address);
  if (entry) entry.lastSeenAt = now;
  else addressRegistry.set(address, { createdAt: now, lastSeenAt: now });
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
      removed++;
    }
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

// Validate an address path parameter: local@domain shape, bounded length.
function validAddressParam(addr) {
  if (typeof addr !== 'string' || addr.length === 0 || addr.length > 254) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@') || at === addr.length - 1) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(addr);
}

// Normalize a Supabase row or in-memory object to the API email shape
function toEmailShape(e) {
  return {
    id: e.id,
    from: e.from_addr !== undefined ? e.from_addr : e.from,
    subject: e.subject || '',
    date: e.date || e.created_at || new Date().toISOString(),
    text: e.text_body !== undefined ? e.text_body : (e.text || ''),
    links: e.links || [],
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
    return await storeEmailRaw(record);
  } catch (err) {
    scheduleRetry(record, err, 1);
    throw err;
  }
}

// Newest first, with optional search + BOTH pagination styles.
// Precedence: explicit limit/offset win; otherwise page/perPage are used.
// Returns { emails, total, page, perPage, pages, limit, offset }.
async function listEmails(address, { q = '', from = '', page, perPage, limit, offset } = {}) {
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

async function countAddresses() {
  if (useSupabase) {
    const { data, error } = await supabase.from('agent_emails').select('address');
    if (error) throw error;
    return new Set((data || []).map(r => r.address)).size;
  }
  return inboxes.size;
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// Extract URLs from text, trimming trailing sentence punctuation
// (e.g. "https://x.com/verify." at the end of a sentence)
function extractLinks(text) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"')]+/g) || [];
  return [...new Set(matches.map(u => u.replace(/[.,;:!?]+$/, '')))];
}

// Attachment metadata only (filename/type/size) — content is not stored.
function extractAttachments(parsed) {
  return (parsed.attachments || []).map(a => ({
    filename: a.filename || 'unnamed',
    contentType: a.contentType || 'application/octet-stream',
    size: typeof a.size === 'number' ? a.size : (a.content ? a.content.length : 0),
  }));
}

// Find the newest verification-style link in a newest-first email list.
function findVerifyLink(emails, fromFilter) {
  const candidates = fromFilter
    ? emails.filter(e => String(e.from || '').toLowerCase().includes(fromFilter))
    : emails;
  for (const email of candidates) {
    const verifyLinks = (email.links || []).filter(u =>
      /verif|confirm|activate|validate|magic|signin|login|reset|otp|code/i.test(u)
    );
    if (verifyLinks.length > 0) {
      return { url: verifyLinks[0], emailId: email.id };
    }
    if (email.links.length > 0) {
      return { url: email.links[0], emailId: email.id };
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

// --- SMTP server: receives incoming mail ---
const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  // Reject absurdly large messages before parsing.
  size: 10 * 1024 * 1024,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async parsed => {
        try {
          const toAddrs = (parsed.to?.value || []).map(a => a.address.toLowerCase());
          const links = extractLinks(`${parsed.subject || ''}\n${parsed.text || ''}`);
          const attachments = extractAttachments(parsed);
          for (const addr of toAddrs) {
            registerAddress(addr);
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
                text: (parsed.text || '').slice(0, 10000),
                links,
                attachments,
              });
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
      addresses: await countAddresses(),
      relay: RELAY_STATUS.status,
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

// Create a new email address. BOTH creation limits apply: the per-IP
// per-minute limit (middleware) and the global hourly quota (handler).
app.post('/api/addresses', auth, addressRateLimit, (req, res) => {
  if (rateLimitExceeded('create:global', ADDRESS_CREATE_MAX_PER_HOUR)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ ok: false, error: 'Address creation rate limit exceeded. Try again later.' });
  }
  let prefix = String(req.body.prefix || `agent${Date.now().toString(36)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64);
  // Fall back to a generated prefix if the sanitized input is empty
  if (!prefix) prefix = `agent${Date.now().toString(36)}`;
  const address = `${prefix}@${DOMAIN}`;
  // No DB write needed until mail arrives; memory path keeps a local entry
  if (!useSupabase && !inboxes.has(address)) inboxes.set(address, []);
  registerAddress(address);
  res.json({ ok: true, address });
});

// List known addresses (registry) with inbox counts
app.get('/api/addresses', auth, async (req, res) => {
  try {
    const list = [];
    for (const addr of addressRegistry.keys()) {
      const info = addressInfo(addr);
      if (info) list.push(info);
    }
    list.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1));
    res.json({ ok: true, count: list.length, addresses: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
    const hasLimitOffset = req.query.limit !== undefined || req.query.offset !== undefined;
    const { emails, total, page, perPage, pages, limit, offset } = await listEmails(addr, {
      q: req.query.q,
      from: req.query.from,
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
    const email = await getEmail(addr, req.params.id);
    if (!email) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, email });
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
    const fromFilter = (req.query.from || '').toLowerCase();
    const { emails } = await listEmails(addr, { perPage: 50 }); // newest first
    const found = findVerifyLink(emails, fromFilter);
    if (found) return res.json({ ok: true, ...found });
    res.json({ ok: false, error: 'No verification email yet' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Long-poll for a verification link: waits up to timeoutMs (default 30s,
// max 120s) instead of requiring the caller to busy-poll.
app.get('/api/verify-link/:address/wait', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    const fromFilter = (req.query.from || '').toLowerCase();
    const timeoutMs = Math.min(120000, Math.max(1000, Number(req.query.timeoutMs) || 30000));
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    for (;;) {
      const { emails } = await listEmails(addr, { perPage: 50 });
      const found = findVerifyLink(emails, fromFilter);
      if (found) {
        return res.json({ ok: true, waitedMs: Math.round(Date.now() - startedAt), ...found });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(2000, remaining));
    }
    res.json({ ok: false, error: 'Timed out waiting for verification email', timeoutMs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Clear inbox
app.delete('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    await clearInbox(addr);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dead-letter log: emails that exhausted the store retry budget.
app.get('/api/dead-letters', auth, (req, res) => {
  res.json({ ok: true, count: deadLetters.length, deadLetters: deadLetters.slice(-50) });
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
sessionStorage.setItem('amt',t);document.getElementById('app').style.display='block';loadAddrs();}
function H(){return {Authorization:'Bearer '+sessionStorage.getItem('amt')};}
async function j(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}
async function loadAddrs(){
 const d=await j(await fetch('/api/addresses',{headers:H()}));
 document.getElementById('addrs').innerHTML='<table><tr><th>Address</th><th>Emails</th><th>Created</th><th>Last seen</th></tr>'+
 d.addresses.map(a=>'<tr><td><a onclick="loadInbox(\\''+a.address+'\\',1)">'+esc(a.address)+'</a></td><td>'+esc(a.emails)+'</td><td>'+esc(a.createdAt)+'</td><td>'+esc(a.lastSeenAt)+'</td></tr>').join('')+'</table>';
}
async function loadInbox(addr,p){
 current=addr;page=p||1;
 const q=document.getElementById('q').value.trim();
 const d=await j(await fetch('/api/inbox/'+encodeURIComponent(addr)+'?page='+page+'&per_page=20&q='+encodeURIComponent(q),{headers:H()}));
 document.getElementById('inboxtitle').textContent='Inbox: '+addr;
 document.getElementById('pageinfo').textContent='page '+d.page+' of '+d.pages+' ('+d.total+' total)';
 let h='<table><tr><th>From</th><th>Subject</th><th>Date</th><th></th></tr>';
 for(const e of d.emails){
  h+='<tr><td>'+esc(e.from)+'</td><td><a onclick="viewEmail(\\''+e.id+'\\')">'+esc(e.subject)+'</a>'+(e.attachmentCount?' <span class="tag">'+e.attachmentCount+' att</span>':'')+'</td><td>'+e.date+'</td></tr>';
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
 const links=(e.links||[]).map(u=>'<div><a href="'+u+'" target="_blank" rel="noopener">'+esc(u)+'</a></div>').join('');
 document.getElementById('email').innerHTML='<table><tr><th>From</th><td>'+esc(e.from)+'</td></tr><tr><th>Subject</th><td>'+esc(e.subject)+'</td></tr><tr><th>Date</th><td>'+e.date+'</td></tr></table>'+at+'<h3>Links</h3>'+(links||'<span class="meta">none</span>')+'<h3>Body</h3><pre>'+esc(e.text||'')+'</pre>';
 window.scrollTo(0,document.body.scrollHeight);
}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
if(sessionStorage.getItem('amt')){document.getElementById('app').style.display='block';loadAddrs();}
</script></body></html>`);
});

// Only bind listeners when run directly; requiring this file (unit tests)
// must not start servers.
if (require.main === module) {
  smtp.listen(SMTP_PORT, () => {
    console.log(`[smtp] listening on port ${SMTP_PORT}`);
  });

  app.listen(PORT, () => {
    console.log(`[api] listening on port ${PORT}, domain=${DOMAIN}`);
  });
}

module.exports = {
  app,
  extractLinks,
  extractAttachments,
  findVerifyLink,
  validAddressParam,
  backoffMs,
  sweepExpiredAddresses,
};
