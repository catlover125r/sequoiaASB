// Events: the self-serve ticket system. One Google Sheet = one event.
//
// The sheet's own script (tickets/Code.gs in the project folder) calls this site about once a minute with the
// whole ticket list, the staff list and the event settings, and takes back the check-ins made at the door.
// Nothing about an event is written in this code or in Vercel: a new dance is a new copy of the sheet.
//
//   tk:index            hash   event code -> {name, when, updatedAt}
//   tk:<ev>:cfg         string JSON {ev, settings, staff, owner, sheet, createdAt, updatedAt, emailed}
//   tk:<ev>:design      string JSON {style, bg, fg, label, title, v}      (ticket look, set on /tickets)
//   tk:<ev>:art         hash   file name -> base64 PNG                    (ticket art, set on /tickets)
//   tk:<ev>:roster|ci|dirty|events|meta   the check-in store (see _hoco_redis.js, pushed mode)
//
// Files starting with "_" in /api are not exposed as routes by Vercel.
const crypto = require('crypto');

const EV_RE = /^[a-z0-9]{6,16}$/;
const normEv = (v) => { const s = String(v == null ? '' : v).trim().toLowerCase(); return EV_RE.test(s) ? s : null; };
const K = (ev, what) => 'tk:' + ev + ':' + what;
const INDEX = 'tk:index';

// ------------------------------------------------------------------ redis
let client;
function redis() {
  if (client !== undefined) return client;
  if (process.env.HOCO_DEV === '1' && process.env.HOCO_DEV_REDIS === '1') {
    client = require('./_dev_fake_redis').fakeRedis(Number(process.env.HOCO_DEV_REDIS_LATENCY || 0));   // local development / tests only
    return client;
  }
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { client = null; return client; }
  const { Redis } = require('@upstash/redis');
  client = new Redis({ url, token, automaticDeserialization: false });
  return client;
}
// With automaticDeserialization:false the real client returns HGETALL as a flat [k, v, k, v...] array.
async function hgetall(key) {
  const v = await redis().hgetall(key);
  if (!v) return {};
  if (!Array.isArray(v)) return v;
  const o = {};
  for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
  return o;
}
const parse = (s) => { if (s == null) return null; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch (e) { return null; } };

