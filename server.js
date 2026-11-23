/**
 * Self-Hosted Linux Agent Mail & Phone Service (Plug-and-Play)
 *
 * - Zero 3rd-party API keys or cloud services (no Supabase, Resend, Brevo, or external trunks).
 * - Auto-provisions 1,000 email mailboxes (agent-0001..1000@<domain>) and
 *   1,000 phone extensions (2000..2999) on local disk storage (./data).
 * - Built-in SMTP receiver (:2525), local mail router, optional direct DNS MX / local Postfix send,
 *   SMS-style text messaging, browser-to-browser WebRTC calling + guest links,
 *   and generated Linux Asterisk PJSIP + USB SIM modem bridge configs.
 * - Relay health (GET /api/relay, live SMTP EHLO probe, sends no mail) and
 *   quota reporting (GET /api/quota, GET /api/quota/:address; in-memory
 *   counters, reads never consume quota). Mail older than RETENTION_DAYS is
 *   pruned by server-side arrival time on store and on boot.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { writeLinuxConfigs, generateLinuxConfigs, probeSip } = require('./lib/linux-configs');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT) || 3000;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 2525;
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';
const SMTP_ENABLED = String(process.env.SMTP_ENABLED ?? '1') !== '0';
const SMTP_ACCEPT_ANY_DOMAIN = String(process.env.SMTP_ACCEPT_ANY_DOMAIN ?? '1') !== '0';
const AGENT_COUNT = Math.min(1000, Math.max(1, Number(process.env.AGENT_COUNT) || 1000));
const BASE_EXTENSION = 2000;
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS) || 30);
const DATA_DIR_ENV = process.env.DATA_DIR || path.join(__dirname, 'data');
const IN_MEMORY_ONLY = DATA_DIR_ENV === ':memory:';
const DATA_DIR = IN_MEMORY_ONLY ? null : path.resolve(DATA_DIR_ENV);
const DIRECT_MX_OUTBOUND = String(process.env.DIRECT_MX_OUTBOUND ?? '1') !== '0';
const LOCAL_POSTFIX_HOST = process.env.LOCAL_POSTFIX_HOST || '';
const LOCAL_POSTFIX_PORT = Number(process.env.LOCAL_POSTFIX_PORT) || 25;
// Quota reporting caps (0 = unlimited, reporting only — nothing enforces them yet).
const SEND_MAX_PER_ADDRESS_PER_HOUR = Math.max(0, Number(process.env.SEND_MAX_PER_ADDRESS_PER_HOUR) || 0);
const SEND_MAX_PER_ADDRESS_PER_DAY = Math.max(0, Number(process.env.SEND_MAX_PER_ADDRESS_PER_DAY) || 0);
const ADDRESS_CREATE_MAX_PER_HOUR = Math.max(0, Number(process.env.ADDRESS_CREATE_MAX_PER_HOUR) || 0);
// Relay probe: live SMTP EHLO handshake that sends no mail.
const RELAY_PROBE_TIMEOUT_MS = Math.min(60000, Math.max(500, Number(process.env.RELAY_PROBE_TIMEOUT_MS) || 10000));
const RELAY_PROBE_DOMAIN = String(process.env.RELAY_PROBE_DOMAIN || 'gmail.com').trim().toLowerCase() || 'gmail.com';

// Free local domain by default — never rejects free/local domains or demands paid DNS
function sanitizeDomain(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || 'agents.local';
}

let activeDomain = sanitizeDomain(process.env.MAIL_DOMAIN || 'agents.local');

// Optional DKIM signing (auto-generated locally on Linux disk; zero secret env vars needed)
const DKIM_SELECTOR = String(process.env.DKIM_SELECTOR || 'mail').trim();
const DMARC_POLICY = String(process.env.DMARC_POLICY || 'none').trim();

function loadOrCreateDkimKey() {
  if (IN_MEMORY_ONLY || !DATA_DIR) return '';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const pemPath = path.join(DATA_DIR, 'dkim.pem');
    if (fs.existsSync(pemPath)) {
      return fs.readFileSync(pemPath, 'utf8').trim();
    }
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.writeFileSync(pemPath, privateKey, { encoding: 'utf8', mode: 0o600 });
    return privateKey.trim();
  } catch {
    return '';
  }
}

const DKIM_PRIVATE_KEY = loadOrCreateDkimKey();

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
  if (!publicKey) return { status: 'misconfigured', publicKey: '' };
  return { status: 'configured', publicKey };
}
const DKIM_STATUS = validateDkimConfig();

// --- Persistent local state ---
// agents: Map<extension, { extension, agentId, sipPassword, aliases: string[] }>
// addressOwner: Map<email, extension>
// inboxes: Map<email, EmailRecord[]>
// phoneEvents: Array<{ id, kind: 'text'|'signal', from, to, data, createdAt }>
// guestInvites: Map<token, { token, extension, expiresAt, used }>
// guestSessions: Map<sessionToken, { sessionId, address, extension, expiresAt }>

const agents = new Map();
const agentById = new Map();
const addressOwner = new Map();
const inboxes = new Map();
const seenMessages = new Map();
const SEEN_MAX = 5000;
const phoneEvents = [];
let nextPhoneEventId = 1;
const guestInvites = new Map();
const guestSessions = new Map();
const mailEvents = new EventEmitter();
mailEvents.setMaxListeners(0);

let saveTimer = null;
function schedulePersist() {
  if (IN_MEMORY_ONLY || !DATA_DIR) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 150);
  saveTimer.unref();
}

function atomicWriteJson(filePath, obj, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
}

function persistNow() {
  if (IN_MEMORY_ONLY || !DATA_DIR) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const identitiesObj = {};
    for (const [ext, a] of agents) {
      identitiesObj[ext] = {
        extension: a.extension,
        agentId: a.agentId,
        sipPassword: a.sipPassword,
        aliases: a.aliases,
      };
    }
    atomicWriteJson(path.join(DATA_DIR, 'config.json'), { domain: activeDomain, count: AGENT_COUNT });
    atomicWriteJson(path.join(DATA_DIR, 'identities.json'), { schema: 1, extensions: identitiesObj });

    const inboxObj = {};
    for (const [addr, list] of inboxes) {
      if (list.length) inboxObj[addr] = list;
    }
    atomicWriteJson(path.join(DATA_DIR, 'emails.json'), inboxObj);
    atomicWriteJson(path.join(DATA_DIR, 'phone-events.json'), {
      nextId: nextPhoneEventId,
      events: phoneEvents.slice(-5000),
    });
  } catch (err) {
    console.error('[storage] local disk persist error:', err.message);
  }
}

function rebuildAddressMap() {
  addressOwner.clear();
  for (const a of agents.values()) {
    const primary = `${a.agentId}@${activeDomain}`;
    addressOwner.set(primary, a.extension);
    if (!inboxes.has(primary)) inboxes.set(primary, []);
    for (const alias of a.aliases) {
      const addr = alias.includes('@') ? alias : `${alias}@${activeDomain}`;
      addressOwner.set(addr, a.extension);
      if (!inboxes.has(addr)) inboxes.set(addr, []);
    }
  }
}

function refreshLinuxConfigs() {
  if (IN_MEMORY_ONLY || !DATA_DIR) return;
  try {
    writeLinuxConfigs(path.join(DATA_DIR, 'linux-configs'), {
      domain: activeDomain,
      agents: [...agents.values()],
      smtpPort: SMTP_PORT,
      apiPort: PORT,
    });
  } catch (err) {
    console.warn('[linux-configs] failed to write configs:', err.message);
  }
}

function initStore() {
  let savedConfig = null;
  let savedIdentities = null;
  let savedEmails = null;
  let savedPhone = null;

  if (!IN_MEMORY_ONLY && DATA_DIR) {
    try {
      const cfgPath = path.join(DATA_DIR, 'config.json');
      if (fs.existsSync(cfgPath)) savedConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const idPath = path.join(DATA_DIR, 'identities.json');
      if (fs.existsSync(idPath)) savedIdentities = JSON.parse(fs.readFileSync(idPath, 'utf8'));
      const mailPath = path.join(DATA_DIR, 'emails.json');
      if (fs.existsSync(mailPath)) savedEmails = JSON.parse(fs.readFileSync(mailPath, 'utf8'));
      const phonePath = path.join(DATA_DIR, 'phone-events.json');
      if (fs.existsSync(phonePath)) savedPhone = JSON.parse(fs.readFileSync(phonePath, 'utf8'));
    } catch (err) {
      console.warn('[storage] starting fresh due to unreadable local state:', err.message);
    }
  }

  if (savedConfig && savedConfig.domain && !process.env.MAIL_DOMAIN) {
    activeDomain = sanitizeDomain(savedConfig.domain);
  }

  const savedExtMap = savedIdentities && savedIdentities.extensions ? savedIdentities.extensions : {};
  for (let i = 0; i < AGENT_COUNT; i++) {
    const ext = String(BASE_EXTENSION + i);
    const agentId = `agent-${String(i + 1).padStart(4, '0')}`;
    const prev = savedExtMap[ext];
    const record = {
      extension: ext,
      agentId,
      sipPassword: prev && prev.sipPassword ? prev.sipPassword : crypto.randomBytes(18).toString('base64url'),
      aliases: Array.isArray(prev && prev.aliases) ? prev.aliases : [],
    };
    agents.set(ext, record);
    agentById.set(agentId, ext);
  }

  if (savedEmails && typeof savedEmails === 'object') {
    for (const [addr, list] of Object.entries(savedEmails)) {
      // Prune on boot too: saved mail otherwise survives forever until a
      // new arrival to the same address triggers a store-time prune.
      if (Array.isArray(list)) inboxes.set(addr.toLowerCase(), pruneExpiredEmails(list));
    }
  }

  if (savedPhone && Array.isArray(savedPhone.events)) {
    phoneEvents.push(...savedPhone.events);
    nextPhoneEventId = Number(savedPhone.nextId) || (phoneEvents.length ? phoneEvents[phoneEvents.length - 1].id + 1 : 1);
  }

  rebuildAddressMap();
  if (!IN_MEMORY_ONLY && DATA_DIR) {
    persistNow();
    refreshLinuxConfigs();
  }
}

initStore();

// --- Pure Email Parsing & Extraction Helpers ---
function newId() {
  return `em_${crypto.randomUUID().replace(/-/g, '')}`;
}

function backoffMs(attempt) {
  const base = Math.min(60000, 1000 * 2 ** attempt);
  return Math.round(base * (1 + Math.random() * 0.25));
}

function validLocalPart(local) {
  return typeof local === 'string'
    && local.length >= 1 && local.length <= 64
    && /^[a-z0-9._%+-]+$/.test(local)
    && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

function validAddressParam(addr) {
  if (typeof addr !== 'string' || addr.length === 0 || addr.length > 254) return false;
  const at = addr.indexOf('@');
  if (at <= 0 || at !== addr.lastIndexOf('@') || at === addr.length - 1) return false;
  if (!validLocalPart(addr.slice(0, at))) return false;
  const domain = addr.slice(at + 1);
  if (domain.length > 253) return false;
  const labels = domain.split('.');
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  }
  // TLD must be 2-63 alpha chars: rejects numeric / single-char TLDs that
  // no real mailbox domain has (e.g. agent@host.123, agent@host.x).
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return false;
  return true;
}

function normalizeAddressPrefix(prefix) {
  return String(prefix || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 64);
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

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

function htmlToText(html) {
  const text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|td|th|h\d|li|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/^[^\n]*$/, m => m.replace(/\s+/g, ' '));
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const JUNK_LINK = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf)(\?|#|$)|unsubscribe|list-manage|\/opt-?out|email-preferences|\/preferences|\/pixel|\/open\?|\/track\/open|w3\.org\/|schema\.org/i;
const SOCIAL_LINK = /^https?:\/\/(www\.)?(facebook|twitter|x|instagram|linkedin|youtube|tiktok|apple|play\.google)\.com\//i;
const VERIFY_STRONG = /verif|confirm|activat|validat|magic[-_]?link|reset|one[-_]?time|otp|email[-_]?link|\/auth\/|callback|token=|code=|signup\/complete|ticket=/i;
const VERIFY_WEAK = /sign[-_]?in|log[-_]?in|auth|invite|accept|welcome|continue|complete|click/i;

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

function scoreLink(url) {
  if (JUNK_LINK.test(url)) return -10;
  let score = 0;
  if (VERIFY_STRONG.test(url)) score += 10;
  else if (VERIFY_WEAK.test(url)) score += 4;
  if (SOCIAL_LINK.test(url)) score -= 6;
  if (/[A-Za-z0-9_-]{24,}/.test(url.replace(/^https?:\/\/[^/]+/, ''))) score += 3;
  if (/^https?:\/\/[^/]+\/?$/.test(url)) score -= 3;
  return score;
}

function rankLinks(links) {
  return (links || [])
    .map((url, i) => ({ url, i, score: scoreLink(url) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.url);
}

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
    for (const next of lines.slice(i + 1, i + 3)) {
      if (/^[A-Z0-9][A-Z0-9 -]{2,10}$/.test(next)) scan(next);
    }
  }
  if (!out.length) {
    for (const m of hay.matchAll(/\b\d{4,8}\b/g)) if (!isYear(m[0])) push(m[0]);
  }
  return out.slice(0, 5);
}

function extractAttachments(parsed) {
  return (parsed.attachments || []).map(a => ({
    filename: a.filename || 'unnamed',
    contentType: a.contentType || 'application/octet-stream',
    size: typeof a.size === 'number' ? a.size : (a.content ? a.content.length : 0),
  }));
}

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

function toEmailShape(e) {
  return {
    id: e.id,
    from: e.from,
    subject: e.subject || '',
    date: e.date || e.receivedAt || new Date().toISOString(),
    receivedAt: e.receivedAt || e.date || new Date().toISOString(),
    text: e.text || '',
    links: e.links || [],
    codes: extractCodes(e.subject || '', e.text || ''),
    attachments: e.attachments || [],
  };
}

function seenKey(address, messageId) {
  const id = String(messageId || '').trim().replace(/^<|>$/g, '');
  return id ? `${address}|${id}` : '';
}

function rememberMessage(key, id) {
  if (!key) return;
  seenMessages.set(key, id);
  if (seenMessages.size > SEEN_MAX) seenMessages.delete(seenMessages.keys().next().value);
}

// Retention: the server-side arrival time is the only trustworthy clock.
// The sender-supplied Date header can be out of order, in the future, or
// missing, so a front-only scan keyed on it leaves expired mail buried
// behind a newer-dated first message forever. Filter the whole list by
// receivedAt (falling back to date for records that predate it); records
// with no parseable timestamp at all are kept, never deleted on a guess.
function retentionCutoffMs(nowMs = Date.now()) {
  return nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

function pruneExpiredEmails(list, nowMs = Date.now()) {
  const cutoff = retentionCutoffMs(nowMs);
  return (list || []).filter(e => {
    const t = Date.parse(e.receivedAt || e.date || '');
    return Number.isNaN(t) || t >= cutoff;
  });
}

function storeEmail(record) {
  const addr = record.address.toLowerCase();
  if (!inboxes.has(addr)) inboxes.set(addr, []);
  const emails = inboxes.get(addr);
  const stored = {
    id: record.id || newId(),
    from: record.from || '',
    subject: record.subject || '',
    date: record.date || new Date().toISOString(),
    text: record.text || '',
    links: record.links || [],
    attachments: record.attachments || [],
    receivedAt: new Date().toISOString(),
  };
  emails.push(stored);
  const kept = pruneExpiredEmails(emails);
  emails.length = 0;
  emails.push(...kept);
  if (emails.length > 200) emails.splice(0, emails.length - 200);
  recordReceive(addr);
  schedulePersist();
  mailEvents.emit(addr);
  return toEmailShape(stored);
}

function listEmails(address, { q = '', from = '', since, page, perPage, limit, offset } = {}) {
  q = String(q || '').toLowerCase();
  from = String(from || '').toLowerCase();
  let emails = (inboxes.get(address) || []).slice().reverse().map(toEmailShape);
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

function waitForArrival(address, ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); mailEvents.off(address, done); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    mailEvents.once(address, done);
  });
}

// --- Quota counters (reporting only; caps are env-configured, 0 = unlimited) ---
// In-memory, like the rate buckets that used to live here: counters reset on
// restart, and reads never consume quota. Receives stay visible durably via
// inbox size; sends and address creations exist only in these counters, so
// the API says so honestly (see quotaSummary countersResetOnRestart).
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const sendHits = new Map(); // from-address (lowercase) -> [epochMs of accepted sends]
const receiveHits = new Map(); // address (lowercase) -> [epochMs of stored mail]
const addressCreateHits = []; // [epochMs of actually-created addresses]

function recordHit(map, key, nowMs = Date.now()) {
  const hits = map.get(key) || [];
  hits.push(nowMs);
  const fresh = hits.filter(t => t > nowMs - DAY_MS);
  if (fresh.length) map.set(key, fresh);
  else map.delete(key);
}

function recordSend(from, nowMs = Date.now()) {
  recordHit(sendHits, String(from || '').toLowerCase(), nowMs);
}

function recordReceive(address, nowMs = Date.now()) {
  recordHit(receiveHits, String(address || '').toLowerCase(), nowMs);
}

function recordAddressCreation(nowMs = Date.now()) {
  addressCreateHits.push(nowMs);
  while (addressCreateHits.length && addressCreateHits[0] <= nowMs - DAY_MS) addressCreateHits.shift();
}

function resetQuotaCounters() {
  sendHits.clear();
  receiveHits.clear();
  addressCreateHits.length = 0;
}

// One usage bucket: { limit, used, remaining, resetAt }. limit 0 means
// unlimited (remaining null); resetAt is null when nothing was used.
function bucketUsage(hits, windowMs, limit, nowMs = Date.now()) {
  const recent = (hits || []).filter(t => t > nowMs - windowMs);
  const used = recent.length;
  const resetAt = used ? new Date(recent[0] + windowMs).toISOString() : null;
  if (!limit) return { limit: 0, used, remaining: null, resetAt };
  return { limit, used, remaining: Math.max(0, limit - used), resetAt };
}

function quotaForAddress(address, nowMs = Date.now()) {
  const addr = String(address || '').toLowerCase();
  return {
    address: addr,
    sends: {
      hourly: bucketUsage(sendHits.get(addr), HOUR_MS, SEND_MAX_PER_ADDRESS_PER_HOUR, nowMs),
      last24h: bucketUsage(sendHits.get(addr), DAY_MS, SEND_MAX_PER_ADDRESS_PER_DAY, nowMs),
    },
    receives: {
      last24h: bucketUsage(receiveHits.get(addr), DAY_MS, 0, nowMs),
      stored: (inboxes.get(addr) || []).length,
    },
  };
}

function quotaSummary(nowMs = Date.now()) {
  const active = [...new Set([...sendHits.keys(), ...receiveHits.keys()])].sort();
  let sendsToday = 0;
  let receivesToday = 0;
  for (const key of sendHits.keys()) sendsToday += bucketUsage(sendHits.get(key), DAY_MS, 0, nowMs).used;
  for (const key of receiveHits.keys()) receivesToday += bucketUsage(receiveHits.get(key), DAY_MS, 0, nowMs).used;
  return {
    ok: true,
    domain: activeDomain,
    retentionDays: RETENTION_DAYS,
    countersResetOnRestart: true,
    global: {
      sendsLast24h: sendsToday,
      receivesLast24h: receivesToday,
      addressCreationPerHour: bucketUsage(addressCreateHits, HOUR_MS, ADDRESS_CREATE_MAX_PER_HOUR, nowMs),
    },
    addresses: active.map(a => quotaForAddress(a, nowMs)),
  };
}

// --- Outbound Mail (100% self-hosted: local router, local Postfix, or direct MX) ---
let customSendTransport = null;
function setSendTransport(t) { customSendTransport = t || null; }

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
  if (to.length > 20) {
    return { ok: false, error: 'at most 20 recipients per send' };
  }
  const recipients = [];
  for (const r of to) {
    const addr = typeof r === 'string' ? r.trim().toLowerCase() : '';
    if (!validAddressParam(addr)) {
      return { ok: false, error: `to contains an invalid address: ${String(r).slice(0, 80)}` };
    }
    recipients.push(addr);
  }
  const subject = body.subject === undefined || body.subject === null ? '' : String(body.subject).slice(0, 1000);
  const text = body.text === undefined || body.text === null ? '' : String(body.text);
  const html = body.html === undefined || body.html === null ? '' : String(body.html);
  if (!text && !html) {
    return { ok: false, error: 'text or html body is required' };
  }
  const fromName = String(body.fromName || '').replace(/["\\\r\n<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { ok: true, value: { from, fromName, to: recipients, subject, text, html: html || undefined } };
}

async function deliverDirectMx({ from, toAddr, subject, text, html }) {
  const hostDomain = toAddr.split('@')[1];
  const mxRecords = await dns.resolveMx(hostDomain);
  if (!mxRecords || !mxRecords.length) {
    throw new Error(`No MX records found for ${hostDomain}`);
  }
  mxRecords.sort((a, b) => a.priority - b.priority);
  const transport = nodemailer.createTransport({
    host: mxRecords[0].exchange,
    port: 25,
    secure: false,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    dkim: DKIM_STATUS.status === 'configured'
      ? { domainName: activeDomain, keySelector: DKIM_SELECTOR, privateKey: DKIM_PRIVATE_KEY }
      : undefined,
  });
  return transport.sendMail({ from, to: toAddr, subject, text, html });
}

async function sendAgentMail({ from, fromName, to, subject, text, html }) {
  const localRecipients = [];
  const externalRecipients = [];
  for (const addr of to) {
    if (addr.endsWith(`@${activeDomain}`) || addressOwner.has(addr) || inboxes.has(addr)) {
      localRecipients.push(addr);
    } else {
      externalRecipients.push(addr);
    }
  }

  const deliveredIds = [];
  const bodyText = (text || (html ? htmlToText(html) : '')).slice(0, 10000);
  const links = extractLinks(`${subject}\n${bodyText}`, html || '');
  const now = new Date().toISOString();

  // Instant self-hosted local delivery
  for (const addr of localRecipients) {
    const rec = storeEmail({
      address: addr,
      from: fromName ? `${fromName} <${from}>` : from,
      subject,
      date: now,
      text: bodyText,
      links,
      attachments: [],
    });
    deliveredIds.push(rec.id);
  }

  // External recipients: custom test transport, local Linux Postfix, or direct MX port 25
  if (externalRecipients.length > 0) {
    if (customSendTransport) {
      const info = await customSendTransport.sendMail({
        from: fromName ? `${fromName} <${from}>` : from,
        to: externalRecipients,
        subject,
        text,
        html,
      });
      return {
        provider: 'local-smtp-transport',
        messageId: info.messageId || deliveredIds[0] || newId(),
        accepted: [...localRecipients, ...externalRecipients],
        rejected: [],
      };
    }

    if (LOCAL_POSTFIX_HOST) {
      const transport = nodemailer.createTransport({
        host: LOCAL_POSTFIX_HOST,
        port: LOCAL_POSTFIX_PORT,
        secure: false,
        dkim: DKIM_STATUS.status === 'configured'
          ? { domainName: activeDomain, keySelector: DKIM_SELECTOR, privateKey: DKIM_PRIVATE_KEY }
          : undefined,
      });
      const info = await transport.sendMail({
        from: fromName ? `${fromName} <${from}>` : from,
        to: externalRecipients,
        subject,
        text,
        html,
      });
      return {
        provider: 'linux-postfix',
        messageId: info.messageId || deliveredIds[0] || newId(),
        accepted: [...localRecipients, ...externalRecipients],
        rejected: [],
      };
    }

    if (!DIRECT_MX_OUTBOUND) {
      const err = new Error('External outbound is disabled (local-only mode). Set LOCAL_POSTFIX_HOST or DIRECT_MX_OUTBOUND=1.');
      err.status = 503;
      throw err;
    }

    for (const addr of externalRecipients) {
      try {
        await deliverDirectMx({
          from: fromName ? `${fromName} <${from}>` : from,
          toAddr: addr,
          subject,
          text,
          html,
        });
      } catch (err) {
        const wrapped = new Error(`Direct MX delivery to ${addr} failed (${err.message}). On Linux hosts with outbound port 25 blocked, use local @${activeDomain} mailboxes or configure Postfix.`);
        wrapped.status = 502;
        throw wrapped;
      }
    }
  }

  return {
    provider: externalRecipients.length ? 'direct-mx' : 'local-selfhosted',
    messageId: deliveredIds[0] || newId(),
    accepted: to,
    rejected: [],
  };
}

// --- Outbound relay health (live probe, sends no mail) ---
// Connects, reads the 220 banner, sends EHLO, waits for the final 250 line,
// then QUITs. Local Postfix is probed directly; direct-MX mode has no single
// relay, so the probe resolves the MX of RELAY_PROBE_DOMAIN and handshakes
// with it — that is the check that catches outbound port 25 being blocked.
// Local-only mode has no outbound path to probe and reports unconfigured.
function probeSmtpGreeting(host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let stage = 0; // 0: waiting for 220 banner, 1: waiting for EHLO 250
    let buf = '';
    let done = false;
    const finish = (result, destroySocket = true) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // On success the socket is half-closed (QUIT sent, FIN after it) so
      // the peer's 221 can still arrive; destroying here would RST the
      // connection and raise ECONNRESET on the peer. Other paths destroy.
      if (destroySocket) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, detail: `SMTP probe to ${host}:${port} timed out after ${timeoutMs}ms` }),
      Math.max(100, timeoutMs),
    );
    socket.on('error', err => finish({ ok: false, detail: `SMTP probe to ${host}:${port} failed: ${err.message}` }));
    socket.on('close', () => {
      if (!done) finish({ ok: false, detail: `SMTP probe to ${host}:${port} closed before EHLO completed` });
    });
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\r\n')) return;
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        if (stage === 0) {
          if (!/^220/.test(line)) {
            return finish({ ok: false, detail: `SMTP probe to ${host}:${port} got unexpected banner: ${line.slice(0, 80)}` });
          }
          stage = 1;
          socket.write('EHLO agent-mail-service\r\n');
        } else if (stage === 1) {
          if (!/^250/.test(line)) {
            return finish({ ok: false, detail: `SMTP probe to ${host}:${port} EHLO rejected: ${line.slice(0, 80)}` });
          }
          if (/^250 /.test(line)) {
            // Final 250 line (250- lines are multi-line continuations).
            try { socket.write('QUIT\r\n'); socket.end(); } catch { /* closing anyway */ }
            return finish({ ok: true, detail: `SMTP EHLO ok on ${host}:${port}` }, false);
          }
        }
      }
    });
  });
}

