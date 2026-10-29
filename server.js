// HillLink backend: Express + JSON-file persistence. DEMO MODE: synthetic data, mock SMS, no real dispatch.
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const BATCH = +process.env.OUTREACH_BATCH || 2, TIMEOUT_MIN = +process.env.RESPONSE_TIMEOUT_MIN || 10;
const KEYS = { [process.env.KEY_HOSPITAL || 'demo-hospital']: 'hospital', [process.env.KEY_DISPATCHER || 'demo-dispatcher']: 'dispatcher', [process.env.KEY_ADMIN || 'demo-admin']: 'admin' };
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ---------- road graph (synthetic hill town; replace with OSM extract) ----------
const NODES = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) NODES.push({ id: r * 3 + c, lat: 27.1 - r * .015, lon: 93.59 + c * .02 });
NODES.push({ id: 9, lat: 27.2, lon: 93.7 }); // isolated node to test unreachable
const HOSPITAL_NODE = 4, SPEED = { highway: 40, local: 25, hill: 15 };
const hav = (a, b) => { const R = 6371, t = x => x * Math.PI / 180, dl = t(b.lat - a.lat), dn = t(b.lon - a.lon);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dn / 2) ** 2)); };
const EDGES = []; const addE = (a, b, type) => EDGES.push({ id: `${a}-${b}`, a, b, type, km: +(hav(NODES[a], NODES[b]) * 1.3).toFixed(2), closed: false, rain: 0 });
[[0,1,'highway'],[1,2,'hill'],[3,4,'local'],[4,5,'local'],[6,7,'hill'],[7,8,'highway'],[0,3,'local'],[3,6,'hill'],[1,4,'highway'],[4,7,'local'],[2,5,'hill'],[5,8,'local']].forEach(e => addE(...e));
// edge time (min) = length / speed, scaled by rain (0..1 => up to 2.5x). Dijkstra alone is NOT a travel-time predictor; this is an estimate.
const edgeMin = e => e.km / SPEED[e.type] * 60 * (1 + 1.5 * e.rain) * (e.type === 'hill' ? 1.2 : 1);
function dijkstra(src, dst, edges = EDGES) {
  const dist = {}, prev = {}, done = new Set(); NODES.forEach(n => dist[n.id] = Infinity); dist[src] = 0;
  while (true) {
    let u = null; for (const n of NODES) if (!done.has(n.id) && dist[n.id] < (u === null ? Infinity : dist[u]) ) u = n.id;
    if (u === null || dist[u] === Infinity) break; if (u === dst) break; done.add(u);
    for (const e of edges) { if (e.closed) continue; const v = e.a === u ? e.b : e.b === u ? e.a : null; if (v === null) continue;
      const w = dist[u] + edgeMin(e); if (w < dist[v]) { dist[v] = w; prev[v] = { u, e }; } }
  }
  if (dist[dst] === Infinity) return null;
  const nodes = [dst], used = []; for (let c = dst; c !== src; c = prev[c].u) { nodes.unshift(prev[c].u); used.push(prev[c].e); }
  return { minutes: +dist[dst].toFixed(1), km: +used.reduce((s, e) => s + e.km, 0).toFixed(2), nodes, path: nodes.map(i => [NODES[i].lat, NODES[i].lon]), estimate: true, at: new Date().toISOString() };
}
const nearest = p => NODES.slice(0, 9).reduce((b, n) => hav(p, n) < hav(p, b) ? n : b).id;

// ---------- compatibility ----------
const split = g => ({ abo: g.replace(/[+-]/, ''), rh: g.slice(-1) });
const aboOK = (d, r) => d === 'O' || d === r || r === 'AB';
function compatible(donorG, recG, comp) {
  const d = split(donorG), r = split(recG);
  if (comp === 'platelets') return { ok: true, note: 'Platelets: ABO matching preferred; blood bank decides' };
  if (comp === 'plasma') return { ok: aboOK(r.abo, d.abo) }; // plasma compatibility is reversed
  return { ok: aboOK(d.abo, r.abo) && (d.rh === '-' || r.rh === '+') };
}
const INTERVAL_DAYS = { whole_blood: 90, packed_red_cells: 90, platelets: 14, plasma: 28 };

