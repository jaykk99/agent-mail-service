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
 *   GET  /api/inbox/:address     -> paginated list (page, per_page, q, from)
 *   GET  /api/inbox/:address/:id -> full email (subject, body, links, attachment metadata)
 *   DELETE /api/inbox/:address   -> clear inbox
 *   GET  /api/verify-link/:address?from= -> newest verification URL
 *   GET  /dashboard              -> local browser UI for addresses/inboxes
 *
 * Features: per-address receive rate limiting, address-creation rate limiting,
 * address TTL auto-cleanup sweep, HMAC-signed incoming-mail webhooks,
 * attachment metadata (never content), outbound SMTP relay config validation.
 *
 * Auth: Bearer token from AGENT_MAIL_TOKEN env var.
 *
 * Storage: Supabase table `agent_emails` when SUPABASE_URL and
 * SUPABASE_SERVICE_KEY are set; otherwise falls back to an in-memory
 * Map so local dev keeps working with no config.
 */

const express = require('express');
const crypto = require('crypto');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const app = express();
app.use(express.json());

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

// --- Feature config ---
// Address TTL: addresses with no activity older than this are auto-cleaned.
// ADDRESS_TTL_HOURS=0 disables the sweep entirely.
const ADDRESS_TTL_HOURS = numEnv('ADDRESS_TTL_HOURS', 72);
const ADDRESS_SWEEP_MS = numEnv('ADDRESS_SWEEP_MS', 30 * 60 * 1000);
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

// Globally unique email ids (safe across restarts and storage backends)
function newId() {
  return `em_${crypto.randomUUID().replace(/-/g, '')}`;
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

async function storeEmail({ address, from, subject, date, text, links, attachments = [] }) {
  const record = {
    id: newId(),
    from,
    subject,
    date,
    text,
    links,
    attachments,
  };
  if (useSupabase) {
    const row = {
      id: record.id,
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
    return record;
  }
  if (!inboxes.has(address)) inboxes.set(address, []);
  const emails = inboxes.get(address);
  emails.push(record);
  // Keep inbox bounded
  if (emails.length > 50) emails.shift();
  return record;
}

// Newest first, with optional search + pagination
async function listEmails(address, { q = '', from = '', page = 1, perPage = 20 } = {}) {
  q = String(q || '').toLowerCase();
  from = String(from || '').toLowerCase();
  page = Math.max(1, parseInt(page, 10) || 1);
  perPage = Math.min(100, Math.max(1, parseInt(perPage, 10) || 20));

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
      String(e.from).toLowerCase().includes(q) ||
      String(e.text).toLowerCase().includes(q));
  }
  if (from) {
    emails = emails.filter(e => String(e.from).toLowerCase().includes(from));
  }
  const total = emails.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pages);
  const slice = emails.slice((safePage - 1) * perPage, safePage * perPage);
  return { emails: slice, total, page: safePage, perPage, pages };
}

async function getEmail(address, id) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_emails')
      .select('id, address, from_addr, subject, date, text_body, links, created_at')
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

// --- SMTP server: receives incoming mail ---
const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(async parsed => {
        try {
          const toAddrs = (parsed.to?.value || []).map(a => a.address.toLowerCase());
          const links = extractLinks(`${parsed.subject || ''}\n${parsed.text || ''}`);
          // Attachment metadata only — content is never stored.
          const attachments = (parsed.attachments || []).map(a => ({
            filename: a.filename || 'unnamed',
            contentType: a.contentType || 'application/octet-stream',
            size: a.size || (a.content ? a.content.length : 0),
          }));
          for (const addr of toAddrs) {
            registerAddress(addr);
            if (rateLimitExceeded(`recv:${addr}`, EMAILS_PER_ADDRESS_PER_HOUR)) {
              console.warn(`[smtp] per-address receive rate limit hit for ${addr}, email dropped`);
              continue;
            }
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
          }
          console.log(`[smtp] received mail for ${toAddrs.join(', ')}`);
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

smtp.listen(SMTP_PORT, () => {
  console.log(`[smtp] listening on port ${SMTP_PORT}`);
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
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a new email address
app.post('/api/addresses', auth, (req, res) => {
  if (rateLimitExceeded('create:global', ADDRESS_CREATE_MAX_PER_HOUR)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ ok: false, error: 'Address creation rate limit exceeded. Try again later.' });
  }
  let prefix = String(req.body.prefix || `agent${Date.now().toString(36)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
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
// Query: page (1-based), per_page (max 100), q (subject/from/body), from
app.get('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    const { emails, total, page, perPage, pages } = await listEmails(addr, {
      q: req.query.q,
      from: req.query.from,
      page: req.query.page,
      perPage: req.query.per_page,
    });
    res.json({
      ok: true,
      address: addr,
      count: emails.length,
      total,
      page,
      perPage,
      pages,
      emails: emails.map(e => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
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
    const email = await getEmail(addr, req.params.id);
    if (!email) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, email });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Poll for verification link (newest email matching sender filter)
app.get('/api/verify-link/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    const fromFilter = (req.query.from || '').toLowerCase();
    const { emails } = await listEmails(addr, { from: fromFilter, perPage: 50 }); // newest first
    const candidates = emails;
    for (let i = 0; i < candidates.length; i++) {
      const verifyLinks = candidates[i].links.filter(u =>
        /verif|confirm|activate|validate/i.test(u)
      );
      if (verifyLinks.length > 0) {
        return res.json({ ok: true, url: verifyLinks[0], emailId: candidates[i].id });
      }
      if (candidates[i].links.length > 0) {
        return res.json({ ok: true, url: candidates[i].links[0], emailId: candidates[i].id });
      }
    }
    res.json({ ok: false, error: 'No verification email yet' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Clear inbox
app.delete('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    await clearInbox(addr);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
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
 d.addresses.map(a=>'<tr><td><a onclick="loadInbox(\\''+a.address+'\\',1)">'+a.address+'</a></td><td>'+a.emails+'</td><td>'+a.createdAt+'</td><td>'+a.lastSeenAt+'</td></tr>').join('')+'</table>';
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

app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}, domain=${DOMAIN}`);
});