async function relayHealth() {
  const checkedAt = new Date().toISOString();
  if (LOCAL_POSTFIX_HOST) {
    const probe = await probeSmtpGreeting(LOCAL_POSTFIX_HOST, LOCAL_POSTFIX_PORT, RELAY_PROBE_TIMEOUT_MS);
    return {
      provider: 'linux-postfix',
      host: LOCAL_POSTFIX_HOST,
      port: LOCAL_POSTFIX_PORT,
      status: probe.ok ? 'usable' : 'probe-failed',
      detail: probe.detail,
      checkedAt,
    };
  }
  if (!DIRECT_MX_OUTBOUND) {
    return {
      provider: 'local-only',
      status: 'unconfigured',
      detail: 'External outbound is disabled (local-only mode). Set LOCAL_POSTFIX_HOST or DIRECT_MX_OUTBOUND=1.',
      checkedAt,
    };
  }
  let mxHost;
  try {
    const records = await dns.resolveMx(RELAY_PROBE_DOMAIN);
    if (!records || !records.length) throw new Error(`No MX records for ${RELAY_PROBE_DOMAIN}`);
    records.sort((a, b) => a.priority - b.priority);
    mxHost = records[0].exchange;
  } catch (err) {
    return {
      provider: 'direct-mx',
      probeDomain: RELAY_PROBE_DOMAIN,
      status: 'probe-failed',
      detail: `MX lookup for ${RELAY_PROBE_DOMAIN} failed: ${err.message}`,
      checkedAt,
    };
  }
  const probe = await probeSmtpGreeting(mxHost, 25, RELAY_PROBE_TIMEOUT_MS);
  return {
    provider: 'direct-mx',
    probeDomain: RELAY_PROBE_DOMAIN,
    mxHost,
    status: probe.ok ? 'usable' : 'probe-failed',
    detail: probe.detail,
    checkedAt,
  };
}

