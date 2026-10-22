// Jeopardy (/jeopardy1 TV, /jeopardy1control host, /jeopardy1join players).
// Redis keys (prefix "jeop1:"):
//   state    JSON, written ONLY by host actions (one writer, so no races): phase, scores, current clue...
//   board    JSON { cats: [{ name, clues: [{ q, a } x5] } x6], dd }   the questions (edited on the control page)
//   players  hash  secret id -> JSON { n, name, color }
//   colors   hash  '#rrggbb' -> n (HSETNX, so two phones can't grab the same color)
//   n        counter handing out player numbers
//   buzz:<game>:<attempt>        "n|ms"   first buzz wins (SET NX)
//   early:<game>:<n>             buzzed while no clue was open -> locked out for EARLY_MS (stops button mashing)
// The public view never contains answers or where the Daily Doubles are.
const crypto = require('crypto');

const COLS = 6, ROWS = 5;
const VALUES = [200, 400, 600, 800, 1000];
const COLORS = [
  { id: 'red', name: 'Red', hex: '#e53935' },
  { id: 'orange', name: 'Orange', hex: '#fb8c00' },
  { id: 'yellow', name: 'Yellow', hex: '#fdd835' },
  { id: 'green', name: 'Green', hex: '#43a047' },
  { id: 'teal', name: 'Teal', hex: '#00acc1' },
  { id: 'blue', name: 'Blue', hex: '#1e6fe8' },
  { id: 'white', name: 'White', hex: '#f2f2f2' },
  { id: 'pink', name: 'Pink', hex: '#ec407a' },
];
const MAX_PLAYERS = 10;
// a preset id ('red') or any '#rrggbb' from the custom color picker -> '#rrggbb'
function normColor(c) {
  const preset = COLORS.find((x) => x.id === c);
  if (preset) return preset.hex;
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
}
const REOPEN_MS = 1500;     // after a wrong answer, buzzers reopen this long later (every phone hears about it first)
const EARLY_MS = 1000;      // buzzing while no clue is open locks you out this long
const TOKEN_HOURS = 12;
const TTL = 12 * 3600;


function placeholderBoard() {
  return {
    dd: 1,
    cats: Array.from({ length: COLS }, (_, c) => ({
      name: 'Category ' + (c + 1),
      clues: VALUES.map((v) => ({ q: `Placeholder clue for Category ${c + 1} for $${v}`, a: `Answer ${c + 1}-${v}` })),
    })),
  };
}

// audio clues are mp3s shipped with the site under random names (so the URL doesn't give the song away)
const AUDIO_RE = /^\/jeopardy1-media\/[a-z0-9-]{4,40}\.mp3$/;

const bad = (msg) => Object.assign(new Error(msg), { code: 400 });
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanBoard(b) {
  if (!b || !Array.isArray(b.cats) || b.cats.length !== COLS) throw bad('the board needs 6 categories');
  const dd = Number(b.dd);
  return {
    dd: Number.isInteger(dd) && dd >= 0 && dd <= 3 ? dd : 1,
    cats: b.cats.map((cat, c) => {
      if (!cat || !Array.isArray(cat.clues) || cat.clues.length !== ROWS) throw bad('each category needs 5 clues');
      return {
        name: cleanText(cat.name, 60) || 'Category ' + (c + 1),
        clues: cat.clues.map((k) => {
          const out = { q: cleanText(k && k.q, 400), a: cleanText(k && k.a, 200) };
          if (k && k.audio) {
            if (!AUDIO_RE.test(k.audio)) throw bad('bad audio path: ' + String(k.audio).slice(0, 80));
            out.audio = k.audio;
          }
          return out;
        }),
      };
    }),
  };
}

function pickDailyDoubles(count) {
  const spots = [];
  for (let c = 0; c < COLS; c++) for (let r = 1; r < ROWS; r++) spots.push([c, r]);   // never the $200 row
  const out = [];
  while (out.length < count && spots.length) {
    const i = crypto.randomInt(spots.length);
    const [s] = spots.splice(i, 1);
    if (out.some(([c]) => c === s[0])) continue;   // at most one per category
    out.push(s);
  }
  return out;
}

