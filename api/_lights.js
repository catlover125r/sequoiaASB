// HOCO Flashlights backend: who joined (number + seat) and what the lights are doing.
// Redis keys (prefix "lights:"):
//   state   JSON { v, mode, seq, at, prev }   what the lights do; `at` is the server time it takes effect
//   n       counter handing out join numbers (1, 2, 3...; odd/even = the two halves)
//   people  hash  id -> JSON { n, x, y }      spot on the map: x 0..19 across, y 0..9 = the 10 rows
//   seen    hash  id -> last ping (ms)        who still has the page open
// Files starting with "_" in /api are not exposed as routes by Vercel.
const crypto = require('crypto');
const SEQ = require('../lights/sequences.js');

const LEAD_MS = 3500;          // a change starts this long after it is pressed, so every phone hears about it in time
const ACTIVE_MS = 75 * 1000;   // phones ping every 30 s; count a phone as here if we heard from it in the last 75 s
const TOKEN_HOURS = 12;

function create(redis, opts) {
  const P = (opts && opts.prefix) || 'lights:';
  const now = (opts && opts.now) || (() => Date.now());
  const K = { state: P + 'state', n: P + 'n', people: P + 'people', seen: P + 'seen' };
  const parse = (s) => (s == null ? null : typeof s === 'string' ? JSON.parse(s) : s);
  const hgetall = async (key) => {
    const v = await redis.hgetall(key);
    if (!v) return {};
    if (!Array.isArray(v)) return v;
    const o = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
    return o;
  };
  const seat = (v, size) => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n < size ? n : null;
  };

  async function getState() {
    return parse(await redis.get(K.state)) || { v: 0, mode: 'off', seq: null, at: 0, prev: null };
  }

  // mode: 'off' | 'on' | 'split' | 'seq' (with seq = a sequence id)
  async function setState(mode, seq) {
    if (!['off', 'on', 'split', 'seq'].includes(mode)) throw Object.assign(new Error('bad mode'), { code: 400 });
    if (mode === 'seq' && !SEQ.BY_ID[seq]) throw Object.assign(new Error('bad sequence'), { code: 400 });
    const t = now();
    const old = await getState();
    // keep only what is still showing (or about to): the state in effect right now, without its own history
    const showing = SEQ.activeState(old, t);
    const next = {
      v: (old.v || 0) + 1,
      mode,
      seq: mode === 'seq' ? seq : null,
      at: t + LEAD_MS,
      prev: { mode: showing.mode || 'off', seq: showing.seq || null, at: showing.at || 0 },
    };
    await redis.set(K.state, JSON.stringify(next));
    return next;
  }

  // Join (or move seats). A phone that already has an id keeps its number.
  async function join(id, x, y) {
    x = seat(x, SEQ.COLS); y = seat(y, SEQ.ROWS);
    if (x == null || y == null) throw Object.assign(new Error('pick your spot on the map first'), { code: 400 });
    id = typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) ? id : null;
    let n = null;
    if (id) {
      const had = parse(await redis.hget(K.people, id));
      if (had && had.n) n = had.n;
    }
    if (!n) {
      id = crypto.randomBytes(12).toString('hex');
      n = Number(await redis.incr(K.n));
    }
    await redis.hset(K.people, { [id]: JSON.stringify({ n, x, y }) });
    await redis.hset(K.seen, { [id]: String(now()) });
    return { id, n, x, y };
  }

  // false = we don't know this phone (e.g. after a reset): the page joins again and gets a new number
  async function ping(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return false;
    if (!(await redis.hget(K.people, id))) return false;
    await redis.hset(K.seen, { [id]: String(now()) });
    return true;
  }

  async function people() {
    const [ppl, seen, total] = await Promise.all([hgetall(K.people), hgetall(K.seen), redis.get(K.n)]);
    const t = now();
    const list = [];
    for (const id of Object.keys(ppl)) {
      const p = parse(ppl[id]);
      if (!p) continue;
      const last = Number(seen[id] || 0);
      list.push({ n: p.n, x: p.x, y: p.y, active: t - last < ACTIVE_MS });
    }
    list.sort((a, b) => a.n - b.n);
    return { joined: Number(total || 0), active: list.filter((p) => p.active).length, people: list };
  }

  // Start over for a new night: everyone gets a new number when they next join (open pages re-join on their own).
  async function reset() {
    await redis.del(K.people, K.seen, K.n);
    return true;
  }

  return { getState, setState, join, ping, people, reset, LEAD_MS };
}

// ------------------------------------------------------------------ control-page sign in
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET is not set');
  return s;
}
function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function checkPassword(pw) {
  const want = process.env.LIGHTS_PASSWORD;
  if (!want) return false;
  return sameText(pw, want);
}
function makeToken(t = Date.now()) {
  const body = 'lights.' + (t + TOKEN_HOURS * 3600 * 1000);
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function checkToken(tok, t = Date.now()) {
  const m = /^lights\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(tok || ''));
  if (!m || Number(m[1]) < t) return false;
  const good = crypto.createHmac('sha256', secret()).update('lights.' + m[1]).digest('base64url');
  return sameText(m[2], good);
}

let shared = null;
function getStore() {
  if (shared) return shared;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = require('@upstash/redis');
    shared = create(new Redis({ url, token, automaticDeserialization: false }));
  } else if (process.env.LIGHTS_DEV === '1') {
    shared = create(require('./_dev_fake_redis').fakeRedis());
  }
  return shared;
}

module.exports = { create, getStore, checkPassword, makeToken, checkToken, LEAD_MS };
