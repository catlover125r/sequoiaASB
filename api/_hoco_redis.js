// Fast path for the check-in app: the live state (who has a ticket, who is checked in) lives in Redis,
// so a check-in takes a few milliseconds instead of ~3 seconds of Google Sheets calls.
// The Google Sheet stays the place people edit tickets and read the results:
//   * PULL  (every ~60 s, or on demand): sheet -> Redis. Who has a ticket; check-ins already in the sheet.
//   * PUSH  (a few seconds after any check-in/undo, in one batch): Redis -> sheet. Ticks the Check In box,
//     writes time/staff, and adds lines to the "Check-in Log" tab.
// Check-ins are claimed with HSETNX, which is atomic: if two doors scan the same ticket at the same instant,
// exactly one succeeds and the other gets "already checked in".
//
// Files starting with "_" in /api are not exposed as routes by Vercel.

const R_ROSTER = 'hoco:roster';     // hash  id -> {"name","first","last"}   everyone with a ticket
const R_CI = 'hoco:ci';             // hash  id -> {"at","by"}               checked-in students
const R_DIRTY = 'hoco:dirty';       // set   ids whose state changed since the last push to the sheet
const R_EVENTS = 'hoco:events';     // list  audit lines waiting to be pushed to the "Check-in Log" tab
const R_META = 'hoco:meta';         // hash  rosterAt, rosterSize, pullError, pushAt, pushError

const PULL_EVERY_MS = 60 * 1000;
const PUSH_MIN_GAP_MS = 4 * 1000;
const PUSH_DELAY_MS = 4500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => (s == null ? null : typeof s === 'string' ? JSON.parse(s) : s);

/**
 * redis : an @upstash/redis client created with automaticDeserialization:false (every value is a string)
 * sheet : { list(), apply(changes, events), helpers() }   (the Google Apps Script adapter)
 * hooks : { waitUntil(promise) }   keeps background work alive after the response is sent
 */