// --- Built-in SMTP Listener ---
const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  size: 10 * 1024 * 1024,
  onRcptTo(address, _session, callback) {
    const target = address.address.toLowerCase();
    if (!SMTP_ACCEPT_ANY_DOMAIN && !target.endsWith(`@${activeDomain}`)) {
      const err = new Error(`Only accepting mail for @${activeDomain}`);
      err.responseCode = 550;
      return callback(err);
    }
    callback();
  },
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(parsed => {
        const envelope = (session.envelope?.rcptTo || []).map(a => a.address.toLowerCase());
        const toAddrs = envelope.length
          ? envelope
          : (parsed.to?.value || []).map(a => a.address.toLowerCase());
        const html = typeof parsed.html === 'string' ? parsed.html : '';
        const bodyText = parsed.text || (html ? htmlToText(html) : '');
        const links = extractLinks(`${parsed.subject || ''}\n${bodyText}`, html);
        const attachments = extractAttachments(parsed);
        for (const addr of toAddrs) {
          const dedupeKey = seenKey(addr, parsed.messageId);
          if (dedupeKey && seenMessages.has(dedupeKey)) continue;
          const record = storeEmail({
            address: addr,
            from: parsed.from?.text || '',
            subject: parsed.subject || '',
            date: parsed.date?.toISOString() || new Date().toISOString(),
            text: bodyText.slice(0, 10000),
            links,
            attachments,
          });
          rememberMessage(dedupeKey, record.id);
        }
        callback();
      })
      .catch(err => {
        console.error('[smtp] parse error:', err.message);
        callback();
      });
  },
});

