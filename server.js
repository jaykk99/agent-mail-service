/**
 * Agent Mail Service — self-hosted email for AI agents.
 *
 * Receives emails via SMTP and exposes them via a simple REST API
 * so the Error Inbox MCP can poll for provider verification emails
 * without depending on Gmail or temp-mail services.
 *
 * Endpoints:
 *   POST /api/addresses          { prefix } -> { address }
 *   GET  /api/inbox/:address     -> list of received emails
 *   GET  /api/inbox/:address/:id -> full email (subject, body, links)
 *   DELETE /api/inbox/:address   -> clear inbox
 *
 * Auth: Bearer token from AGENT_MAIL_TOKEN env var.
 */

const express = require('express');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SMTP_PORT = process.env.SMTP_PORT || 2525;
const TOKEN = process.env.AGENT_MAIL_TOKEN || 'dev-token-change-me';
const DOMAIN = process.env.MAIL_DOMAIN || 'localhost';

// In-memory inbox: address -> [{ id, from, subject, date, text, html, links }]
const inboxes = new Map();
let emailCounter = 0;

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// Extract URLs from text
function extractLinks(text) {
  const matches = text.match(/https?:\/\/[^\s<>"')]+/g) || [];
  return [...new Set(matches)];
}

// --- SMTP server: receives incoming mail ---
const smtp = new SMTPServer({
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  onData(stream, session, callback) {
    simpleParser(stream)
      .then(parsed => {
        const toAddrs = (parsed.to?.value || []).map(a => a.address.toLowerCase());
        const links = extractLinks(`${parsed.subject || ''}\n${parsed.text || ''}`);
        for (const addr of toAddrs) {
          if (!inboxes.has(addr)) inboxes.set(addr, []);
          inboxes.get(addr).push({
            id: `em_${++emailCounter}`,
            from: parsed.from?.text || '',
            subject: parsed.subject || '',
            date: parsed.date?.toISOString() || new Date().toISOString(),
            text: (parsed.text || '').slice(0, 10000),
            links,
          });
          // Keep inbox bounded
          if (inboxes.get(addr).length > 50) inboxes.get(addr).shift();
        }
        console.log(`[smtp] received mail for ${toAddrs.join(', ')}`);
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

app.get('/health', (req, res) => {
  res.json({ ok: true, domain: DOMAIN, addresses: inboxes.size });
});

// Create a new email address
app.post('/api/addresses', auth, (req, res) => {
  const prefix = String(req.body.prefix || `agent${Date.now().toString(36)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  const address = `${prefix}@${DOMAIN}`;
  if (!inboxes.has(address)) inboxes.set(address, []);
  res.json({ ok: true, address });
});

// List emails for an address
app.get('/api/inbox/:address', auth, (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  const emails = inboxes.get(addr) || [];
  res.json({
    ok: true,
    address: addr,
    count: emails.length,
    emails: emails.map(e => ({
      id: e.id,
      from: e.from,
      subject: e.subject,
      date: e.date,
    })),
  });
});

// Get full email
app.get('/api/inbox/:address/:id', auth, (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  const emails = inboxes.get(addr) || [];
  const email = emails.find(e => e.id === req.params.id);
  if (!email) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, email });
});

// Poll for verification link (newest email matching sender filter)
app.get('/api/verify-link/:address', auth, (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  const fromFilter = (req.query.from || '').toLowerCase();
  const emails = inboxes.get(addr) || [];
  const candidates = fromFilter
    ? emails.filter(e => e.from.toLowerCase().includes(fromFilter))
    : emails;
  for (let i = candidates.length - 1; i >= 0; i--) {
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
});

// Clear inbox
app.delete('/api/inbox/:address', auth, (req, res) => {
  const addr = decodeURIComponent(req.params.address).toLowerCase();
  inboxes.set(addr, []);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}, domain=${DOMAIN}`);
});
