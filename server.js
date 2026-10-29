#!/usr/bin/env node
/*
 HillLink SMS gateway + static host (Node 18+, no dependencies).

 It does three things:
   1. Serves index.html.
   2. Sends SMS through a provider (Twilio, or a dry-run "log" provider for testing).
   3. Receives donor replies (Twilio webhook, or a generic JSON webhook for an Android
      SMS-gateway app) and keeps them in an inbox that the page polls.

 Run (testing, nothing is really sent):
   GATEWAY_TOKEN=$(openssl rand -hex 24) node server.js

 Run with Twilio:
   GATEWAY_TOKEN=...  SMS_PROVIDER=twilio  PUBLIC_URL=https://your.domain
   TWILIO_ACCOUNT_SID=AC...  TWILIO_AUTH_TOKEN=...  TWILIO_FROM=+1...   (or TWILIO_MESSAGING_SERVICE_SID=MG...)
   In Twilio, set the number's "A message comes in" webhook to POST  PUBLIC_URL/webhooks/twilio

 Generic inbound (any gateway that can POST JSON {"from":"+91...","body":"YES"}):
   WEBHOOK_SECRET=...   POST /webhooks/generic  with header  x-webhook-secret: <secret>

 Other settings: PORT (8080), HOST (127.0.0.1), ALLOWED_PREFIX (+91, only numbers starting with this
 can be texted), SMS_RATE_PER_MIN (30), DATA_DIR (./data).
 Put it behind HTTPS (a reverse proxy) before real use.
*/
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const env = (k, d = '') => String(process.env[k] ?? d).trim();
const PORT = +env('PORT', 8080), HOST = env('HOST', '127.0.0.1'), TOKEN = env('GATEWAY_TOKEN');
const PROVIDER = env('SMS_PROVIDER', 'log').toLowerCase(), WH_SECRET = env('WEBHOOK_SECRET');
const PUBLIC_URL = env('PUBLIC_URL').replace(/\/$/, ''), PREFIX = env('ALLOWED_PREFIX', '+91');
const RATE = +env('SMS_RATE_PER_MIN', 30), DATA = path.resolve(env('DATA_DIR', './data'));
const SID = env('TWILIO_ACCOUNT_SID'), AUTH = env('TWILIO_AUTH_TOKEN'), FROM = env('TWILIO_FROM'), MSID = env('TWILIO_MESSAGING_SERVICE_SID');

if (TOKEN.length < 16) { console.error('Set GATEWAY_TOKEN to a random string of 16+ characters.'); process.exit(1); }
if (!['log', 'twilio'].includes(PROVIDER)) { console.error('SMS_PROVIDER must be "log" or "twilio".'); process.exit(1); }
if (PROVIDER === 'twilio' && !(SID && AUTH && (FROM || MSID) && PUBLIC_URL)) {
  console.error('Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID) and PUBLIC_URL.'); process.exit(1);
}
if (WH_SECRET && WH_SECRET.length < 16) { console.error('WEBHOOK_SECRET must be 16+ characters.'); process.exit(1); }

const eq = (a, b) => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());
const mask = n => String(n).slice(0, -3).replace(/\d/g, '*') + String(n).slice(-3);

/* ---- inbox (persisted so replies survive a restart) ---- */
fs.mkdirSync(DATA, { recursive: true });
const IF = path.join(DATA, 'inbox.json'); let inbox = [], seq = 0; const seen = new Set();
try { inbox = JSON.parse(fs.readFileSync(IF, 'utf8')); seq = inbox.reduce((m, x) => Math.max(m, x.id), 0); inbox.forEach(x => x.sid && seen.add(x.sid)); } catch (e) { }
function addIn(from, body, sid) {
  if (sid && seen.has(sid)) return null; // provider retry
  const m = { id: ++seq, from: String(from).slice(0, 20), body: String(body).slice(0, 500), at: new Date().toISOString(), sid: sid || undefined };
  if (sid) seen.add(sid); inbox.push(m); if (inbox.length > 500) inbox.splice(0, inbox.length - 500);
  try { fs.writeFileSync(IF, JSON.stringify(inbox), { mode: 0o600 }); } catch (e) { console.error('inbox save failed:', e.message); }
  return m;
}