// --- Phone & WebRTC Helpers ---
function resolveExtension(value) {
  const s = String(value || '').trim();
  if (agents.has(s)) return s;
  if (agentById.has(s)) return agentById.get(s);
  return null;
}

function addPhoneEvent({ kind, from, to, data }) {
  const ev = {
    id: nextPhoneEventId++,
    kind,
    from,
    to,
    data,
    createdAt: new Date().toISOString(),
  };
  phoneEvents.push(ev);
  if (phoneEvents.length > 5000) phoneEvents.splice(0, phoneEvents.length - 5000);
  schedulePersist();
  return ev;
}

function getPhoneEvents(extension, kind, after = 0, limit = 100) {
  const out = [];
  for (const ev of phoneEvents) {
    if (ev.id <= after || ev.kind !== kind) continue;
    if (ev.to === extension || (kind === 'text' && ev.from === extension)) {
      out.push(ev);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// --- HTTP Routes (100% plug-and-play, zero API keys required) ---
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/call/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: 'self-hosted-linux-plug-and-play',
    thirdPartyApis: false,
    apiKeysRequired: false,
    domain: activeDomain,
    agents: agents.size,
    addresses: addressOwner.size,
    storage: IN_MEMORY_ONLY ? 'memory' : 'local-disk',
    dataDir: DATA_DIR || ':memory:',
    smtpListenerEnabled: SMTP_ENABLED,
    smtpPort: SMTP_PORT,
    dkim: DKIM_STATUS.status,
  });
});

