// Shared helpers for the /hocotickets check-in app (sessions, roles, ticket store).
// Files starting with "_" in /api are not exposed as routes by Vercel.
const crypto = require('crypto');
const fs = require('fs');

const COOKIE = 'hoco_session';
const SESSION_HOURS = 12;

// ---------------------------------------------------------------- roles
// Allowlists live in Vercel environment variables (not in the public repo):
//   ADMIN_EMAILS  = comma separated
//   HELPER_EMAILS = comma separated
function emailList(name) {
  return (process.env[name] || '').split(/[,\s;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}
// Helpers can ALSO be listed on the "Staff" tab of the ticket sheet (column A). We cache that list
// for a short time so a new helper works within about a minute and a removed one is locked out
// just as fast, without a redeploy. Admins are never read from the sheet.
const HELPER_TTL_MS = 45 * 1000;
let helperCache = { at: 0, list: [] };
async function sheetHelpers() {
  const store = getStore();
  if (!store || !store.helpers) return [];
  if (Date.now() - helperCache.at < HELPER_TTL_MS) return helperCache.list;
  try {
    const list = await store.helpers();
    helperCache = { at: Date.now(), list: list.map((e) => String(e).trim().toLowerCase()).filter(Boolean) };
  } catch (err) {
    console.error('staff list error', err.message);
    helperCache = { at: Date.now() - HELPER_TTL_MS + 10000, list: helperCache.list };   // keep the last list, retry in 10s
  }
  return helperCache.list;
}
function resetHelperCache() { helperCache = { at: 0, list: [] }; }

async function roleFor(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (emailList('ADMIN_EMAILS').includes(e)) return 'admin';
  if (emailList('HELPER_EMAILS').includes(e)) return 'helper';
  if ((await sheetHelpers()).includes(e)) return 'helper';
  return null;
}

// ------------------------------------------------------------- sessions
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET is not set');
  return s;
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return body + '.' + mac;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p.exp || p.exp < Date.now() / 1000) return null;
  return p;
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isLocal(req) {
  const h = String(req.headers.host || '');
  return h.startsWith('localhost') || h.startsWith('127.0.0.1');
}
function setSession(req, res, email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const parts = [`${COOKIE}=${sign({ email, exp })}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_HOURS * 3600}`];
  if (!isLocal(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
// The role is looked up on every request, so removing someone from the allowlist
// locks them out immediately, even if their cookie is still valid.
async function currentUser(req) {
  const p = verifyToken(cookies(req)[COOKIE]);
  if (!p) return null;
  const role = await roleFor(p.email);
  return role ? { email: p.email, role } : null;
}

// ------------------------------------------------------ Google sign-in
async function verifyGoogle(credential) {
  const { OAuth2Client } = require('google-auth-library');
  const ticket = await new OAuth2Client().verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const p = ticket.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error('unverified email');
  return p.email.toLowerCase();
}

// Local development only: lets us test without a Google account. Needs HOCO_DEV=1
// (set only in .env.local, never in Vercel) AND a localhost Host header.
function devLoginAllowed(req) {
  return process.env.HOCO_DEV === '1' && isLocal(req);
}

// ------------------------------------------------------------ roster cache
// Everyone with a ticket, loaded from the sheet once and refreshed every ~20 seconds. Lookups
// ("does this ID have a ticket? already in?") are answered from memory in milliseconds instead of
// asking the sheet (about 2 seconds). Writes still go to the sheet, which stays the source of truth.
const ROSTER_TTL_MS = 20 * 1000;
let roster = { at: 0, byId: null, inflight: null };
async function getRoster(store) {
  if (roster.byId && Date.now() - roster.at < ROSTER_TTL_MS) return roster.byId;
  if (!roster.inflight) {
    roster.inflight = store.list().then((list) => {
      const m = new Map();
      list.forEach((t) => m.set(t.id, t));
      roster = { at: Date.now(), byId: m, inflight: null };
      return m;
    }).catch((e) => { roster.inflight = null; throw e; });
  }
  roster.inflight.catch(() => {});       // nobody may be waiting on this refresh; never let it become an unhandled error
  if (roster.byId) return roster.byId;   // serve the slightly older copy while the new one loads
  return roster.inflight;
}
function rosterAgeMs() { return roster.byId ? Date.now() - roster.at : Infinity; }
// keep our copy in step with a check-in / undo we just did, without waiting for the next refresh
function rosterApply(id, patch) {
  if (roster.byId && roster.byId.has(id)) Object.assign(roster.byId.get(id), patch);
}
function resetRoster() { roster = { at: 0, byId: null, inflight: null }; }

// ---------------------------------------------------------- ticket store
function normId(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Production: a Google Apps Script web app attached to the ticket sheet. It does the
// lookup and the "checked in" write under a lock, so two helpers can't both check
// the same student in.
const appsScript = {
  async call(payload) {
    const r = await fetch(process.env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: process.env.APPS_SCRIPT_SECRET, ...payload }),
      redirect: 'follow',
    });
    const j = await r.json();
    if (j.error) throw new Error('sheet: ' + j.error);
    return j;
  },
  list: async () => (await appsScript.call({ action: 'list' })).tickets,
  checkin: (id, by) => appsScript.call({ action: 'checkin', id, by }),
  uncheckin: (id, by) => appsScript.call({ action: 'uncheckin', id, by }),
  helpers: async () => (await appsScript.call({ action: 'staff' })).helpers || [],
};

// Local development: tickets in a JSON file (HOCO_DEV_FILE).
const devStore = {
  read() { return JSON.parse(fs.readFileSync(process.env.HOCO_DEV_FILE, 'utf8')); },
  write(d) { fs.writeFileSync(process.env.HOCO_DEV_FILE, JSON.stringify(d, null, 2)); },
  async helpers() { return emailList('HOCO_DEV_STAFF'); },
  async uncheckin(id, by) {
    const d = devStore.read();
    const rows = d.filter((t) => t.id === id);
    if (!rows.length) return { result: 'no_ticket' };
    const done = rows.find((t) => t.at);
    if (!done) return { result: 'not_checked_in', name: rows[0].name };
    delete done.at; delete done.by;
    devStore.write(d);
    return { result: 'ok', name: done.name };
  },
  async list() { return devStore.read().map((t) => ({ id: t.id, name: t.name, first: t.first || '', last: t.last || '', checkedIn: !!t.at, at: t.at || null })); },
  async checkin(id, by) {
    const d = devStore.read();
    const rows = d.filter((t) => t.id === id);
    if (!rows.length) return { result: 'no_ticket' };
    const open = rows.find((t) => !t.at);
    if (!open) return { result: 'already', name: rows[0].name, at: rows[0].at };
    open.at = new Date().toISOString(); open.by = by;
    devStore.write(d);
    return { result: 'ok', name: open.name };
  },
};

function getStore() {
  if (process.env.APPS_SCRIPT_URL && process.env.APPS_SCRIPT_SECRET) return appsScript;
  if (process.env.HOCO_DEV === '1' && process.env.HOCO_DEV_FILE) return devStore;
  return null;
}

module.exports = { getRoster, rosterAgeMs, rosterApply, resetRoster, roleFor, setSession, clearSession, currentUser, verifyGoogle, devLoginAllowed, getStore, normId, isLocal, resetHelperCache };
