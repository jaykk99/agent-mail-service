/**
 * Pure link/code extraction for the Cloudflare Email Worker.
 *
 * Mirrors the helpers in server.js so a code or link found here matches what
 * the service stores for the same message. No Node or Workers globals, so it
 * unit-tests with plain `node`.
 */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
// Never useful to an agent: static assets, tracking pixels, list management.
const JUNK_LINK = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf)(\?|#|$)|unsubscribe|list-manage|\/opt-?out|email-preferences|\/preferences|\/pixel|\/open\?|\/track\/open|w3\.org\/|schema\.org/i;
const SOCIAL_LINK = /^https?:\/\/(www\.)?(facebook|twitter|x|instagram|linkedin|youtube|tiktok|apple|play\.google)\.com\//i;
const VERIFY_STRONG = /verif|confirm|activat|validat|magic[-_]?link|reset|one[-_]?time|otp|email[-_]?link|\/auth\/|callback|token=|code=|signup\/complete|ticket=/i;
const VERIFY_WEAK = /sign[-_]?in|log[-_]?in|auth|invite|accept|welcome|continue|complete|click/i;

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

// Decode the HTML entities that show up in mail bodies and href values.
export function decodeEntities(str) {
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

// Plain-text fallback for deliveries that carry only HTML. Block tags become
// line breaks so a code on its own row stays on its own line.
export function htmlToText(html) {
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

// Extract URLs. `html` is mined for href values first, since a verification
// link often exists ONLY behind an anchor, with entities decoded so `&amp;`
// does not corrupt the query string. Bare URLs follow; trailing sentence
// punctuation is trimmed and duplicates removed.
export function extractLinks(text, html) {
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
export function scoreLink(url) {
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
export function rankLinks(links) {
  return (links || [])
    .map((url, i) => ({ url, i, score: scoreLink(url) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.url);
}

// Pull likely one-time codes from a subject + plain-text body, best first.
// Pass 1 takes codes on (or right after) a line that mentions a code keyword;
// pass 2 falls back to any lone 4-8 digit number. Phone numbers, years,
// currency amounts and URLs are ignored.
export function extractCodes(subject, text) {
  const hay = `${subject || ''}\n${text || ''}`
    .replace(URL_RE, ' ')
    .replace(/\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g, ' ')
    .replace(/\+?\d{1,3}[-.\s]\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/\b\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/[$€£]\s?\d[\d,.]*/g, ' ');
  const out = [];
  const push = c => {
    if (!out.includes(c)) out.push(c);
  };
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

// The single best code in a message, or null.
export function bestCode(subject, text) {
  return extractCodes(subject, text)[0] || null;
}

// The single best action link in a message, or null when only junk exists.
export function bestLink(text, html) {
  const links = rankLinks(extractLinks(text, html));
  return links.find(u => scoreLink(u) > -10) || null;
}