app.get('/api/dns', (_req, res) => {
  const host = String(process.env.MX_HOST || activeDomain).trim().toLowerCase();
  const records = [
    { type: 'MX', name: activeDomain, priority: 10, value: host, purpose: 'Route internet mail to this Linux host' },
    { type: 'A', name: host, value: '<your Linux public IP>', purpose: 'MX host IPv4' },
    { type: 'TXT', name: activeDomain, value: 'v=spf1 a mx ~all', purpose: 'SPF record' },
    { type: 'TXT', name: `_dmarc.${activeDomain}`, value: `v=DMARC1; p=${DMARC_POLICY}`, purpose: 'DMARC record' },
  ];
  if (DKIM_STATUS.publicKey) {
    records.push({
      type: 'TXT',
      name: `${DKIM_SELECTOR}._domainkey.${activeDomain}`,
      value: `v=DKIM1; k=rsa; p=${DKIM_STATUS.publicKey}`,
      purpose: 'DKIM public key',
    });
  }
  res.json({ ok: true, domain: activeDomain, dkim: DKIM_STATUS.status, records });
});

// Outbound relay health: 200 when the outbound path handshakes, 503 when it
// is unconfigured or the live probe fails. The probe sends no mail.
app.get('/api/relay', async (_req, res) => {
  const health = await relayHealth();
  res.status(health.status === 'usable' ? 200 : 503).json({ ok: health.status === 'usable', ...health });
});

