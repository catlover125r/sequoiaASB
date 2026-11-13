// One function for the whole check-in app (/checkin, /tickets): /api/hoco/<action>
//   config   GET   public: Google client id (+ whether dev login is available)
//   login    POST  { credential } from Google sign-in  ->  sets session cookie
//   me       GET   who am I, and which events I work at
//   logout   POST
//   checkin  POST  { id }            helper + admin
//   uncheckin POST { id }            admin only: undo a check-in
//   tickets  GET                      admin only
//   sync     POST                     admin only: reload from the sheet + push pending changes now
//   status   GET                      admin only: how the fast database / sheet sync is doing
//   event    GET                      admin only: the organizer page's view of one event
//   design   POST                     admin only: save the ticket look (colors + art)
//   samplepass GET                    admin only: a Wallet pass of this event with made-up details
// The actions from checkin down take ?ev=<event code> (an event run from a ticket sheet, see _events.js).
// Without it they work on the one sheet connected by APPS_SCRIPT_URL, as they did for Ravenchella 2026.
//
// Called by the ticket sheet's script, not by people (no sign-in; they carry the sheet key instead):
//   sheet-sync POST { key, ev, settings, staff, tickets, ... }  ->  { changes, events, links }
//   sheet-ack  POST { key, ev, toks, seq }
const H = require('../_hoco');
const E = require('../_events');
const P = require('../_pkpass');

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

// The ticket sheet's script calls in (about once a minute while an event is active).
//   sheet-sync: here is my ticket list, staff and settings; what should I write into the sheet?
//   sheet-ack:  I wrote those; forget them.
async function sheetCall(action, req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  const b = req.body || {};
  if (!E.keyOk(b.key)) return send(res, 401, { error: 'bad_key' });      // also the answer when TICKETS_KEY is not set up
  const ev = E.normEv(b.ev);
  if (!ev) return send(res, 400, { error: 'bad_event' });
  if (!E.redis()) return send(res, 503, { error: 'not_connected' });
  const store = E.storeFor(ev);

  if (action === 'sheet-ack') {
    await store.ack(b.toks && typeof b.toks === 'object' ? b.toks : {}, b.seq);
    return send(res, 200, { ok: true });
  }

  // settings / staff / tickets are only sent when they changed since the sheet's last call
  const patch = {};
  if (b.settings) patch.settings = E.cleanSettings(b.settings);
  if (b.staff) patch.staff = E.cleanStaff(b.staff);
  if (b.owner !== undefined) patch.owner = String(b.owner || '').trim().toLowerCase().slice(0, 120);
  if (b.sheet && typeof b.sheet === 'object') patch.sheet = { id: String(b.sheet.id || '').slice(0, 100), url: String(b.sheet.url || '').slice(0, 300), name: String(b.sheet.name || '').slice(0, 120) };
  if (typeof b.emailed === 'number') patch.emailed = Math.max(0, Math.floor(b.emailed));
  if (typeof b.autoSend === 'boolean') patch.autoSend = b.autoSend;
  let cfg = await E.getCfg(ev, true);
  if (!cfg && !patch.settings) return send(res, 409, { error: 'send_everything' });      // we don't know this event yet
  const changed = !cfg || Object.keys(patch).some((k) => JSON.stringify(patch[k]) !== JSON.stringify(cfg[k]));
  if (changed) cfg = await E.saveCfg(ev, patch);
  if (Array.isArray(b.tickets)) await store.ingest(E.cleanTickets(b.tickets));

  const [out, tickets] = await Promise.all([store.outbox(), store.count()]);
  const links = {};
  (Array.isArray(b.wantLinks) ? b.wantLinks : []).slice(0, 300).forEach((id) => {
    const d = H.normId(id);
    if (d.length >= 3 && d.length <= 12) links[d] = 'https://' + SITE_HOST + '/t/' + E.linkCode(ev, d);
  });
  return send(res, 200, { ok: true, ev, tickets, changes: out.changes, events: out.events, links, wallet: P.available(),
    checkin: 'https://' + SITE_HOST + '/checkin', organize: 'https://' + SITE_HOST + '/tickets' });
}
const SITE_HOST = 'sequoiaasb.org';