function create(redis, opts) {
  const P = (opts && opts.prefix) || 'jeop1:';
  const now = (opts && opts.now) || (() => Date.now());
  const K = { state: P + 'state', board: P + 'board', players: P + 'players', colors: P + 'colors', n: P + 'n' };
  const buzzKey = (s) => P + 'buzz:' + s.game + ':' + s.q.attempt;
  const earlyKey = (s, n) => P + 'early:' + s.game + ':' + n;
  const parse = (s) => (s == null ? null : typeof s === 'string' ? JSON.parse(s) : s);
  const hgetall = async (key) => {
    const v = await redis.hgetall(key);
    if (!v) return {};
    if (!Array.isArray(v)) return v;
    const o = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[v[i]] = v[i + 1];
    return o;
  };
  const OFF = { v: 0, phase: 'off', game: null };

  const getState = async () => parse(await redis.get(K.state)) || { ...OFF };
  const putState = async (s) => { s.v = (s.v || 0) + 1; await redis.set(K.state, JSON.stringify(s)); return s; };
  const getBoard = async () => parse(await redis.get(K.board)) || placeholderBoard();
  async function saveBoard(b) {
    const clean = cleanBoard(b);
    await redis.set(K.board, JSON.stringify(clean));
    const s = await getState();
    if (s.game) { s.cats = clean.cats.map((c) => c.name); await putState(s); }
    return clean;
  }

  async function playerList() {
    const all = await hgetall(K.players);
    return Object.values(all).map(parse).filter(Boolean).sort((a, b) => a.n - b.n);
  }
  const validId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id);
  async function playerById(id) {
    if (!validId(id)) return null;
    return parse(await redis.hget(K.players, id));
  }

  // ---------------------------------------------------------------- views
  async function readBuzz(s) {
    if (s.phase !== 'question' || !s.q) return null;
    const v = await redis.get(buzzKey(s));
    if (!v) return null;
    const [n, at] = String(v).split('|').map(Number);
    return { n, at };
  }

  // what the TV and the phones see; the host also gets the answer
  async function view(host) {
    const s = await getState();
    const [players, buzz] = await Promise.all([s.game ? playerList() : [], readBuzz(s)]);
    const out = {
      v: s.v, phase: s.phase, game: s.game, cats: s.cats || null, values: VALUES, used: s.used || null,
      colors: COLORS,
      players: players.map((p) => ({ n: p.n, name: p.name, color: p.color, score: (s.scores && s.scores[p.n]) || 0 })),
      t: now(),
    };
    if (s.phase === 'question' || s.phase === 'dd') {
      const q = s.q;
      out.q = { c: q.c, r: q.r, value: q.value, dd: q.dd, only: q.only == null ? null : q.only };
      if (s.phase === 'question') Object.assign(out.q, { text: q.text, audio: q.audio || null, replay: q.replay || 0, attempt: q.attempt, openAt: q.openAt, locked: q.locked, last: q.last || null, buzz });
      if (host) Object.assign(out.q, { text: q.text, answer: q.answer });
    }
    if (s.phase === 'reveal') out.rev = s.rev;
    return out;
  }
  const publicView = () => view(false);
  const hostView = () => view(true);

  // ---------------------------------------------------------------- players
  async function join(id, game, name, color) {
    const s = await getState();
    if (!s.game || s.phase === 'off') throw bad('The host has not started the game yet.');
    name = cleanText(name, 16);
    if (!name) throw bad('Type your name first.');
    color = normColor(color);
    if (!color) throw bad('Pick a color.');
    let me = game === s.game ? await playerById(id) : null;
    const taken = () => bad('Someone already has that color. Pick another one.');
    if (!me) {
      if ((await redis.hlen(K.players)) >= MAX_PLAYERS) throw bad('The game is full.');
      if (await redis.hget(K.colors, color)) throw taken();
      id = crypto.randomBytes(12).toString('hex');
    }
    const n = me ? me.n : Number(await redis.incr(K.n));
    if (!me || me.color !== color) {
      if (!(await redis.hsetnx(K.colors, color, String(n)))) throw taken();
      if (me) await redis.hdel(K.colors, me.color);
    }
    me = { n, name, color };
    await redis.hset(K.players, { [id]: JSON.stringify(me) });
    return { id, game: s.game, ...me };
  }

  async function me(id, game) {
    const s = await getState();
    if (!s.game || game !== s.game) return null;
    return playerById(id);
  }

  async function buzz(id) {
    const [s, p] = await Promise.all([getState(), playerById(id)]);
    if (!p) return { result: 'not_joined' };
    const q = s.q;
    const t = now();
    const tooEarly = ['board', 'dd', 'reveal'].includes(s.phase) || (s.phase === 'question' && t < q.openAt);
    if (s.phase === 'question' && q.only != null && q.only !== p.n) return { result: 'not_you' };
    if (tooEarly) {
      await redis.set(earlyKey(s, p.n), '1', { px: EARLY_MS });
      return { result: 'early', lockMs: EARLY_MS };
    }
    if (s.phase !== 'question' || !q) return { result: 'closed' };
    if (q.locked.includes(p.n)) return { result: 'locked_out' };
    if (await redis.get(earlyKey(s, p.n))) return { result: 'early_lock' };
    const won = await redis.set(buzzKey(s), p.n + '|' + t, { nx: true, ex: TTL });
    if (won) return { result: 'first', attempt: q.attempt };
    const b = await readBuzz(s);
    return { result: b && b.n === p.n ? 'first' : 'beaten', by: b ? b.n : null };
  }

  // ---------------------------------------------------------------- host
  async function start() {
    const board = await getBoard();
    await redis.del(K.players, K.colors, K.n);
    const s = {
      v: ((await getState()).v || 0),
      phase: 'lobby', game: crypto.randomBytes(4).toString('hex'),
      cats: board.cats.map((c) => c.name),
      used: Array.from({ length: COLS }, () => Array(ROWS).fill(false)),
      dd: pickDailyDoubles(board.dd),
      scores: {}, q: null, rev: null, attempts: 0,
    };
    return putState(s);
  }

  const need = (s, ...phases) => { if (!phases.includes(s.phase)) throw bad('not now (' + s.phase + ')'); };

  async function begin() {
    const s = await getState();
    need(s, 'lobby', 'final');
    s.phase = 'board';
    return putState(s);
  }

  async function select(c, r) {
    const s = await getState();
    need(s, 'board');
    c = Number(c); r = Number(r);
    if (!(Number.isInteger(c) && c >= 0 && c < COLS && Number.isInteger(r) && r >= 0 && r < ROWS)) throw bad('bad square');
    if (s.used[c][r]) throw bad('already played');
    const clue = (await getBoard()).cats[c].clues[r];
    const isDD = s.dd.some(([x, y]) => x === c && y === r);
    s.q = { c, r, value: VALUES[r], dd: isDD, only: null, text: clue.q, answer: clue.a, audio: clue.audio || null, replay: 0, locked: [], attempt: 0, openAt: 0, last: null };
    if (isDD) s.phase = 'dd';
    else openClue(s);
    return putState(s);
  }

  function openClue(s, lead) {
    s.phase = 'question';
    s.attempts = (s.attempts || 0) + 1;
    s.q.attempt = s.attempts;
    s.q.openAt = now() + (lead || 0);
  }

  async function dailyDouble(n, wager) {
    const s = await getState();
    need(s, 'dd');
    n = Number(n); wager = Math.round(Number(wager));
    const players = await playerList();
    if (!players.some((p) => p.n === n)) throw bad('pick a player');
    const max = Math.max((s.scores[n] || 0), 1000);
    if (!(Number.isFinite(wager) && wager >= 0 && wager <= max)) throw bad('wager must be 0 to ' + max);
    s.q.only = n;
    s.q.value = wager;
    openClue(s);
    return putState(s);
  }

  async function openNow() {
    const s = await getState();
    need(s, 'question');
    if (s.q.openAt > now()) { s.q.openAt = now(); await putState(s); }
    return s;
  }

  // audio clue: the TV starts the song over
  async function replay() {
    const s = await getState();
    need(s, 'question');
    if (!s.q.audio) throw bad('this clue has no song');
    s.q.replay = (s.q.replay || 0) + 1;
    return putState(s);
  }

  function finish(s, winner, delta) {
    s.used[s.q.c][s.q.r] = true;
    s.rev = { c: s.q.c, r: s.q.r, text: s.q.text, answer: s.q.answer, audio: s.q.audio || null, value: s.q.value, dd: s.q.dd, winner, delta, last: s.q.last };
    s.q = null;
    s.phase = 'reveal';
  }

  // verdict: 'right' (green) | 'wrong' (red) | 'skip' (yellow: no points, buzzers reopen for everyone)
  async function judge(attempt, verdict) {
    const s = await getState();
    need(s, 'question');
    if (Number(attempt) !== s.q.attempt) throw bad('that buzz is over');
    const b = await readBuzz(s);
    if (!b) throw bad('nobody has buzzed in');
    const n = b.n, value = s.q.value;
    const add = (d) => { s.scores[n] = (s.scores[n] || 0) + d; };
    if (verdict === 'right') {
      add(value);
      s.q.last = { n, verdict, delta: value, at: now() };
      finish(s, n, value);
    } else if (verdict === 'wrong') {
      add(-value);
      s.q.locked.push(n);
      s.q.last = { n, verdict, delta: -value, at: now() };
      const eligible = s.q.only != null ? [s.q.only] : (await playerList()).map((p) => p.n);
      if (eligible.every((x) => s.q.locked.includes(x))) finish(s, null, 0);
      else openClue(s, REOPEN_MS);
    } else if (verdict === 'skip') {
      s.q.last = { n, verdict, delta: 0, at: now() };
      openClue(s, REOPEN_MS);
    } else throw bad('bad verdict');
    return putState(s);
  }

  // nobody got it / nobody buzzed: show the answer, square is used
  async function reveal() {
    const s = await getState();
    need(s, 'question', 'dd');
    finish(s, null, 0);
    return putState(s);
  }

  // tapped the wrong square: back to the board, square stays playable
  async function cancel() {
    const s = await getState();
    need(s, 'question', 'dd');
    if (s.q.locked.length || s.q.last) throw bad('points were already given for this clue; use Reveal instead');
    s.q = null;
    s.phase = 'board';
    return putState(s);
  }

  async function next() {
    const s = await getState();
    need(s, 'reveal');
    s.rev = null;
    s.phase = s.used.every((col) => col.every(Boolean)) ? 'final' : 'board';
    return putState(s);
  }

  async function final() {
    const s = await getState();
    need(s, 'board', 'reveal');
    s.rev = null;
    s.phase = 'final';
    return putState(s);
  }

  async function adjust(n, delta) {
    const s = await getState();
    if (!s.game) throw bad('no game');
    n = Number(n); delta = Math.round(Number(delta));
    if (!Number.isFinite(delta)) throw bad('bad amount');
    s.scores[n] = (s.scores[n] || 0) + delta;
    return putState(s);
  }

  async function kick(n) {
    n = Number(n);
    const all = await hgetall(K.players);
    for (const [id, raw] of Object.entries(all)) {
      const p = parse(raw);
      if (p && p.n === n) { await redis.hdel(K.players, id); await redis.hdel(K.colors, p.color); }
    }
    return true;
  }

  async function end() {
    await redis.del(K.players, K.colors, K.n);
    return putState({ v: (await getState()).v, phase: 'off', game: null });
  }

  return {
    getState, publicView, hostView, getBoard, saveBoard, join, me, buzz, replay,
    start, begin, select, dailyDouble, openNow, judge, reveal, cancel, next, final, adjust, kick, end,
  };
}

// ---------------------------------------------------------------- control-page sign in
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
  const want = process.env.JEOPARDY_PASSWORD;
  return !!want && sameText(pw, want);
}
function makeToken(t = Date.now()) {
  const body = 'jeop1.' + (t + TOKEN_HOURS * 3600 * 1000);
  return body + '.' + crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}
function checkToken(tok, t = Date.now()) {
  const m = /^jeop1\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(tok || ''));
  if (!m || Number(m[1]) < t) return false;
  const good = crypto.createHmac('sha256', secret()).update('jeop1.' + m[1]).digest('base64url');
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
  } else if (process.env.JEOPARDY_DEV === '1') {
    shared = create(require('./_dev_fake_redis').fakeRedis());
  }
  return shared;
}

module.exports = { create, getStore, checkPassword, makeToken, checkToken, placeholderBoard, COLORS, VALUES, REOPEN_MS, EARLY_MS };