// Quota usage reporting (read-only; reads never consume quota). Limits are
// env-configured and 0 means unlimited; counters are in-memory and reset on
// restart, while stored inbox counts survive restarts on disk.
app.get('/api/quota', (_req, res) => {
  res.json(quotaSummary());
});

app.get('/api/quota/:address', (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) {
    return res.status(400).json({ ok: false, error: 'Invalid address format' });
  }
  if (!addressOwner.has(addr) && !(inboxes.get(addr) || []).length) {
    return res.status(404).json({ ok: false, error: 'Unknown address' });
  }
  res.json({ ok: true, ...quotaForAddress(addr) });
});

// Change active free domain anytime (zero restrictions on .local/.lan/duckdns/custom)
app.post('/api/domain', (req, res) => {
  const nextDomain = sanitizeDomain((req.body || {}).domain);
  activeDomain = nextDomain;
  rebuildAddressMap();
  persistNow();
  refreshLinuxConfigs();
  res.json({ ok: true, domain: activeDomain, totalAgents: agents.size });
});

// Directory of 1,000 agents + extensions + mailboxes
app.get('/api/agents', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page, 10) || 25));

  let list = [...agents.values()].map(a => ({
    extension: a.extension,
    agentId: a.agentId,
    email: `${a.agentId}@${activeDomain}`,
    webPhoneNumber: `web:${a.extension}`,
    sipUri: `sip:${a.extension}@${activeDomain}:5060`,
    aliases: a.aliases.map(al => (al.includes('@') ? al : `${al}@${activeDomain}`)),
  }));

  if (q) {
    list = list.filter(a =>
      a.extension.includes(q) ||
      a.agentId.includes(q) ||
      a.email.includes(q) ||
      a.aliases.some(al => al.includes(q)));
  }

  const total = list.length;
  const start = (page - 1) * perPage;
  res.json({
    ok: true,
    domain: activeDomain,
    total,
    page,
    perPage,
    pages: Math.max(1, Math.ceil(total / perPage)),
    agents: list.slice(start, start + perPage),
  });
});

app.get('/api/agents/:extension/addresses', (req, res) => {
  const ext = resolveExtension(req.params.extension);
  if (!ext) return res.status(404).json({ ok: false, error: 'Unknown agent/extension' });
  const a = agents.get(ext);
  const addresses = [`${a.agentId}@${activeDomain}`];
  for (const alias of a.aliases) {
    addresses.push(alias.includes('@') ? alias : `${alias}@${activeDomain}`);
  }
  res.json({ ok: true, extension: ext, agentId: a.agentId, addresses });
});

// Free custom email creation — never fails with "invite required" or "try another name"
app.post('/api/addresses', (req, res) => {
  const body = req.body || {};
  let rawPrefix = String(body.prefix || '').trim().toLowerCase();
  let targetDomain = activeDomain;
  if (rawPrefix.includes('@')) {
    const parts = rawPrefix.split('@');
    rawPrefix = parts[0];
    if (parts[1]) targetDomain = sanitizeDomain(parts[1]);
  }
  let prefix = normalizeAddressPrefix(rawPrefix);
  if (!prefix) prefix = `mail-${Date.now().toString(36)}`;
  const address = `${prefix}@${targetDomain}`;
  const ext = resolveExtension(body.extension || body.agentId || '2000') || '2000';
  const agent = agents.get(ext);

  const existingOwner = addressOwner.get(address);
  if (existingOwner) {
    return res.json({ ok: true, existing: true, address, extension: existingOwner });
  }

  const aliasValue = targetDomain === activeDomain ? prefix : address;
  if (agent && !agent.aliases.includes(aliasValue)) {
    agent.aliases.push(aliasValue);
  }
  addressOwner.set(address, ext);
  if (!inboxes.has(address)) inboxes.set(address, []);
  recordAddressCreation();
  schedulePersist();
  res.json({ ok: true, existing: false, address, extension: ext });
});

app.get('/api/addresses', (_req, res) => {
  const list = [];
  for (const [address, ext] of addressOwner) {
    list.push({
      address,
      extension: ext,
      emails: (inboxes.get(address) || []).length,
    });
  }
  res.json({ ok: true, count: list.length, addresses: list });
});