/* ---- outbound ---- */
const sentAt = [];
async function sendSms(to, text) {
  if (!/^\+\d{8,15}$/.test(to)) throw Object.assign(new Error('Invalid phone number'), { code: 400 });
  if (!to.startsWith(PREFIX)) throw Object.assign(new Error('Number is outside the allowed country prefix ' + PREFIX), { code: 403 });
  text = String(text || ''); if (!text || text.length > 1000) throw Object.assign(new Error('Message must be 1 to 1000 characters'), { code: 400 });
  const now = Date.now(); while (sentAt.length && now - sentAt[0] > 6e4) sentAt.shift();
  if (sentAt.length >= RATE) throw Object.assign(new Error('Sending too fast, limit is ' + RATE + ' per minute'), { code: 429 });
  sentAt.push(now);
  if (PROVIDER === 'log') { console.log(`[dry-run SMS] to ${mask(to)}: ${text}`); return { id: 'log-' + crypto.randomBytes(4).toString('hex'), status: 'dry-run', dry: true }; }
  const body = new URLSearchParams({ To: to, Body: text }); if (MSID) body.set('MessagingServiceSid', MSID); else body.set('From', FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(SID + ':' + AUTH).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body,
    signal: AbortSignal.timeout(10000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || 'Provider error ' + r.status), { code: 502 });
  return { id: j.sid, status: j.status };
}
function twilioSigOk(req, params) {
  const sig = req.headers['x-twilio-signature']; if (!sig) return false;
  const data = PUBLIC_URL + '/webhooks/twilio' + Object.keys(params).sort().map(k => k + params[k]).join('');
  return eq(sig, crypto.createHmac('sha1', AUTH).update(data).digest('base64'));
}

/* ---- http ---- */
const fails = new Map();
const readBody = req => new Promise((res, rej) => {
  let n = 0; const c = [];
  req.on('data', d => { n += d.length; if (n > 65536) { rej(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else c.push(d); });
  req.on('end', () => res(Buffer.concat(c).toString('utf8'))); req.on('error', rej);
});
http.createServer(async (req, res) => {
  const out = (code, obj, type = 'application/json', extra = {}) => {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  try {
    const p = new URL(req.url, 'http://x').pathname, u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return out(200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html');
    }
    if (p.startsWith('/gateway/')) {
      const ip = req.socket.remoteAddress || '?', f = fails.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 6e4) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 10) return out(429, { error: 'Too many failed attempts, wait a minute' });
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      if (!m || !eq(m[1], TOKEN)) { f.n++; fails.set(ip, f); return out(401, { error: 'Wrong or missing gateway token' }); }
      if (req.method === 'GET' && p === '/gateway/status') return out(200, { ok: true, provider: PROVIDER, live: PROVIDER !== 'log', prefix: PREFIX, lastId: seq, inboundWebhooks: { twilio: PROVIDER === 'twilio', generic: !!WH_SECRET } });
      if (req.method === 'GET' && p === '/gateway/inbox') {
        const after = Math.max(0, +u.searchParams.get('after') || 0);
        return out(200, { messages: inbox.filter(x => x.id > after).slice(0, 50).map(({ id, from, body, at }) => ({ id, from, body, at })), lastId: seq });
      }
      if (req.method === 'POST' && p === '/gateway/send') {
        let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return out(400, { error: 'Bad JSON' }); }
        try { return out(200, await sendSms(String(b.to || ''), b.body)); }
        catch (e) { console.error('send failed:', e.message); return out(e.code || 500, { error: e.message }); }
      }
      return out(404, { error: 'Unknown gateway call' });
    }
    if (req.method === 'POST' && p === '/webhooks/twilio' && PROVIDER === 'twilio') {
      const params = Object.fromEntries(new URLSearchParams(await readBody(req)));
      if (!twilioSigOk(req, params)) return out(403, 'Bad signature', 'text/plain');
      addIn(params.From || '', params.Body || '', params.MessageSid);
      return out(200, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 'text/xml');
    }
    if (req.method === 'POST' && p === '/webhooks/generic' && WH_SECRET) {
      if (!eq(req.headers['x-webhook-secret'] || '', WH_SECRET)) return out(403, { error: 'Bad secret' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return out(400, { error: 'Bad JSON' }); }
      if (!/^\+?\d{8,15}$/.test(String(b.from || ''))) return out(400, { error: 'Bad "from"' });
      addIn(b.from, b.body || '', b.id ? 'g' + b.id : '');
      return out(200, { ok: true });
    }
    out(404, 'Not found', 'text/plain'); // plain text on purpose: the page uses this to tell it is not talking to the old full-server mode
  } catch (e) { console.error(e); out(e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'Too large' : 'Server error' }); }
}).listen(PORT, HOST, () => console.log(`HillLink on http://${HOST}:${PORT}  provider=${PROVIDER}${PROVIDER === 'log' ? ' (dry run, nothing is really sent)' : ''}`));