// ---------- state ----------
const seed = () => ({
  donors: [['A','O-',2,0],['B','O+',5,1],['C','B+',3,2],['D','B+',9,5],['E','A+',4,6],['F','AB-',6,7],['G','B-',1,8],['H','B+',2,3]].map(([n, g, , nd], i) => ({
    id: 'D' + (i + 1), name: 'Demo donor ' + n, phone: '+9100000000' + (10 + i), group: g, node: nd, available: i !== 3, consent: i !== 6,
    lastDonationDays: i === 1 ? 20 : 120 + i * 10, screened: i !== 4, locConfidence: i % 3 ? 'high' : 'low', components: ['whole_blood', 'packed_red_cells', 'platelets', 'plasma'], reservedFor: null })),
  ambulances: [{ id: 'AMB1', name: 'Demo ambulance 1', node: 0, available: true, assignedTo: null }, { id: 'AMB2', name: 'Demo ambulance 2', node: 8, available: true, assignedTo: null }],
  requests: [], outreach: [], outbox: [], audit: [], idem: {}, closures: {}
});
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : seed();
const save = () => { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1)); };
const log = (actor, action, ref, detail) => { db.audit.unshift({ at: new Date().toISOString(), actor, action, ref, detail }); db.audit.length = Math.min(db.audit.length, 300); };

// ---------- SMS adapter (mock by default). Real provider: implement send() with env credentials. ----------
const sms = { name: process.env.SMS_PROVIDER || 'mock',
  async send(to, body) { if (this.name === 'mock') { db.outbox.unshift({ at: new Date().toISOString(), to, body, mock: true, delivered: false }); return { mock: true }; }
    throw new Error('Real SMS provider not implemented: add credentials via env and code in sms.send()'); } };

// ---------- domain ----------
const expire = () => { const now = Date.now(); db.requests.forEach(r => { if (!['completed', 'cancelled', 'expired'].includes(r.status) && new Date(r.deadline) < now) { r.status = 'expired'; log('system', 'expired', r.id); } }); };
function matches(r) {
  const hosp = nearest(r.coords || NODES[HOSPITAL_NODE]);
  return db.donors.map(d => {
    const reasons = [], missing = [], c = compatible(d.group, r.bloodGroup, r.component);
    if (!c.ok) return null; reasons.push('Group/component compatible (listed rule only)'); if (c.note) reasons.push(c.note);
    if (!d.consent) return null; if (!d.available) return null; if (d.reservedFor && d.reservedFor !== r.id) return null;
    if (!d.components.includes(r.component)) return null;
    if (d.lastDonationDays < INTERVAL_DAYS[r.component]) return null; reasons.push(`Last donation ${d.lastDonationDays}d ago`);
    if (!d.screened) missing.push('No recent health screening confirmation');
    if (d.locConfidence === 'low') missing.push('Low-confidence location');
    const route = dijkstra(d.node, hosp), mins = route ? route.minutes : null, left = (new Date(r.deadline) - Date.now()) / 60000;
    return { donor: { id: d.id, name: d.name, phone: d.phone.slice(0, -2) + '••', group: d.group }, reasons, missing, route, etaMin: mins, feasible: mins !== null && mins <= left, reserved: d.reservedFor === r.id,
      score: (mins ?? 9999) + missing.length * 15 };
  }).filter(Boolean).sort((a, b) => a.score - b.score);
}
function rankAmb(r, donor) {
  const hosp = nearest(r.coords || NODES[HOSPITAL_NODE]), left = (new Date(r.deadline) - Date.now()) / 60000;
  return db.ambulances.filter(a => a.available).map(a => { const p = dijkstra(a.node, donor.node), h = dijkstra(donor.node, hosp);
    if (!p || !h) return null; const total = p.minutes + h.minutes; return { ambulance: a, pickup: p, toHospital: h, totalMin: +total.toFixed(1), feasible: total <= left }; })
    .filter(Boolean).sort((a, b) => a.totalMin - b.totalMin);
}

// ---------- API ----------
const app = express(); app.use(express.json({ limit: '50kb' })); app.use(express.static(path.join(__dirname, 'public')));
const hits = {}; app.use((q, s, n) => { const k = q.ip + Math.floor(Date.now() / 60000); hits[k] = (hits[k] || 0) + 1; if (hits[k] > 300) return s.status(429).json({ error: 'Too many requests' }); n(); });
const need = (...roles) => (q, s, n) => { const role = KEYS[q.get('x-api-key')]; if (!role || (roles.length && !roles.includes(role) && role !== 'admin')) return s.status(role ? 403 : 401).json({ error: role ? 'Role not permitted' : 'Missing or invalid key' }); q.role = role; n(); };
const GROUPS = ['A+','A-','B+','B-','AB+','AB-','O+','O-'], COMPS = Object.keys(INTERVAL_DAYS), URG = ['critical', 'urgent', 'routine'];
const find = (q, s) => { expire(); const r = db.requests.find(x => x.id === q.params.id); if (!r) s.status(404).json({ error: 'Request not found' }); return r; };