module.exports = async (req, res) => {
  const action = String((req.query && req.query.action) || '');
  try {
    if (action === 'config') {
      return send(res, 200, { clientId: process.env.GOOGLE_CLIENT_ID || null, dev: H.devLoginAllowed(req) });
    }

    if (action === 'sheet-sync' || action === 'sheet-ack') return await sheetCall(action, req, res);

    if (action === 'me') {
      const email = H.sessionEmail(req);
      if (!email) return send(res, 401, { error: 'signed_out' });
      const [u, events] = await Promise.all([H.currentUser(req), E.eventsFor(email)]);
      if (!u && !events.length) return send(res, 401, { error: 'signed_out' });
      return send(res, 200, { email, role: u ? u.role : null, events });
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
      const [role, events] = await Promise.all([H.roleFor(email), E.eventsFor(email)]);
      if (!role && !events.length) return send(res, 403, { error: 'not_authorized' });   // same answer for any non-listed account
      H.setSession(req, res, email);
      return send(res, 200, { email, role, events });
    }

    // ---- everything else needs a signed-in staff member
    // With ?ev=... the role comes from that event's sheet (its owner and its Staff tab); without, from the old allowlists.
    const evGiven = req.query && req.query.ev != null && req.query.ev !== '';
    const ev = evGiven ? E.normEv(req.query.ev) : null;
    let user, getStore;
    if (evGiven) {
      const email = H.sessionEmail(req);
      if (!email) return send(res, 401, { error: 'signed_out' });
      if (!ev || !E.redis()) return send(res, 404, { error: 'unknown_event' });
      const role = await E.roleFor(email, ev);
      if (!role) return send(res, 403, { error: 'not_authorized' });
      user = { email, role };
      getStore = () => E.storeFor(ev);
    } else {
      user = await H.currentUser(req);
      if (!user) return send(res, 401, { error: 'signed_out' });
      getStore = H.getStore;
    }

    if (action === 'lookup') {
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const store = getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      housekeeping(store);
      if (store.fast) return send(res, 200, id ? await store.lookup(id) : { found: false });
      const byId = await H.getRoster(store);
      const t = id ? byId.get(id) : null;
      return send(res, 200, t ? { found: true, name: t.name, checkedIn: !!t.checkedIn, agreed: t.agreed !== false, npl: t.npl === true } : { found: false });
    }

    if (action === 'checkin') {
      if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
      const store = getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      if (id.length < 3 || id.length > 12) return send(res, 200, { result: 'no_ticket' });
      housekeeping(store);
      // agreementConfirmed: the helper tapped "Dance Agreement completed" on the yellow screen
      // nplConfirmed: the helper tapped "Admin approved - Check in anyway" on the red NPL screen
      const confirmed = (req.body || {}).agreementConfirmed === true, nplConfirmed = (req.body || {}).nplConfirmed === true;
      if (store.fast) return send(res, 200, await store.checkin(id, user.email, { agreementConfirmed: confirmed, nplConfirmed }));   // atomic, a few ms
      // Instant "no ticket": if our recent copy of the roster doesn't have this ID, don't bother the sheet.
      // (We never answer "already checked in" from the copy: the sheet decides that, so an undo is never missed.)
      if (H.rosterAgeMs() < 90 * 1000) {
        try {
          const byId = await H.getRoster(store), t = byId.get(id);
          if (!t) return send(res, 200, { result: 'no_ticket' });
          if (t.npl === true && !t.checkedIn && !nplConfirmed) return send(res, 200, { result: 'npl', name: t.name });   // on the school's NPL list
          if (t.agreed === false && !t.checkedIn && !confirmed) return send(res, 200, { result: 'no_agreement', name: t.name });   // dance agreement not signed
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
      const store = getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      const id = H.normId((req.body || {}).id);
      if (id.length < 3 || id.length > 12) return send(res, 200, { result: 'no_ticket' });
      const r = await store.uncheckin(id, user.email);
      if (r.result === 'ok') H.rosterApply(id, { checkedIn: false, at: null });
      return send(res, 200, r);
    }

    if (action === 'tickets') {
      if (user.role !== 'admin') return send(res, 403, { error: 'admin_only' });
      const store = getStore();
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
      const store = getStore();
      if (!store) return send(res, 503, { error: 'not_connected' });
      if (!store.fast) return send(res, 200, { store: 'sheet', note: 'fast database not set up yet' });
      if (action === 'sync') {
        if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
        return send(res, 200, await store.sync());
      }
      return send(res, 200, await store.status());
    }

    // ---- the organizer page (/tickets): one event, admins only
    if (action === 'event' || action === 'design' || action === 'samplepass') {
      if (!ev) return send(res, 404, { error: 'unknown_event' });
      if (user.role !== 'admin') return send(res, 403, { error: 'admin_only' });
      const cfg = await E.getCfg(ev, true);

      if (action === 'event') {
        const [st, design, art] = await Promise.all([E.storeFor(ev).status(), E.getDesign(ev), E.getArt(ev)]);
        const big = art['background@2x.png'] || art['strip@2x.png'] || null;
        return send(res, 200, {
          ev, settings: cfg.settings, sheetUrl: cfg.sheet ? cfg.sheet.url : '', owner: cfg.owner || '', staff: (cfg.staff || []).length,
          tickets: st.tickets, checkedIn: st.checkedIn, pending: st.pending, emailed: cfg.emailed || 0, autoSend: cfg.autoSend === true,
          sheetSeenAt: cfg.updatedAt, design, art: big ? 'data:image/png;base64,' + big.toString('base64') : null,
          wallet: P.available(), walletExpires: P.expires(),
        });
      }

      if (action === 'design') {
        if (!isPost || req.headers['x-requested-with'] !== 'hoco') return send(res, 400, { error: 'bad_request' });
        const b = req.body || {};
        try { return send(res, 200, { design: await E.saveDesign(ev, b.design || {}, b.art || null) }); }
        catch (e) { return send(res, 400, { error: 'bad_design', message: String(e.message) }); }
      }

      // a real, signed pass of this event with made-up details, to check the look on a phone before any email goes out
      if (!P.available()) return send(res, 503, { error: 'wallet_off' });
      const [design, art] = await Promise.all([E.getDesign(ev), E.getArt(ev)]);
      const bytes = P.build(ev, cfg.settings, design, art, { id: '000000', name: 'Sample Student', no: '1', guest: '' });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'inline; filename="sample_ticket.pkpass"');
      return res.status(200).send(bytes);
    }

    return send(res, 404, { error: 'unknown_action' });
  } catch (err) {
    console.error('hoco', action, err.message);
    return send(res, 500, { error: 'server_error' });
  }
};