function create(redis, sheet, hooks) {
  const bg = (p) => {
    const safe = p.catch((e) => console.error('hoco background task failed:', e && e.message));
    try { hooks.waitUntil(safe); } catch (e) { /* no waitUntil (local dev): it just runs */ }
  };
  const lock = async (name, ttlSec) => (await redis.set('hoco:lock:' + name, '1', { nx: true, ex: ttlSec })) === 'OK';
  const unlock = (name) => redis.del('hoco:lock:' + name);

  // ---------------------------------------------------------------- PULL: sheet -> Redis
  async function pull() {
    if (!(await lock('pull', 45))) return { skipped: true };
    try {
      const list = await sheet.list();
      if (!list.length) throw new Error('the sheet returned no tickets; keeping the current roster');
      const roster = {};
      list.forEach((t) => { roster[t.id] = JSON.stringify({ name: t.name, first: t.first || '', last: t.last || '' }); });
      const tmp = R_ROSTER + ':tmp';
      await redis.del(tmp);
      await redis.hset(tmp, roster);
      await redis.rename(tmp, R_ROSTER);          // swap the whole roster in one step
      // Check-ins that are already in the sheet but not here (e.g. the very first load). We skip students with
      // changes still waiting to be pushed, otherwise an undo would be "undone" by the older sheet copy.
      const pushing = await redis.exists('hoco:lock:push');
      if (!pushing) {
        const dirty = new Set(await redis.smembers(R_DIRTY));
        const todo = list.filter((t) => t.checkedIn && !dirty.has(t.id));
        for (let i = 0; i < todo.length; i += 100) {
          await Promise.all(todo.slice(i, i + 100).map((t) => redis.hsetnx(R_CI, t.id, JSON.stringify({ at: t.at || new Date().toISOString(), by: 'sheet' }))));
        }
      }
      await redis.hset(R_META, { rosterAt: String(Date.now()), rosterSize: String(list.length), pullError: '' });
      return { ok: true, tickets: list.length };
    } catch (e) {
      await redis.hset(R_META, { pullError: String(e.message).slice(0, 300) }).catch(() => {});
      throw e;
    } finally {
      await unlock('pull');
    }
  }

  // ---------------------------------------------------------------- PUSH: Redis -> sheet
  async function flush() {
    if (!(await lock('push', 60))) return { skipped: true };
    try {
      const ids = await redis.smembers(R_DIRTY);
      const nEv = await redis.llen(R_EVENTS);
      if (!ids.length && !nEv) return { empty: true };
      const before = await Promise.all(ids.map((id) => redis.hget(R_CI, id)));
      const events = nEv ? (await redis.lrange(R_EVENTS, 0, nEv - 1)).map(parse) : [];
      const changes = ids.map((id, k) => { const r = parse(before[k]); return { id, checked: !!r, at: r ? r.at : '', by: r ? r.by : '' }; });
      await sheet.apply(changes, events);
      // forget what we just pushed, but keep anything that changed while the (slow) push was running
      const after = await Promise.all(ids.map((id) => redis.hget(R_CI, id)));
      const settled = ids.filter((id, k) => (after[k] ?? null) === (before[k] ?? null));
      if (settled.length) await redis.srem(R_DIRTY, ...settled);
      if (nEv) await redis.ltrim(R_EVENTS, nEv, -1);
      await redis.hset(R_META, { pushAt: String(Date.now()), pushError: '' });
      return { ok: true, pushed: ids.length };
    } catch (e) {
      await redis.hset(R_META, { pushError: String(e.message).slice(0, 300) }).catch(() => {});
      throw e;
    } finally {
      await unlock('push');
    }
  }

  // one push is scheduled per few-second window, so a burst of check-ins goes to the sheet as ONE batch
  async function pushSoon() {
    if (!(await lock('soon', 5))) return;
    await sleep(PUSH_DELAY_MS);
    await flush();
  }

  // ---------------------------------------------------------------- housekeeping (runs on admin polls)
  async function tick() {
    const meta = (await redis.hgetall(R_META)) || {};
    const rosterAt = Number(meta.rosterAt || 0), pushAt = Number(meta.pushAt || 0);
    if (!rosterAt || Date.now() - rosterAt > PULL_EVERY_MS) bg(pull());
    if (Date.now() - pushAt > PUSH_MIN_GAP_MS && (await redis.scard(R_DIRTY)) > 0) bg(flush());
  }

  // First use (or after the database was cleared): the roster must exist before we can answer anything.
  // If another request is already loading it (it holds the pull lock), WAIT for it instead of answering
  // "no ticket" for a student who does have one.
  async function ensureRoster() {
    if (await redis.hlen(R_ROSTER)) return;
    const res = await pull();
    if (res && res.skipped) {
      for (let i = 0; i < 80; i++) {                  // up to ~12 s
        if (await redis.hlen(R_ROSTER)) return;
        await sleep(150);
      }
      throw new Error('the roster is still loading; try again');
    }
  }
  async function rosterEntry(id) {
    let r = await redis.hget(R_ROSTER, id);
    if (r == null) { await ensureRoster(); r = await redis.hget(R_ROSTER, id); }   // ensureRoster is instant if the roster exists
    return parse(r);
  }

  // ---------------------------------------------------------------- the operations the app uses
  async function lookup(id) {
    const [r, c] = await Promise.all([rosterEntry(id), redis.hget(R_CI, id)]);
    return r ? { found: true, name: r.name, checkedIn: c != null } : { found: false };
  }

  async function checkin(id, by) {
    const r = await rosterEntry(id);
    if (!r) return { result: 'no_ticket' };
    const rec = { at: new Date().toISOString(), by };
    const won = await redis.hsetnx(R_CI, id, JSON.stringify(rec));     // atomic: only one caller can win
    if (!won) {
      const prev = parse(await redis.hget(R_CI, id));
      return { result: 'already', name: r.name, at: prev ? prev.at : null };
    }
    await Promise.all([
      redis.sadd(R_DIRTY, id),
      redis.rpush(R_EVENTS, JSON.stringify({ t: rec.at, a: 'CHECK IN', id, name: r.name, by })),
    ]);
    bg(pushSoon());
    return { result: 'ok', name: r.name };
  }

  async function uncheckin(id, by) {
    const r = await rosterEntry(id);
    if (!r) return { result: 'no_ticket' };
    const removed = await redis.hdel(R_CI, id);
    if (!removed) return { result: 'not_checked_in', name: r.name };
    await Promise.all([
      redis.sadd(R_DIRTY, id),
      redis.rpush(R_EVENTS, JSON.stringify({ t: new Date().toISOString(), a: 'UNDO', id, name: r.name, by })),
    ]);
    bg(pushSoon());
    return { result: 'ok', name: r.name };
  }

  async function list() {
    await ensureRoster();
    const [roster, ci] = await Promise.all([redis.hgetall(R_ROSTER), redis.hgetall(R_CI)]);
    const out = [];
    for (const id of Object.keys(roster || {})) {
      const r = parse(roster[id]), c = ci && ci[id] ? parse(ci[id]) : null;
      out.push({ id, name: r.name, first: r.first, last: r.last, checkedIn: !!c, at: c ? c.at : null });
    }
    return out;
  }

  async function status() {
    const [roster, ci, dirty, events, meta] = await Promise.all([
      redis.hlen(R_ROSTER), redis.hlen(R_CI), redis.scard(R_DIRTY), redis.llen(R_EVENTS), redis.hgetall(R_META),
    ]);
    return { store: 'redis', tickets: roster, checkedIn: ci, pending: dirty, pendingLog: events, meta: meta || {} };
  }

  // Admin "sync now": reload tickets from the sheet and push anything waiting.
  async function sync() {
    const pulled = await pull();
    const pushed = await flush();
    return { pulled, pushed, ...(await status()) };
  }

  return { fast: true, lookup, checkin, uncheckin, list, helpers: () => sheet.helpers(), tick, sync, status, pull, flush, _bg: bg };
}

module.exports = { create };