app.get('/api/state', need(), (q, s) => { expire(); s.json({ role: q.role, mode: 'DEMO', sms: sms.name, nodes: NODES, edges: EDGES, hospitalNode: HOSPITAL_NODE,
  requests: db.requests, donors: db.donors.map(d => ({ ...d, phone: d.phone.slice(0, -2) + '••' })), ambulances: db.ambulances, outbox: q.role === 'hospital' ? [] : db.outbox, audit: q.role === 'admin' ? db.audit : [] }); });

app.post('/api/requests', need('hospital'), (q, s) => {
  const b = q.body, key = q.get('idempotency-key'); if (key && db.idem[key]) return s.json(db.requests.find(r => r.id === db.idem[key]));
  const err = []; if (!GROUPS.includes(b.bloodGroup)) err.push('bloodGroup'); if (!COMPS.includes(b.component)) err.push('component');
  if (!(b.units >= 1 && b.units <= 20)) err.push('units'); if (!b.hospital || String(b.hospital).length > 80) err.push('hospital');
  if (!URG.includes(b.urgency)) err.push('urgency'); if (!/^\+?\d{8,15}$/.test(b.phone || '')) err.push('phone');
  if (isNaN(new Date(b.deadline)) || new Date(b.deadline) < Date.now()) err.push('deadline');
  if (err.length) return s.status(400).json({ error: 'Invalid fields', fields: err });
  const r = { id: 'R' + crypto.randomBytes(3).toString('hex').toUpperCase(), bloodGroup: b.bloodGroup, component: b.component, units: +b.units, hospital: b.hospital, area: String(b.area || '').slice(0, 60),
    coords: { lat: +b.lat || NODES[HOSPITAL_NODE].lat, lon: +b.lon || NODES[HOSPITAL_NODE].lon }, deadline: new Date(b.deadline).toISOString(), urgency: b.urgency, phone: b.phone,
    verified: false, demo: true, status: 'pending', createdAt: new Date().toISOString(), donor: null, ambulance: null };
  db.requests.unshift(r); if (key) db.idem[key] = r.id; log(q.role, 'request_created', r.id, 'demo (unverified)'); save(); s.status(201).json(r); });
app.post('/api/requests/:id/verify', need('hospital', 'admin'), (q, s) => { const r = find(q, s); if (!r) return; r.verified = true; r.demo = false; log(q.role, 'verified', r.id); save(); s.json(r); });
app.post('/api/requests/:id/cancel', need('hospital', 'dispatcher'), (q, s) => { const r = find(q, s); if (!r) return; r.status = 'cancelled';
  db.donors.forEach(d => { if (d.reservedFor === r.id) d.reservedFor = null; }); db.ambulances.forEach(a => { if (a.assignedTo === r.id) { a.assignedTo = null; a.available = true; } }); log(q.role, 'cancelled', r.id); save(); s.json(r); });
app.get('/api/requests/:id/matches', need('hospital', 'dispatcher'), (q, s) => { const r = find(q, s); if (r) s.json({ matches: matches(r), notice: 'Blood-bank personnel must confirm final suitability.' }); });

app.post('/api/requests/:id/outreach', need('hospital', 'dispatcher'), async (q, s) => {
  const r = find(q, s); if (!r) return; if (['expired', 'cancelled', 'completed'].includes(r.status)) return s.status(409).json({ error: 'Request closed' });
  const contacted = new Set(db.outreach.filter(o => o.requestId === r.id).map(o => o.donorId));
  const next = matches(r).filter(m => m.feasible && !contacted.has(m.donor.id)).slice(0, BATCH); if (!next.length) return s.status(409).json({ error: 'No further eligible donors in time' });
  for (const m of next) { const d = db.donors.find(x => x.id === m.donor.id);
    await sms.send(d.phone, `HILLLINK BLOOD ALERT: A ${r.verified ? 'verified' : 'DEMO (unverified)'} hospital needs ${r.bloodGroup} blood at ${r.area || 'hospital area'} by ${new Date(r.deadline).toLocaleTimeString()}. Reply 1 to express interest or 2 to decline. Request ID: ${r.id}. Do not reply with medical information.`);
    db.outreach.push({ requestId: r.id, donorId: d.id, phone: d.phone, status: 'sent', sentAt: Date.now(), expiresAt: Date.now() + TIMEOUT_MIN * 60000 }); }
  if (r.status === 'pending') r.status = 'matching'; log(q.role, 'outreach_sent', r.id, next.length + ' mock SMS'); save(); s.json({ sent: next.length, mock: true }); });

