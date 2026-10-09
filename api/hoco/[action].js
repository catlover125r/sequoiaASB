// One function for the whole /hocotickets app: /api/hoco/<action>
//   config   GET   public: Google client id (+ whether dev login is available)
//   login    POST  { credential } from Google sign-in  ->  sets session cookie
//   me       GET   who am I / what role
//   logout   POST
//   checkin  POST  { id }            helper + admin
//   uncheckin POST { id }            admin only: undo a check-in
//   tickets  GET                      admin only
//   sync     POST                     admin only: reload from the sheet + push pending changes now
//   status   GET                      admin only: how the fast database / sheet sync is doing
const H = require('../_hoco');

let lastTick = 0;
function housekeeping(store) {
  if (!store.tick || Date.now() - lastTick < 15000) return;
  lastTick = Date.now();
  store.tick().catch((e) => console.error('hoco tick', e.message));
}

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

    if (action === 'lookup') {
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      housekeeping(store);
      if (store.fast) return send(res, 200, id ? await store.lookup(id) : { found: false });
      const byId = await H.getRoster(store);
      const t = id ? byId.get(id) : null;
      return send(res, 200, t ? { found: true, name: t.name, checkedIn: !!t.checkedIn, agreed: t.agreed !== false } : { found: false });
    }

    if (action === 'checkin') {
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      if (id.length < 3 || id.length > 12) return send(res, 200, { result: 'no_ticket' });
      housekeeping(store);
      if (store.fast) return send(res, 200, await store.checkin(id, user.email));   // atomic, a few ms
      // Instant "no ticket": if our recent copy of the roster doesn't have this ID, don't bother the sheet.
      // (We never answer "already checked in" from the copy: the sheet decides that, so an undo is never missed.)
      if (H.rosterAgeMs() < 90 * 1000) {
        try {
          const byId = await H.getRoster(store), t = byId.get(id);
          if (!t) return send(res, 200, { result: 'no_ticket' });
          if (t.agreed === false && !t.checkedIn) return send(res, 200, { result: 'no_agreement', name: t.name });   // dance agreement not signed
        } catch (e) { /* fall through to the sheet */ }
      }
      const r = await store.checkin(id, user.email);
      if (r.result === 'ok') H.rosterApply(id, { checkedIn: true, at: new Date().toISOString() });
      else if (r.result === 'already') H.rosterApply(id, { checkedIn: true, at: r.at || null });
      return send(res, 200, r);
    }

    if (action === 'uncheckin') {
      if (user.role !== 'admin') return send(res, 403, { error: 'admin_only' });
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      if (id.length < 3 || id.length > 12) return send(res, 200, { result: 'no_ticket' });
      const r = await store.uncheckin(id, user.email);
      if (r.result === 'ok') H.rosterApply(id, { checkedIn: false, at: null });
      return send(res, 200, r);
    }

    if (action === 'tickets') {
      if (user.role !== 'admin') return send(res, 403, { error: 'admin_only' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      if (store.fast) {
        housekeeping(store);
        const [tickets, st] = await Promise.all([store.list(), store.status()]);
        return send(res, 200, { tickets, pending: st.pending });
      }
      const byId = await H.getRoster(store);
      return send(res, 200, { tickets: Array.from(byId.values()) });
    }

    if (action === 'sync' || action === 'status') {
      if (user.role !== 'admin') return send(res, 403, { error: 'admin_only' });
      const store = H.getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      if (!store.fast) return send(res, 200, { store: 'sheet', note: 'fast database not set up yet' });
      if (action === 'sync') {
        if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
        return send(res, 200, await store.sync());
      }
      return send(res, 200, await store.status());
    }

    return send(res, 404, { error: 'unknown_action' });
  } catch (err) {
    console.error('hoco', action, err.message);
    return send(res, 500, { error: 'server_error' });
  }
};
