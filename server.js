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
 *
 * Storage: Supabase table `agent_emails` when SUPABASE_URL and
 * SUPABASE_SERVICE_KEY are set; otherwise falls back to an in-memory
 * Map so local dev keeps working with no config.
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

// In-memory fallback: address -> [{ id, from, subject, date, text, links }]
const inboxes = new Map();
let emailCounter = 0;

function newId() {
  return `em_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
  };
}

async function storeEmail({ address, from, subject, date, text, links }) {
  if (useSupabase) {
    const { error } = await supabase.from('agent_emails').insert({
      id: newId(),
      address,
      from_addr: from,
      subject,
      date,
      text_body: text,
      links,
    });
    if (error) throw error;
    return;
  }
  if (!inboxes.has(address)) inboxes.set(address, []);
  const emails = inboxes.get(address);
  emails.push({
    id: `em_${++emailCounter}`,
    from,
    subject,
    date,
    text,
    links,
  });
  // Keep inbox bounded
  if (emails.length > 50) emails.shift();
}

// Newest first, max 50
async function listEmails(address) {
  if (useSupabase) {
    const { data, error } = await supabase
      .from('agent_emails')
      .select('id, address, from_addr, subject, date, text_body, links, created_at')
      .eq('address', address)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return (data || []).map(toEmailShape);
  }
  const emails = inboxes.get(address) || [];
  return emails.slice(-50).reverse().map(toEmailShape);
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
      .then(async parsed => {
        try {
          const toAddrs = (parsed.to?.value || []).map(a => a.address.toLowerCase());
          const links = extractLinks(`${parsed.subject || ''}\n${parsed.text || ''}`);
          for (const addr of toAddrs) {
            await storeEmail({
              address: addr,
              from: parsed.from?.text || '',
              subject: parsed.subject || '',
              date: parsed.date?.toISOString() || new Date().toISOString(),
              text: (parsed.text || '').slice(0, 10000),
              links,
            });
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
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Create a new email address
app.post('/api/addresses', auth, (req, res) => {
  const prefix = String(req.body.prefix || `agent${Date.now().toString(36)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');
  const address = `${prefix}@${DOMAIN}`;
  // No DB write needed until mail arrives; memory path keeps a local entry
  if (!useSupabase && !inboxes.has(address)) inboxes.set(address, []);
  res.json({ ok: true, address });
});

// List emails for an address
app.get('/api/inbox/:address', auth, async (req, res) => {
  try {
    const addr = decodeURIComponent(req.params.address).toLowerCase();
    const emails = await listEmails(addr);
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
    const emails = await listEmails(addr); // newest first
    const candidates = fromFilter
      ? emails.filter(e => e.from.toLowerCase().includes(fromFilter))
      : emails;
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

app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}, domain=${DOMAIN}`);
});
