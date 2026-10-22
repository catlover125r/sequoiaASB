// One function for Jeopardy: /api/jeopardy/<action>
//   time    GET   server clock, no database (pages sync to it so "buzzers open" shows at the same moment everywhere)
//   state   GET   public view. Phones use it as-is (Vercel's CDN shares one answer per second between them);
//                 the TV adds ?live=1 to skip the cache.
//   join    POST  { id?, game?, name, color } -> { id, game, n, name, color }
//   me      POST  { id, game } -> { player }  (null = join again)
//   buzz    POST  { id } -> { result }
//   pin     POST  { id, x, y } -> { result }   where-on-campus guess (0..1 across the campus map)
//   login   POST  { password } -> { token }
//   host    GET   host view (with the answer)                 -- everything below needs header x-jeopardy-token
//   board   GET / POST { board }                                questions editor
//   start, begin, select {c,r}, dd {n,wager}, open, judge {attempt,verdict}, reveal, cancel, next, final,
//   replay, pinend {force}, adjust {n,delta}, kick {n}, end     POST, each returns the host view
const J = require('../_jeopardy');

function send(res, code, body, cdnSeconds) {
  res.setHeader('Cache-Control', 'no-store');
  if (cdnSeconds) {
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=' + cdnSeconds);
    res.setHeader('CDN-Cache-Control', 'max-age=' + cdnSeconds);
  }
  res.status(code).json(body);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST_ACTIONS = {
  start: (s) => s.start(),
  begin: (s) => s.begin(),
  select: (s, b) => s.select(b.c, b.r),
  dd: (s, b) => s.dailyDouble(b.n, b.wager),
  open: (s) => s.openNow(),
  judge: (s, b) => s.judge(b.attempt, String(b.verdict || '')),
  reveal: (s) => s.reveal(),
  replay: (s) => s.replay(),
  pinend: (s, b) => s.pinEnd(!!b.force),
  cancel: (s) => s.cancel(),
  next: (s) => s.next(),
  final: (s) => s.final(),
  adjust: (s, b) => s.adjust(b.n, b.delta),
  kick: (s, b) => s.kick(b.n),
  end: (s) => s.end(),
};

module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '');
  const isPost = req.method === 'POST';
  const body = (isPost && req.body && typeof req.body === 'object') ? req.body : {};
  try {
    if (action === 'time') return send(res, 200, { t: Date.now() });

    const store = J.getStore();
    if (!store) return send(res, 503, { error: 'not_connected' });

    if (action === 'state') return send(res, 200, await store.publicView(), req.query.live ? 0 : 1);

    if (action === 'join') {
      if (!isPost) return send(res, 405, { error: 'method' });
      return send(res, 200, await store.join(body.id, body.game, body.name, body.color));
    }
    if (action === 'me') {
      if (!isPost) return send(res, 405, { error: 'method' });
      return send(res, 200, { player: await store.me(body.id, body.game) });
    }
    if (action === 'buzz') {
      if (!isPost) return send(res, 405, { error: 'method' });
      return send(res, 200, { ...(await store.buzz(body.id)), t: Date.now() });
    }

    if (action === 'pin') {
      if (!isPost) return send(res, 405, { error: 'method' });
      return send(res, 200, await store.placePin(body.id, body.x, body.y));
    }

    if (action === 'login') {
      if (!isPost) return send(res, 405, { error: 'method' });
      if (!process.env.JEOPARDY_PASSWORD) return send(res, 503, { error: 'not_configured' });
      if (!J.checkPassword(String(body.password || ''))) {
        await sleep(600);
        return send(res, 401, { error: 'wrong_password' });
      }
      return send(res, 200, { token: J.makeToken() });
    }

    // ---- host only
    if (!J.checkToken(req.headers['x-jeopardy-token'])) return send(res, 401, { error: 'signed_out' });

    if (action === 'host') return send(res, 200, await store.hostView());
    if (action === 'board') {
      if (isPost) return send(res, 200, { board: await store.saveBoard(body.board) });
      return send(res, 200, { board: await store.getBoard() });
    }
    const fn = HOST_ACTIONS[action];
    if (!fn) return send(res, 404, { error: 'unknown_action' });
    if (!isPost) return send(res, 405, { error: 'method' });
    await fn(store, body);
    return send(res, 200, await store.hostView());
  } catch (e) {
    if (e && e.code === 400) return send(res, 400, { error: e.message });
    console.error('jeopardy', action, e);
    return send(res, 500, { error: 'server_error' });
  }
};
