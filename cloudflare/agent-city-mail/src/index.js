import PostalMime from 'postal-mime';

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  },
});
const EMAIL_RE = /^[^\s@<>]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i;
export function validateAgentId(value) {
  const id = Number(value);
  return /^\d{1,5}$/.test(String(value)) && Number.isSafeInteger(id) && id >= 0 && id < 1500 ? id : null;
}
export function validateSlug(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) return null;
  if (['postmaster', 'abuse', 'admin', 'root', 'support', 'security', 'no-reply'].includes(name)) return null;
  return name;
}
export function validateDomain(value) {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain)) return null;
  if (domain.endsWith('.invalid') || domain.endsWith('.localhost')) return null;
  return domain;
}
async function sameSecret(input, expected) {
  if (!input || !expected) return false;
  const enc = new TextEncoder();
  const [a,b] = await Promise.all([input,expected].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let delta = 0;
  for(let i=0;i<left.length;i++) delta |= left[i] ^ right[i];
  return delta === 0;
}
async function authorized(request, env) {
  const value = request.headers.get('authorization') || '';
  if (!env.BRIDGE_TOKEN || env.BRIDGE_TOKEN.length < 32) return false;
  return /^Bearer\s+/i.test(value) && sameSecret(value.replace(/^Bearer\s+/i,''), env.BRIDGE_TOKEN);
}
const isConfigured = env =>
  Boolean(env.DB && env.EMAIL && validateDomain(env.MAIL_DOMAIN) && env.BRIDGE_TOKEN?.length >= 32);

const getIdentity = (env,id) => env.DB.prepare(
  'SELECT agent_id AS agentId,slug,address FROM identities WHERE agent_id = ?',
).bind(id).first();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if(url.pathname === '/health' && request.method === 'GET') {
      const bound = isConfigured(env);
      let databaseReachable = false;
      if(bound) {
        try { await env.DB.prepare('SELECT 1 AS up').first(); databaseReachable = true; } catch {}
      }
      return json({
        ok: true,
        configured: bound && databaseReachable,
        transport: 'cloudflare-email-service',
        publicDeliveryVerified: false,
        message: bound && databaseReachable
          ? 'Bindings ready; verify inbound MX and an outside-domain outbound test.'
          : 'Configure D1, Email Service, an owned domain and operator token before use.',
      });
    }
    if(url.pathname === '/v1/status' && request.method === 'GET') {
      if (!(await authorized(request,env))) return json({ok:false,error:'UNAUTHORIZED'},401);
      let claimed = null;
      if(env.DB) {
        try { claimed = (await env.DB.prepare('SELECT COUNT(*) AS n FROM identities').first())?.n ?? 0; } catch {}
      }
      return json({ok:true,configured:isConfigured(env),claimed,domain:validateDomain(env.MAIL_DOMAIN),
        sendsBound: Boolean(env.EMAIL),publicDeliveryVerified:false});
    }
    if (!(await authorized(request,env))) return json({ok:false,error:'UNAUTHORIZED'},401);
    if (!isConfigured(env)) return json({ok:false,error:'MAIL_NOT_CONFIGURED'},503);
    const route = url.pathname.match(/^\/v1\/agents\/(\d+)\/(identity|claim|inbox|send)$/);
    if(!route) return json({ok:false,error:'NOT_FOUND'},404);
    const id = validateAgentId(route[1]);
    if(id === null) return json({ok:false,error:'INVALID_AGENT_ID'},400);
    const action = route[2];
    if(action === 'identity' && request.method === 'GET') {
      const identity = await getIdentity(env,id);
      return identity ? json({ok:true,identity}) : json({ok:false,error:'NOT_CLAIMED'},404);
    }
    if(action === 'claim' && request.method === 'POST') {
      const data = await request.json().catch(()=>null);
      const slug = validateSlug(data?.slug);
      if(!slug) return json({ok:false,error:'INVALID_NAME'},400);
      const current = await getIdentity(env,id);
      if(current) return current.slug === slug ? json({ok:true,alreadyExists:true,identity:current})
        : json({ok:false,error:'ALREADY_CLAIMED',identity:current},409);
      const address = slug + '@' + validateDomain(env.MAIL_DOMAIN);
      try {
        await env.DB.prepare('INSERT INTO identities(agent_id,slug,address) VALUES(?,?,?)')
          .bind(id,slug,address).run();
      } catch {
        return json({ok:false,error:'NAME_IN_USE'},409);
      }
      const identity = await getIdentity(env,id);
      return json({ok:true,identity,publicDeliveryVerified:false},201);
    }
    if(action === 'inbox' && request.method === 'GET') {
      const identity = await getIdentity(env,id);
      if(!identity) return json({ok:false,error:'NOT_CLAIMED'},404);
      const max = Math.max(1,Math.min(50, Number(url.searchParams.get('limit')) || 20));
      const rows = await env.DB.prepare(
        "SELECT id,sender,recipient,subject,text_body AS text,created_at AS receivedAt FROM messages WHERE agent_id=? AND direction='inbound' ORDER BY created_at DESC LIMIT ?",
      ).bind(id,max).all();
      return json({ok:true,address:identity.address,source:'cloudflare-email-service',messages:rows.results || []});
    }
    if(action === 'send' && request.method === 'POST') {
      const identity = await getIdentity(env,id);
      if(!identity) return json({ok:false,error:'NOT_CLAIMED'},404);
      const data = await request.json().catch(()=>null);
      const to = typeof data?.to === 'string' ? data.to.trim().toLowerCase() : '';
      const subject = typeof data?.subject === 'string' ? data.subject.trim() : '';
      const body = typeof data?.text === 'string' ? data.text.trim() : '';
      if(!EMAIL_RE.test(to) || subject.length < 1 || subject.length > 180 ||
         /[\r\n]/.test(subject) || body.length < 1 || body.length > 16000)
        return json({ok:false,error:'INVALID_MESSAGE'},400);
      const today = new Date().toISOString().slice(0,10);
      // 5 external sends per agent/day by default, irrespective of a Worker restart.
      const quota = await env.DB.prepare(
        'INSERT INTO daily_send_quota(agent_id,utc_day,sends) VALUES(?,?,1) ON CONFLICT(agent_id,utc_day) DO UPDATE SET sends=sends+1 WHERE sends<5 RETURNING sends',
      ).bind(id,today).first();
      if(!quota) return json({ok:false,error:'DAILY_SEND_LIMIT'},429);
      try {
        const sent = await env.EMAIL.send({from:identity.address,to,subject,text:body,replyTo:identity.address});
        await env.DB.prepare(
          'INSERT INTO messages(id,agent_id,direction,sender,recipient,subject,text_body) VALUES(?,?,?,?,?,?,?)',
        ).bind(sent.messageId || crypto.randomUUID(),id,'outbound',identity.address,to,subject,body).run();
        return json({ok:true,accepted:true,provider:'cloudflare-email-service',messageId:sent.messageId});
      } catch(error) {
        // Only confirmed provider acceptance counts. If mail was accepted but
        // audit persistence failed, do not tell callers that nothing happened.
        return json({ok:false,accepted:null,error:'PROVIDER_OR_AUDIT_FAILURE',
          detail:String(error?.code || 'Send or audit failed')},502);
      }
    }
    return json({ok:false,error:'METHOD_NOT_ALLOWED'},405);
  },
  async email(message,env) {
    if(!env.DB || !validateDomain(env.MAIL_DOMAIN)) throw Error('Mail routing is not configured');
    const address = String(message.to || '').toLowerCase().trim();
    const domain = validateDomain(env.MAIL_DOMAIN);
    if(!address.endsWith('@' + domain)) {
      message.setReject('Unrecognized mail domain');
      return;
    }
    const identity = await env.DB.prepare(
      'SELECT agent_id AS agentId FROM identities WHERE address=?',
    ).bind(address).first();
    if(!identity) {
      message.setReject('Mailbox is not provisioned');
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    const subject = String(parsed.subject || '(no subject)').slice(0,180);
    const text = String(parsed.text || '').slice(0,64000);
    const from = String(message.from || '').slice(0,320);
    await env.DB.prepare(
      'INSERT OR IGNORE INTO messages(id,agent_id,direction,sender,recipient,subject,text_body) VALUES(?,?,?,?,?,?,?)',
    ).bind((address + '|' + String(parsed.messageId || crypto.randomUUID())).slice(0,500),identity.agentId,
      'inbound',from,address,subject,text).run();
  },
};
