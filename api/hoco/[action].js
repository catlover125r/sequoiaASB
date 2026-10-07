// One function for the whole /hocotickets app: /api/hoco/<action>
//   config   GET   public: Google client id (+ whether dev login is available)
//   login    POST  { credential } from Google sign-in  ->  sets session cookie
//   me       GET   who am I / what role
//   logout   POST
//   checkin  POST  { id }            helper + admin
//   tickets  GET                      admin only
const H = require('../_hoco');

function send(res, code, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(body);
}

module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '');
  try {
    if (action === 'config') {
      return send(res, 200, { clientId: process.env.GOOGLE_CLIENT_ID || null, dev: H.devLoginAllowed(req) });
    }

    if (action === 'me') {
      const u = await H.currentUser(req);
      return u ? send(res, 200, u) : send(res, 401, { error: 'signed_out' });
    }

    // everything below changes state: POST only, and the request must carry our header
    // (a custom header can't be sent by another site without our permission)
    const isPost = req.method === 'POST';

    if (action === 'logout') {
      if (!isPost) return send(res, 405, { error: 'method' });
      H.clearSession(res);
      return send(res, 200, { ok: true });
    }

    if (action === 'login') {
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const body = req.body || {};
      let email;
      if (body.dev && H.devLoginAllowed(req)) {
        email = String(body.dev).toLowerCase();
      } else {
        if (!process.env.GOOGLE_CLIENT_ID) return send(res, 503, { error: 'not_configured' });
        try { email = await H.verifyGoogle(String(body.credential || '')); }
        catch { return send(res, 401, { error: 'bad_credential' }); }
      }
      const role = await H.roleFor(email);
      if (!role) return send(res, 403, { error: 'not_authorized' });   // same answer for any non-listed account
      H.setSession(req, res, email);
      return send(res, 200, { email, role });
    }

    // ---- everything else needs a signed-in staff member
    const user = await H.currentUser(req);
    if (!user) return send(res, 401, { error: 'signed_out' });

    if (action === 'checkin') {
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      if (id.length < 3 || id.length > 12) return send(res, 200, { result: 'no_ticket' });
      const r = await store.checkin(id, user.email);
      return send(res, 200, r);
    }

    if (action === 'tickets') {
      if (user.role !== 'admin') return send(res, 403, { error: 'admin_only' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const tickets = await store.list();
      return send(res, 200, { tickets });
    }

    return send(res, 404, { error: 'unknown_action' });
  } catch (err) {
    console.error('hoco', action, err.message);
    return send(res, 500, { error: 'server_error' });
  }
};
