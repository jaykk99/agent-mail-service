import PostalMime from 'postal-mime';
import { bestCode, bestLink, htmlToText } from './extract.js';

function formatFrom(from) {
  if (!from) return '';
  if (typeof from === 'string') return from;
  if (from.name && from.address) return `${from.name} <${from.address}>`;
  return from.address || '';
}

function isoDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${url} -> ${res.status} ${detail.slice(0, 200)}`);
  }
  return res;
}

/**
 * Catch-all handler: Cloudflare Email Routing hands us every message for the
 * domain. We parse it, pull the best one-time code and action link, store the
 * full message in agent-mail-service, and (optionally) push the extracted
 * values straight to agent memory.
 *
 * Throwing on a failed backend call is deliberate: Cloudflare retries the
 * delivery instead of dropping a verification email.
 */
export default {
  async email(message, env) {
    if (!env.INBOUND_URL) throw new Error('INBOUND_URL is not set');
    if (!env.INBOUND_SECRET) throw new Error('INBOUND_SECRET is not set');

    const parsed = await PostalMime.parse(message.raw);
    const envelopeTo = message.to || (parsed.to && parsed.to[0] && parsed.to[0].address) || '';
    const to = String(envelopeTo).trim().toLowerCase();
    if (!to) {
      console.warn('dropping message with no recipient');
      return;
    }

    const subject = parsed.subject || '';
    const html = typeof parsed.html === 'string' ? parsed.html : '';
    const text = parsed.text || (html ? htmlToText(html) : '');
    const code = bestCode(subject, text);
    const link = bestLink(`${subject}\n${text}`, html);
    const from = formatFrom(parsed.from);
    const messageId = parsed.messageId || null;
    const date = isoDate(parsed.date);

    await postJson(
      env.INBOUND_URL,
      { to, from, subject, text, html, messageId, date },
      { authorization: `Bearer ${env.INBOUND_SECRET}` },
    );

    if (env.AGENT_WEBHOOK_URL) {
      const headers = env.AGENT_WEBHOOK_SECRET
        ? { authorization: `Bearer ${env.AGENT_WEBHOOK_SECRET}` }
        : {};
      try {
        await postJson(env.AGENT_WEBHOOK_URL, { to, from, subject, code, link, messageId, date }, headers);
      } catch (err) {
        // The service already stored the mail; a webhook outage must not make
        // Cloudflare redeliver and duplicate it.
        console.warn(`agent webhook failed: ${err.message}`);
      }
    }

    console.log(JSON.stringify({ type: 'email', to, code: code ? 1 : 0, link: link ? 1 : 0 }));
  },
};