app.post('/api/send', async (req, res) => {
  try {
    const v = validateSendBody(req.body || {});
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    const result = await sendAgentMail(v.value);
    recordSend(v.value.from);
    res.json({
      ok: true,
      from: v.value.from,
      to: v.value.to,
      ...result,
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/inbox/:address', (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) {
    return res.status(400).json({ ok: false, error: 'Invalid address format' });
  }
  const hasLimitOffset = req.query.limit !== undefined || req.query.offset !== undefined;
  const data = listEmails(addr, {
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
    count: data.emails.length,
    total: data.total,
    page: data.page,
    perPage: data.perPage,
    pages: data.pages,
    limit: data.limit,
    offset: data.offset,
    emails: data.emails.map(e => ({
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
});

app.get('/api/inbox/:address/:id', (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) {
    return res.status(400).json({ ok: false, error: 'Invalid address format' });
  }
  const email = (inboxes.get(addr) || []).find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ ok: false, error: 'Not found' });
  const shaped = toEmailShape(email);
  res.json({ ok: true, email: { ...shaped, bestLinks: rankLinks(shaped.links) } });
});

app.delete('/api/inbox/:address', (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) {
    return res.status(400).json({ ok: false, error: 'Invalid address format' });
  }
  inboxes.set(addr, []);
  schedulePersist();
  res.json({ ok: true });
});

async function longPoll(req, res, pick, timeoutError) {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) {
    return res.status(400).json({ ok: false, error: 'Invalid address format' });
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
    const { emails } = listEmails(addr, { perPage: 50, since });
    const found = pick(emails, fromFilter);
    if (found) {
      return res.json({ ok: true, waitedMs: Math.round(Date.now() - startedAt), ...found });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0 || closed) break;
    await waitForArrival(addr, Math.min(2000, remaining));
  }
  if (!closed) res.json({ ok: false, error: timeoutError, timeoutMs });
}

app.get('/api/verify-link/:address', (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) return res.status(400).json({ ok: false, error: 'Invalid address format' });
  const { emails } = listEmails(addr, { perPage: 50, since: req.query.since });
  const found = findVerifyLink(emails, String(req.query.from || '').toLowerCase());
  if (found) return res.json({ ok: true, ...found });
  res.json({ ok: false, error: 'No verification email yet' });
});

app.get('/api/verify-link/:address/wait', (req, res) =>
  longPoll(req, res, findVerifyLink, 'Timed out waiting for verification email'));

app.get('/api/code/:address', (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  if (!validAddressParam(addr)) return res.status(400).json({ ok: false, error: 'Invalid address format' });
  const { emails } = listEmails(addr, { perPage: 50, since: req.query.since });
  const found = findCode(emails, String(req.query.from || '').toLowerCase());
  if (found) return res.json({ ok: true, ...found });
  res.json({ ok: false, error: 'No email with a code yet' });
});

app.get('/api/code/:address/wait', (req, res) =>
  longPoll(req, res, findCode, 'Timed out waiting for a code'));

app.get('/api/wait/:address', (req, res) =>
  longPoll(req, res, (emails, fromFilter) => {
    const e = fromFilter
      ? emails.find(x => String(x.from || '').toLowerCase().includes(fromFilter))
      : emails[0];
    if (!e) return null;
    const best = rankLinks(e.links).filter(u => scoreLink(u) > -10);
    return { email: { ...e, bestLinks: rankLinks(e.links) }, code: (e.codes || [])[0] || null, link: best[0] || null };
  }, 'Timed out waiting for mail'));

// --- Phone SMS & WebRTC Signaling API ---
app.get(['/api/phone/messages', '/api/sms/inbox'], (req, res) => {
  const ext = resolveExtension(req.query.extension || '2000');
  if (!ext) return res.status(404).json({ ok: false, error: 'Unknown extension' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const events = getPhoneEvents(ext, 'text', after, limit);
  res.json({ ok: true, extension: ext, events, cursor: events.length ? events[events.length - 1].id : after });
});

app.post(['/api/phone/messages', '/api/sms/send'], (req, res) => {
  const body = req.body || {};
  const from = resolveExtension(body.from || '2000');
  const to = String(body.to || '').startsWith('guest:') ? body.to : resolveExtension(body.to);
  if (!from) return res.status(400).json({ ok: false, error: 'Invalid sender extension' });
  if (!to) return res.status(404).json({ ok: false, error: 'Unknown recipient extension (use 2000-2999)' });
  if (to === from) return res.status(400).json({ ok: false, error: 'Cannot send to self' });
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 2000) return res.status(400).json({ ok: false, error: 'text must be 1-2000 characters' });
  const ev = addPhoneEvent({ kind: 'text', from, to, data: { text } });
  res.status(201).json({ ok: true, id: ev.id, from, to, createdAt: ev.createdAt });
});

// Receives real SMS from Linux ModemManager USB SIM modem bridge
app.post('/api/phone/inbound-sim', (req, res) => {
  const body = req.body || {};
  const to = resolveExtension(body.to || '2000') || '2000';
  const raw = body.raw && body.raw.sms ? body.raw.sms : body.raw || body;
  const sender = String(raw.number || body.from || 'SIM-Carrier');
  const text = String(raw.text || body.text || '').slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: 'Missing SMS text' });
  const ev = addPhoneEvent({ kind: 'text', from: sender, to, data: { text, source: 'linux-usb-sim' } });
  res.status(201).json({ ok: true, id: ev.id, to, from: sender });
});

app.get('/api/phone/signals/cursor', (req, res) => {
  const ext = resolveExtension(req.query.extension || '2000');
  if (!ext) return res.status(404).json({ ok: false, error: 'Unknown extension' });
  let latest = 0;
  for (const ev of phoneEvents) {
    if (ev.kind === 'signal' && ev.to === ext && ev.id > latest) latest = ev.id;
  }
  res.json({ ok: true, cursor: latest });
});