// Inbound SMS webhook (real providers: add signature verification before trusting)
app.post('/webhooks/sms', async (q, s) => {
  const from = String(q.body.from || ''), text = String(q.body.body || '').trim(), word = text.split(/\s+/)[0];
  const o = [...db.outreach].reverse().find(x => x.phone === from && ['sent', 'interested', 'declined', 'accepted', 'late'].includes(x.status));
  if (!o) return s.json({ ok: false, reason: 'unknown sender' });
  const r = db.requests.find(x => x.id === o.requestId); expire();
  const reply = async m => { await sms.send(from, m); save(); s.json({ ok: true, status: o.status, reply: m }); };
  if (!['1', '2'].includes(word)) return reply('HILLLINK: Invalid reply. Reply 1 to express interest or 2 to decline.');
  if (o.status !== 'sent') return reply('HILLLINK: We already recorded your reply.');
  if (!r || r.status === 'expired' || r.status === 'cancelled' || r.status === 'completed' || Date.now() > o.expiresAt) { o.status = 'late'; return reply('HILLLINK: This request is no longer open. Thank you.'); }
  if (word === '2') { o.status = 'declined'; log('donor', 'declined', r.id, o.donorId); return reply('HILLLINK: Thanks. Recorded as declined.'); }
  const d = db.donors.find(x => x.id === o.donorId);
  if (r.donor || !matches(r).some(m => m.donor.id === d.id)) { o.status = 'late'; return reply('HILLLINK: Thanks. Help is no longer needed from you for this request.'); }
  o.status = 'accepted'; r.donor = d.id; r.status = 'donor accepted'; d.reservedFor = r.id; log('donor', 'reserved', r.id, d.id);
  reply('HILLLINK: Thank you. Interest recorded. Hospital staff will confirm suitability and contact you.'); });

app.get('/api/requests/:id/ambulances', need('dispatcher'), (q, s) => { const r = find(q, s); if (!r) return; const d = db.donors.find(x => x.id === r.donor); if (!d) return s.status(409).json({ error: 'No reserved donor' }); s.json(rankAmb(r, d)); });
app.post('/api/requests/:id/ambulance', need('dispatcher'), (q, s) => { const r = find(q, s); if (!r) return; const d = db.donors.find(x => x.id === r.donor); if (!d) return s.status(409).json({ error: 'No reserved donor' });
  if (r.ambulance) return s.status(409).json({ error: 'Ambulance already assigned' });
  const ranked = rankAmb(r, d), pick = q.body.override ? ranked.find(x => x.ambulance.id === q.body.ambulanceId) : ranked.find(x => x.feasible);
  if (!pick || !pick.ambulance.available) return s.status(409).json({ error: 'No available feasible ambulance (rechecked)' });
  pick.ambulance.available = false; pick.ambulance.assignedTo = r.id; r.ambulance = pick.ambulance.id; r.status = 'ambulance assigned'; r.plan = pick;
  log(q.role, q.body.override ? 'ambulance_override' : 'ambulance_assigned', r.id, pick.ambulance.id); save();
  s.json({ ...r, notice: 'Recorded in HillLink only. No dispatch provider is integrated; contact the ambulance by your own channel.' }); });
app.post('/api/requests/:id/complete', need('dispatcher', 'hospital'), (q, s) => { const r = find(q, s); if (!r) return; r.status = 'completed'; db.ambulances.forEach(a => { if (a.assignedTo === r.id) { a.assignedTo = null; a.available = true; } }); db.donors.forEach(d => { if (d.reservedFor === r.id) d.reservedFor = null; }); log(q.role, 'completed', r.id); save(); s.json(r); });
app.post('/api/admin/edge', need('admin'), (q, s) => { const e = EDGES.find(x => x.id === q.body.id); if (!e) return s.status(404).json({ error: 'Unknown edge' });
  if (typeof q.body.closed === 'boolean') e.closed = q.body.closed; if (q.body.rain >= 0 && q.body.rain <= 1) e.rain = +q.body.rain; log(q.role, 'edge_update', e.id, JSON.stringify({ closed: e.closed, rain: e.rain })); s.json(e); });
app.post('/api/admin/reset', need('admin'), (q, s) => { db = seed(); EDGES.forEach(e => { e.closed = false; e.rain = 0; }); save(); s.json({ ok: true }); });
app.get('/api/route', need(), (q, s) => { const r = dijkstra(+q.query.from, +q.query.to); r ? s.json(r) : s.status(404).json({ error: 'Unreachable', estimate: true }); });

if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log('HillLink DEMO on http://localhost:' + (process.env.PORT || 3000)));
module.exports = { dijkstra, compatible, EDGES, NODES, app };
