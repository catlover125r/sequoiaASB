// Personal ticket link, rewritten to /api/ticket?c=...  in vercel.json. Two kinds:
//   /t/<event code>.<student id>-<mac>   every event run from a ticket sheet (see _events.js). The Wallet pass is
//                                        built and signed right here when the link is opened (see _pkpass.js).
//   /t/<student id>-<mac>                Ravenchella 2026 only: passes that were made in advance (below).
//  * iPhone/iPad: serves the signed Apple Wallet pass, so Safari shows "Add to Wallet".
//  * Anything else: a page with the student's barcode (screenshot it) and a link to the pass.
// The passes live in Redis (see _passstore.js), with the old private Vercel Blob store (passes/<id>.pkpass and
// passes/<id>.json) as a fallback; they are only ever handed out by this function, and only for a code whose HMAC checks out.
const { get } = require('@vercel/blob');
const { getPass } = require('./_passstore');
const { verify } = require('./_passlink');
const { svg } = require('./_code128');
const E = require('./_events');
const P = require('./_pkpass');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function blobBytes(pathname) {
  const r = await get(pathname, { access: 'private' });
  if (!r || !r.stream) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

function page(inner, status, title) {
  return {
    status,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title || 'Ravenchella Ticket')}</title><link rel="icon" href="/favicon-32.png">
<style>
:root{color-scheme:light}
body{margin:0;background:#f3eef7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#2b1238}
main{max-width:420px;margin:0 auto;padding:24px 16px 40px;text-align:center}
.card{background:#fff;border-radius:18px;padding:22px 16px;box-shadow:0 2px 14px rgba(60,20,90,.12)}
img.seal{width:64px;height:64px}
h1{font-size:22px;margin:10px 0 2px}
.sub{color:#6b5a78;font-size:14px;margin:0 0 18px}
.name{font-size:20px;font-weight:700;margin:14px 0 0}
.num{color:#6b5a78;font-size:15px;margin:2px 0}
.num+.bc,.num+.num+.bc{margin-top:14px}
.bc{background:#fff;border:1px solid #e6dcee;border-radius:10px;padding:10px 4px}
.bc svg{width:100%;height:auto;max-height:140px;display:block}
.id{font-size:26px;letter-spacing:3px;font-weight:700;margin:8px 0 0}
p.note{font-size:14px;line-height:1.45;color:#4b3a58;margin:16px 4px 0}
a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:10px;background:#4a0d67;color:#fff;text-decoration:none;font-weight:600}
</style></head><body><main>${inner}</main></body></html>`,
  };
}

const BAD_LINK = '<div class="card"><h1>Link not recognized</h1><p class="note">This ticket link isn\'t valid. Please open the link from your ticket email again, or ask a member of ASB for help.</p></div>';

// A ticket of an event that is run from a ticket sheet.
async function eventTicket(req, res, send, code, link) {
  const cfg = E.redis() ? await E.getCfg(link.ev) : null;
  if (!cfg) return send(page(BAD_LINK, 404, 'Ticket'));
  const s = cfg.settings, t = await E.storeFor(link.ev).entry(link.id);
  if (!t) {
    return send(page(`<div class="card"><img class="seal" src="/icon-192.png" alt=""><h1>${esc(s.name)}</h1><p class="note">This ticket is not on the ticket list any more. If you think that is a mistake, ask a member of ASB.</p></div>`, 410, s.name + ' Ticket'));
  }
  const ua = String(req.headers['user-agent'] || '');
  const wallet = P.available();
  if (wallet && ((req.query && req.query.pass === '1') || /iPhone|iPad|iPod/.test(ua))) {
    const [design, art] = await Promise.all([E.getDesign(link.ev), E.getArt(link.ev)]);
    const bytes = P.build(link.ev, s, design, art, { id: link.id, name: t.name, no: t.no || '', guest: t.guest || '' });
    res.status(200);
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `inline; filename="ticket_${link.id}.pkpass"`);
    return res.send(bytes);
  }
  const sub = [s.org, s.tagline].filter(Boolean).join(' · ');
  const details = [s.when, s.place].filter(Boolean).join(' · ');
  const inner = `<div class="card">
<img class="seal" src="/icon-192.png" alt="">
<h1>${esc(s.name)}</h1><p class="sub">${esc(sub)}</p>
${details ? `<p class="num" style="margin-bottom:10px"><strong>${esc(details)}</strong></p>` : ''}
${t.name ? `<p class="name">${esc(t.name)}</p>` : ''}<p class="num">ID #${esc(link.id)}</p>${t.no ? `<p class="num">Ticket #${esc(t.no)}</p>` : ''}
<div class="bc">${svg(link.id)}</div><div class="id">${esc(link.id)}</div>
<p class="note">Show this barcode at the door. Take a screenshot so you have it even without service, and turn your screen brightness up when you scan.</p>
${wallet ? `<a class="btn" href="/t/${esc(code)}?pass=1">Download Apple Wallet pass</a>` : ''}
<p class="note" style="font-size:12px">This ticket is personal to you. Each ticket can be scanned in once.</p>
</div>`;
  return send(page(inner, 200, s.name + ' Ticket'));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const send = (p) => { res.status(p.status).setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(p.html); };
  try {
    const code = (req.query && req.query.c) || '';
    const link = E.verifyLink(code);
    if (link) return await eventTicket(req, res, send, code, link);
    const id = verify(code);
    if (!id) return send(page(BAD_LINK, 404));

    const ua = String(req.headers['user-agent'] || '');
    const wantsPass = (req.query && req.query.pass === '1') || /iPhone|iPad|iPod/.test(ua);
    let stored = { bytes: null, info: null };
    try { stored = await getPass(id, { wantBytes: wantsPass }); } catch (e) { console.error('pass store:', e && e.message); }
    if (wantsPass) {
      let bytes = stored.bytes;
      if (!bytes) { try { bytes = await blobBytes(`passes/${id}.pkpass`); } catch (e) { console.error('blob:', e && e.message); } }
      if (bytes) {
        res.status(200);
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Content-Disposition', `inline; filename="ravenchella_${id}.pkpass"`);
        return res.send(bytes);
      }
    }

    let name = '', ticketNo = '';
    try {
      let info = stored.info;
      if (!info) { const j = await blobBytes(`passes/${id}.json`); if (j) info = JSON.parse(j.toString()); }
      if (info) { name = String(info.name || ''); ticketNo = String(info.ticketNo || ''); }
    } catch (e) { /* the name is optional */ }
    const inner = `<div class="card">
<img class="seal" src="/icon-192.png" alt="">
<h1>Ravenchella</h1><p class="sub">Sequoia Homecoming · Bringing Back 2016</p>
${name ? `<p class="name">${esc(name)}</p>` : ''}<p class="num">ID #${esc(id)}</p>${ticketNo ? `<p class="num">Ticket #${esc(ticketNo)}</p>` : ''}
<div class="bc">${svg(id)}</div><div class="id">${esc(id)}</div>
<p class="note">Show this barcode at the door. Take a screenshot so you have it even without service, and turn your screen brightness up when you scan.</p>
<a class="btn" href="/t/${esc(code)}?pass=1">Download Apple Wallet pass</a>
<p class="note" style="font-size:12px">This ticket is personal to you. Each ticket can be scanned in once.</p>
</div>`;
    return send(page(inner, 200));
  } catch (e) {
    console.error('ticket error:', e && e.message);
    return send(page('<div class="card"><h1>Something went wrong</h1><p class="note">Please try again in a moment, or ask a member of ASB for help.</p></div>', 500));
  }
};