app.get('/api/phone/signals', (req, res) => {
  const ext = resolveExtension(req.query.extension || '2000');
  if (!ext) return res.status(404).json({ ok: false, error: 'Unknown extension' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const events = getPhoneEvents(ext, 'signal', after, limit);
  res.json({ ok: true, events, cursor: events.length ? events[events.length - 1].id : after });
});

app.post('/api/phone/signals', (req, res) => {
  const body = req.body || {};
  const from = resolveExtension(body.from || '2000');
  const to = String(body.to || '').startsWith('guest:') ? body.to : resolveExtension(body.to);
  if (!from || !to) return res.status(400).json({ ok: false, error: 'Valid from/to extension required' });
  if (!['offer', 'answer', 'candidate', 'hangup'].includes(body.type)) {
    return res.status(400).json({ ok: false, error: 'Invalid signal type' });
  }
  const ev = addPhoneEvent({ kind: 'signal', from, to, data: { type: body.type, value: body.value ?? null } });
  res.status(201).json({ ok: true, id: ev.id });
});

// --- Guest WebPhone Invites ---
app.post('/api/webphone/invites', (req, res) => {
  const body = req.body || {};
  const ext = resolveExtension(body.extension || '2000') || '2000';
  const ttlMinutes = Math.min(1440, Math.max(1, Number(body.ttlMinutes) || 30));
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
  guestInvites.set(token, { token, extension: ext, expiresAt, used: false });
  res.status(201).json({
    ok: true,
    token,
    extension: ext,
    webNumber: `web:${ext}`,
    path: `/call/${token}`,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

app.post('/api/webphone/session', (req, res) => {
  const invite = guestInvites.get(String((req.body || {}).invite || ''));
  if (!invite || invite.used || invite.expiresAt < Date.now()) {
    return res.status(401).json({ ok: false, error: 'Invitation invalid, expired, or already used' });
  }
  invite.used = true;
  const sessionToken = crypto.randomBytes(24).toString('base64url');
  const sessionId = crypto.randomBytes(4).toString('hex');
  const address = `guest:${sessionId}`;
  guestSessions.set(sessionToken, {
    sessionId,
    address,
    extension: invite.extension,
    expiresAt: invite.expiresAt,
  });
  res.status(201).json({
    ok: true,
    token: sessionToken,
    sessionId,
    webNumber: `web:${invite.extension}`,
    expiresAt: new Date(invite.expiresAt).toISOString(),
  });
});

function guestFromReq(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  const sess = guestSessions.get(m[1]);
  if (!sess || sess.expiresAt < Date.now()) return null;
  return sess;
}

app.get('/api/webphone/guest/events', (req, res) => {
  const guest = guestFromReq(req);
  if (!guest) return res.status(401).json({ ok: false, error: 'Guest session invalid or expired' });
  const kind = req.query.kind === 'text' ? 'text' : 'signal';
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  const events = getPhoneEvents(guest.address, kind, after, 100);
  res.json({ ok: true, events, cursor: events.length ? events[events.length - 1].id : after });
});

app.post('/api/webphone/guest/signal', (req, res) => {
  const guest = guestFromReq(req);
  if (!guest) return res.status(401).json({ ok: false, error: 'Guest session invalid or expired' });
  const body = req.body || {};
  if (!['offer', 'answer', 'candidate', 'hangup'].includes(body.type)) {
    return res.status(400).json({ ok: false, error: 'Invalid signal type' });
  }
  const ev = addPhoneEvent({
    kind: 'signal',
    from: guest.address,
    to: guest.extension,
    data: { type: body.type, value: body.value ?? null },
  });
  res.status(201).json({ ok: true, id: ev.id });
});

app.post('/api/webphone/guest/message', (req, res) => {
  const guest = guestFromReq(req);
  if (!guest) return res.status(401).json({ ok: false, error: 'Guest session invalid or expired' });
  const text = typeof (req.body || {}).text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 2000) return res.status(400).json({ ok: false, error: 'text must be 1-2000 characters' });
  const ev = addPhoneEvent({
    kind: 'text',
    from: guest.address,
    to: guest.extension,
    data: { text },
  });
  res.status(201).json({ ok: true, id: ev.id });
});

// --- Linux Self-Hosting Configs & Live SIP Probe ---
app.get('/api/linux/status', async (_req, res) => {
  const files = generateLinuxConfigs({
    domain: activeDomain,
    agents: [...agents.values()],
    smtpPort: SMTP_PORT,
    apiPort: PORT,
  });
  const sipProbe = await probeSip('127.0.0.1', 5060, 400);
  res.json({
    ok: true,
    status: {
      domain: activeDomain,
      totalMailboxes: agents.size,
      totalExtensions: agents.size,
      extensionRange: `${BASE_EXTENSION}-${BASE_EXTENSION + agents.size - 1}`,
      smtpPort: SMTP_PORT,
      smtpListening: SMTP_ENABLED,
      dataDir: DATA_DIR || ':memory:',
      asteriskSip5060: sipProbe,
      thirdPartyApis: 'NONE (100% self-hosted)',
    },
    files,
  });
});

app.post('/api/linux/sip-probe', async (req, res) => {
  const body = req.body || {};
  const host = String(body.host || '127.0.0.1').trim();
  const port = Math.min(65535, Math.max(1, Number(body.port) || 5060));
  const result = await probeSip(host, port, 1500);
  res.json(result);
});

if (require.main === module) {
  smtp.on('error', err => {
    console.error(`[smtp] server error: ${err.message}`);
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') process.exit(1);
  });
  if (SMTP_ENABLED) {
    smtp.listen(SMTP_PORT, SMTP_HOST, () => {
      console.log(`[smtp] built-in SMTP listening on ${SMTP_HOST}:${SMTP_PORT}`);
    });
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ready] Self-hosted Linux Agent Mail & Phone listening on http://0.0.0.0:${PORT}`);
    console.log(`[ready] ${agents.size} free mailboxes (agent-0001@${activeDomain}..agent-${String(agents.size).padStart(4, '0')}@${activeDomain}) & extensions (${BASE_EXTENSION}-${BASE_EXTENSION + agents.size - 1}) ready — ZERO API keys!`);
  });
}

module.exports = {
  app,
  smtp,
  agents,
  inboxes,
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
  sanitizeDomain,
  backoffMs,
  validateSendBody,
  sendAgentMail,
  setSendTransport,
  storeEmail,
  dkimPublicKeyRecord,
  pruneExpiredEmails,
  retentionCutoffMs,
  bucketUsage,
  quotaForAddress,
  quotaSummary,
  recordSend,
  recordReceive,
  recordAddressCreation,
  resetQuotaCounters,
  probeSmtpGreeting,
  relayHealth,
};
