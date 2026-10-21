/**
 * Agent Mail Service — self-hosted email for AI agents.
 *
 * Receives emails via SMTP and exposes them via a simple REST API
 * so the Error Inbox MCP can poll for provider verification emails
 * without depending on Gmail or temp-mail services.
 *
 * Endpoints:
 *   POST /api/addresses          { prefix } -> { address }
 *   GET  /api/inbox/:address     -> list of received emails (paginated)
 *   GET  /api/inbox/:address/:id -> full email (subject, body, links, attachments)
 *   GET  /api/verify-link/:address?from=  -> newest verification link (immediate)
 *   GET  /api/verify-link/:address/wait?from=&timeoutMs= -> long-poll for a link
 *   DELETE /api/inbox/:address   -> clear inbox
 *   GET  /api/dead-letters        -> emails that failed to store after retries
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
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS) || 7);
const RATE_LIMIT_PER_MINUTE = Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE) || 30);

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

// --- Retry queue + dead letters for failed stores ---
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

// --- Request ids + structured request logging ---
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

// Simple in-memory token bucket for address creation (per IP + global).
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
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded — try again in a minute' });
  }
  next();
}

// Globally unique email ids (safe across restarts and storage backends)
function newId() {
  return `em_${crypto.randomUUID().replace(/-/g, '')}`;
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
    attachments: e.attachments || [],
  };
}

// Raw store without retry bookkeeping (used by both the direct path and retries).
async function storeEmailRaw({ address, from, subject, date, text, links, attachments }) {
  if (useSupabase) {
    const { error } = await supabase.from('agent_emails').insert({
      id: newId(),
      address,
      from_addr: from,
      subject,
      date,
      text_body: text,
      links,
      attachments,
    });
    if (error) throw error;
    return;
  }
  if (!inboxes.has(address)) inboxes.set(address, []);
  const emails = inboxes.get(address);
  emails.push({ id: newId(), from, subject, date, text, links, attachments });
  // Keep inbox bounded, and prune entries older than the retention window.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  while (emails.length && new Date(emails[0].date).getTime() < cutoff) emails.shift();
  if (emails.length > 50) emails.splice(0, emails.length - 50);
}

async function storeEmail(email) {
  try {
    await storeEmailRaw(email);
  } catch (err) {
    scheduleRetry(email, err, 1);
    throw err;
  }
}

// Newest first, paginated. Returns { emails, total }.
async function listEmails(address, { limit = 50, offset = 0 } = {}) {
  limit = Math.min(100, Math.max(1, limit | 0 || 50));
  offset = Math.max(0, offset | 0 || 0);
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_emails')
      .select('id, address, from_addr, subject, date, text_body, links, attachments, created_at', { count: 'exact' })
      .eq('address', address)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return { emails: (data || []).map(toEmailShape), total: 0 };
  }
  const emails = (inboxes.get(address) || []).slice().reverse();
  return {
    emails: emails.slice(offset, offset + limit).map(toEmailShape),
    total: emails.length,
  };
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
  const matches = text.match(/https?:\/\/[^\s<>"')]+/g) || [];
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
    ? emails.filter(e => e.from.toLowerCase().includes(fromFilter))
    : emails;
  for (const email of candidates) {
    const verifyLinks = email.links.filter(u =>
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
            try {
              await storeEmail({
                address: addr,
                from: parsed.from?.text || '',
                subject: parsed.subject || '',
                date: parsed.date?.toISOString() || new Date().toISOString(),
                text: (parsed.text || '').slice(0, 10000),
                links,
                attachments,
              });
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
      retentionDays: RETENTION_DAYS,
      deadLetters: deadLetters.length,
      retryQueue: retryQueue.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a new email address (rate-limited)
app.post('/api/addresses', auth, addressRateLimit, (req, res) => {
  let prefix = String(req.body.prefix || `agent${Date.now().toString(36)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 64);
  // Fall back to a generated prefix if the sanitized input is empty
  if (!prefix) prefix = `agent${Date.now().toString(36)}`;
  const address = `${prefix}@${DOMAIN}`;
  // No DB write needed until mail arrives; memory path keeps a local entry
  if (!useSupabase && !inboxes.has(address)) inboxes.set(address, []);
  res.json({ ok: true, address });
});

// List emails for an address (paginated: ?limit=&offset=)
app.get('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    if (!validAddressParam(addr)) {
      return res.status(400).json({ ok: false, error: 'Invalid address format' });
    }
    const { emails, total } = await listEmails(addr, {
      limit: Number(req.query.limit),
      offset: Number(req.query.offset),
    });
    res.json({
      ok: true,
      address: addr,
      count: emails.length,
      total,
      emails: emails.map(e => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        attachments: e.attachments.length,
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
    const { emails } = await listEmails(addr);
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
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { emails } = await listEmails(addr);
      const found = findVerifyLink(emails, fromFilter);
      if (found) {
        return res.json({ ok: true, waitedMs: Math.round(Date.now() - (deadline - timeoutMs)), ...found });
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
};
