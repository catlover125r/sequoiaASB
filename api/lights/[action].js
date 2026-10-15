// One function for HOCO Flashlights: /api/lights/<action>
//   state  GET    public: what the lights are doing. Cached by Vercel's CDN for 1 s, so hundreds of phones
//                 polling it cost about one database read per second.
//   time   GET    public: server clock (phones sync to it so they all blink at the same instant)
//   join   POST   { id?, x, y }  -> { id, n, x, y }   pick a seat, get a join number
//   ping   POST   { id }         -> { t }             "still here" (+ server clock)
//   login  POST   { password }   -> { token }         control page
//   set    POST   { mode, seq }  control: change the lights (header x-lights-token)
//   people GET    control: who joined and where
//   reset  POST   control: forget everyone's numbers and seats
const L = require('../_lights');

function send(res, code, body, cdnSeconds) {
  res.setHeader('Cache-Control', 'no-store');
  if (cdnSeconds) {
    // browsers never cache it; Vercel's CDN shares one answer per second between all the phones
    res.setHeader('Vercel-CDN-Cache-Control', 'max-age=' + cdnSeconds);
    res.setHeader('CDN-Cache-Control', 'max-age=' + cdnSeconds);
  }
  res.status(code).json(body);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '');
  const isPost = req.method === 'POST';
  const body = (isPost && req.body && typeof req.body === 'object') ? req.body : {};
  try {
    if (action === 'time') return send(res, 200, { t: Date.now() });

    const store = L.getStore();
    if (!store) return send(res, 503, { error: 'not_connected' });

    if (action === 'state') return send(res, 200, { ...(await store.getState()), t: Date.now() }, 1);

    if (action === 'join') {
      if (!isPost) return send(res, 405, { error: 'method' });
      return send(res, 200, await store.join(body.id, body.x, body.y));
    }
    if (action === 'ping') {
      if (!isPost) return send(res, 405, { error: 'method' });
      const ok = await store.ping(body.id);
      return send(res, 200, { ok, t: Date.now() });
    }

    if (action === 'login') {
      if (!isPost) return send(res, 405, { error: 'method' });
      if (!process.env.LIGHTS_PASSWORD) return send(res, 503, { error: 'not_configured' });
      if (!L.checkPassword(String(body.password || ''))) {
        await sleep(600);   // slow down guessing
        return send(res, 401, { error: 'wrong_password' });
      }
      return send(res, 200, { token: L.makeToken() });
    }

    // ---- control page only
    if (!L.checkToken(req.headers['x-lights-token'])) return send(res, 401, { error: 'signed_out' });

    if (action === 'set') {
      if (!isPost) return send(res, 405, { error: 'method' });
      return send(res, 200, { ...(await store.setState(String(body.mode || ''), body.seq ? String(body.seq) : null)), t: Date.now() });
    }
    if (action === 'people') return send(res, 200, await store.people());
    if (action === 'reset') {
      if (!isPost) return send(res, 405, { error: 'method' });
      await store.reset();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'unknown_action' });
  } catch (e) {
    if (e && e.code === 400) return send(res, 400, { error: e.message });
    console.error('lights', action, e);
    return send(res, 500, { error: 'server_error' });
  }
};
