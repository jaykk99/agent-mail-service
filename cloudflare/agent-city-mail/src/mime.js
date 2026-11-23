// Small dependency-free MIME reader (text/plain preferred, HTML stripped).
const decodeQP = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const utf8 = (bin) => { try { return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); } catch { return bin; } };
const b64 = (s) => { try { return utf8(atob(s.replace(/\s+/g, ''))); } catch { return s; } };
const decodeWord = (s) => s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, _c, enc, data) =>
  enc.toUpperCase() === 'B' ? b64(data) : utf8(decodeQP(data.replace(/_/g, ' '))));
function split(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ''];
}
function headers(head) {
  const map = new Map();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c > 0) { const k = line.slice(0, c).trim().toLowerCase(); if (!map.has(k)) map.set(k, line.slice(c + 1).trim()); }
  }
  return map;
}
function body(h, b) {
  const cte = (h.get('content-transfer-encoding') || '').toLowerCase();
  if (cte === 'base64') return b64(b);
  if (cte === 'quoted-printable') return utf8(decodeQP(b));
  return b;
}
function walk(h, b) {
  const ct = h.get('content-type') || 'text/plain';
  const boundary = ct.match(/boundary="?([^";]+)"?/i)?.[1];
  if (/^multipart\//i.test(ct) && boundary) {
    const out = {};
    for (const part of b.split('--' + boundary).slice(1)) {
      if (part.startsWith('--')) break;
      const [ph, pb] = split(part.replace(/^\r?\n/, ''));
      const r = walk(headers(ph), pb);
      out.text ??= r.text; out.html ??= r.html;
    }
    return out;
  }
  const t = body(h, b);
  return /text\/html/i.test(ct) ? { html: t } : { text: t };
}
export async function parseMime(stream) {
  const buf = await new Response(stream).arrayBuffer();
  // latin1 keeps raw bytes so base64/QP parts decode to real UTF-8 later.
  const raw = Array.from(new Uint8Array(buf), (c) => String.fromCharCode(c)).join('');
  const [hh, bb] = split(raw);
  const h = headers(hh);
  const r = walk(h, bb);
  const text = (r.text?.trim() ? utf8(r.text).trim() : '') || utf8(r.html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
  return { subject: decodeWord(h.get('subject') || '(no subject)'), text, messageId: (h.get('message-id') || '').replace(/[<>]/g, '') };
}