// ------------------------------------------------------------------ who may call as "the sheet"
// One long key, kept in Vercel (TICKETS_KEY) and in the Settings tab of the template sheet. A copy of the template
// carries it along, so a new event needs nothing from a developer.
function keyOk(given) {
  const want = process.env.TICKETS_KEY || '';
  if (want.length < 24) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest(), b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------ settings + staff, as sent by the sheet
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function cleanSettings(s) {
  s = s || {};
  let startsAt = '';
  const d = s.startsAt ? new Date(s.startsAt) : null;
  if (d && !isNaN(d.getTime())) startsAt = d.toISOString();
  let agreementUrl = str(s.agreementUrl, 500);
  if (!/^https:\/\/[^\s"'<>]+$/.test(agreementUrl)) agreementUrl = '';
  return {
    name: str(s.name, 60) || 'Event',
    tagline: str(s.tagline, 80),
    taglineLabel: str(s.taglineLabel, 20),
    when: str(s.when, 80),           // as it should read on the ticket, e.g. "Saturday, October 17 · 7:00 PM"
    startsAt,                         // the same moment for the phone's lock screen (ISO), or ''
    place: str(s.place, 80),
    org: str(s.org, 40) || 'Sequoia ASB',
    greeting: str(s.greeting, 60),    // door screen: "<Name> is checked in, <greeting>."
    agreementUrl,                     // dance agreement form (QR on the yellow door screen), or ''
    contact: str(s.contact, 120),
  };
}
const emailOf = (v) => { const e = str(v, 120).toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : ''; };
function cleanStaff(list) {
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).slice(0, 500).forEach((p) => {
    const email = emailOf(p && p.email);
    if (!email || seen.has(email)) return;
    seen.add(email);
    out.push({ email, role: String((p && p.role) || '').trim().toLowerCase().indexOf('admin') === 0 ? 'admin' : 'helper' });
  });
  return out;
}
function cleanTickets(list) {
  const out = [], seen = new Set();
  (Array.isArray(list) ? list : []).slice(0, 5000).forEach((t) => {
    const id = String((t && t.id) == null ? '' : t.id).replace(/\D/g, '');
    if (id.length < 3 || id.length > 12 || seen.has(id)) return;
    seen.add(id);
    const first = str(t.first, 60), last = str(t.last, 60);
    const rec = { id, first, last, name: (first + ' ' + last).trim() || str(t.name, 120), checkedIn: t.checkedIn === true, at: t.checkedIn === true ? (str(t.at, 40) || null) : null };
    if (typeof t.agreed === 'boolean') rec.agreed = t.agreed;
    if (t.guest) rec.guest = str(t.guest, 80);
    if (t.npl === true) rec.npl = true;
    if (t.no != null && String(t.no).trim() !== '') rec.no = str(t.no, 12);
    out.push(rec);
  });
  return out;
}

// ------------------------------------------------------------------ event records
const CFG_TTL_MS = 20 * 1000;
const cfgCache = new Map();
async function getCfg(ev, fresh) {
  const c = cfgCache.get(ev);
  if (!fresh && c && Date.now() - c.at < CFG_TTL_MS) return c.cfg;
  const cfg = parse(await redis().get(K(ev, 'cfg')));
  cfgCache.set(ev, { at: Date.now(), cfg });
  return cfg;
}
async function saveCfg(ev, patch) {
  const now = new Date().toISOString();
  const old = (await getCfg(ev, true)) || { ev, createdAt: now };
  const cfg = { ...old, ...patch, ev, updatedAt: now };
  await redis().set(K(ev, 'cfg'), JSON.stringify(cfg));
  await redis().hset(INDEX, { [ev]: JSON.stringify({ name: cfg.settings ? cfg.settings.name : '', when: cfg.settings ? cfg.settings.when : '', updatedAt: now }) });
  cfgCache.set(ev, { at: Date.now(), cfg });
  return cfg;
}
function resetCache() { cfgCache.clear(); stores.clear(); }

// ------------------------------------------------------------------ roles
// Admin: the person who owns the sheet, anyone marked Admin on its Staff tab, and the site-wide ADMIN_EMAILS.
// Helper: everyone else on the Staff tab.
const superAdmins = () => (process.env.ADMIN_EMAILS || '').split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
function roleIn(cfg, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !cfg) return null;
  if (superAdmins().includes(e) || (cfg.owner && cfg.owner === e)) return 'admin';
  const p = (cfg.staff || []).find((x) => x.email === e);
  return p ? p.role : null;
}
async function roleFor(email, ev) { return roleIn(await getCfg(ev), email); }

// Every event this person works at, newest first.
async function eventsFor(email) {
  if (!redis()) return [];
  const idx = await hgetall(INDEX);
  const evs = Object.keys(idx).filter((e) => EV_RE.test(e));
  const cfgs = await Promise.all(evs.map((e) => getCfg(e)));
  const out = [];
  cfgs.forEach((cfg) => {
    if (!cfg || !cfg.settings) return;
    const role = roleIn(cfg, email);
    if (!role) return;
    out.push({ ev: cfg.ev, role, name: cfg.settings.name, when: cfg.settings.when, place: cfg.settings.place, startsAt: cfg.settings.startsAt, greeting: cfg.settings.greeting, agreementUrl: cfg.settings.agreementUrl, updatedAt: cfg.updatedAt });
  });
  // the event happening closest to now first; events with no date go by when their sheet last called in
  const dist = (e) => Math.abs(Date.now() - new Date(e.startsAt || e.updatedAt).getTime());
  return out.sort((a, b) => dist(a) - dist(b)).slice(0, 30);
}

// ------------------------------------------------------------------ check-in store of one event
const stores = new Map();
function waitUntilSafe(p) {
  try { require('@vercel/functions').waitUntil(p); } catch (e) { p.catch(() => {}); }
}
function storeFor(ev) {
  if (!stores.has(ev)) {
    const nothing = { list: async () => [], apply: async () => ({}), helpers: async () => [] };
    stores.set(ev, require('./_hoco_redis').create(redis(), nothing, { waitUntil: waitUntilSafe }, { prefix: K(ev, ''), pushed: true }));
  }
  return stores.get(ev);
}

// ------------------------------------------------------------------ personal ticket links
//   https://sequoiaasb.org/t/<event code>.<student id>-<mac>
// The mac is an HMAC over the event and the student id, so a link can't be guessed or made for somebody else.
function linkSecret() {
  const s = process.env.PASS_LINK_SECRET;
  if (!s || s.length < 24) throw new Error('PASS_LINK_SECRET is not set');
  return s;
}
const mac = (ev, id) => crypto.createHmac('sha256', linkSecret()).update('ev:' + ev + ':' + id).digest('base64url').slice(0, 16);
const linkCode = (ev, id) => ev + '.' + id + '-' + mac(ev, id);
function verifyLink(c) {
  const m = /^([a-z0-9]{6,16})\.(\d{3,12})-([A-Za-z0-9_-]{16})$/.exec(String(c || ''));
  if (!m) return null;
  const a = Buffer.from(m[3]), b = Buffer.from(mac(m[1], m[2]));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { ev: m[1], id: m[2] } : null;
}

// ------------------------------------------------------------------ ticket look
const HEX = /^#[0-9a-f]{6}$/i;
const DEFAULT_DESIGN = { style: 'plain', bg: '#4a0d67', fg: '#ffffff', label: '#e2cdf2', title: true, v: 0 };
const ART_FILES = {
  background: ['background.png', 'background@2x.png', 'background@3x.png'],
  banner: ['strip.png', 'strip@2x.png', 'strip@3x.png'],
  plain: [],
};
async function getDesign(ev) {
  const d = parse(await redis().get(K(ev, 'design')));
  return { ...DEFAULT_DESIGN, ...(d || {}) };
}
/** art: {fileName: base64 PNG} for the chosen style, or null to keep the art already stored. */
async function saveDesign(ev, d, art) {
  const style = ART_FILES[d.style] ? d.style : 'plain';
  const old = await getDesign(ev);
  const next = {
    style,
    bg: HEX.test(d.bg) ? d.bg.toLowerCase() : old.bg,
    fg: HEX.test(d.fg) ? d.fg.toLowerCase() : old.fg,
    label: HEX.test(d.label) ? d.label.toLowerCase() : old.label,
    title: d.title !== false,
    v: (old.v || 0) + 1,
  };
  if (art) {
    const files = {};
    let total = 0;
    ART_FILES[style].forEach((f) => {
      const b64 = String(art[f] || '').replace(/^data:image\/png;base64,/, '');
      if (!b64) return;
      const buf = Buffer.from(b64, 'base64');
      if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('art must be PNG images');
      total += buf.length;
      files[f] = buf.toString('base64');
    });
    if (total > 3 * 1024 * 1024) throw new Error('art is too large');
    await redis().del(K(ev, 'art'));
    if (Object.keys(files).length) await redis().hset(K(ev, 'art'), files);
  } else if (style !== old.style) {
    await redis().del(K(ev, 'art'));          // the stored art was cut for the other style
  }
  if (style !== 'plain' && !(await redis().hlen(K(ev, 'art')))) next.style = 'plain';
  await redis().set(K(ev, 'design'), JSON.stringify(next));
  return next;
}
/** {fileName: Buffer} */
async function getArt(ev) {
  const a = await hgetall(K(ev, 'art'));
  const out = {};
  Object.keys(a).forEach((f) => { out[f] = Buffer.from(String(a[f]), 'base64'); });
  return out;
}

module.exports = { normEv, redis, keyOk, cleanSettings, cleanStaff, cleanTickets, getCfg, saveCfg, roleFor, eventsFor, storeFor,
  linkCode, verifyLink, getDesign, saveDesign, getArt, resetCache, DEFAULT_DESIGN, ART_FILES };
