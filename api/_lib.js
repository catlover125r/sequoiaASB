// Shared config + helpers for the homecoming ticket endpoints.
// Files starting with "_" in /api are not exposed as routes by Vercel.
const Stripe = require('stripe');

const CONFIG = {
  event: 'homecoming-2026',
  name: 'Homecoming Dance Ticket',
  priceCents: 4000, // $40.00
  currency: 'usd',
  capacity: 1000,
  maxPerOrder: 2,
};

// Hosts we are willing to send the buyer back to after checkout.
const ALLOWED_HOSTS = ['sequoiaasb.org', 'www.sequoiaasb.org', 'sequoiaasb.vercel.app'];

function stripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return new Stripe(key);
}

function isTestMode() {
  return (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_');
}

function siteOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (ALLOWED_HOSTS.includes(host)) return 'https://' + host;
  if (host.startsWith('localhost:') || host === 'localhost') return 'http://' + host;
  return 'https://sequoiaasb.org';
}

// Tickets sold = sum of `quantity` over succeeded, not fully refunded payments
// for this event. (Stripe's search index can lag by up to ~1 minute.)
async function ticketsSold(s) {
  let sold = 0;
  let page;
  do {
    const r = await s.paymentIntents.search({
      query: `status:'succeeded' AND metadata['event']:'${CONFIG.event}'`,
      limit: 100,
      page,
    });
    for (const pi of r.data) {
      if (pi.amount_refunded >= pi.amount) continue;
      sold += Number(pi.metadata.quantity || 1);
    }
    page = r.has_more ? r.next_page : undefined;
  } while (page);
  return sold;
}

module.exports = { CONFIG, stripe, isTestMode, siteOrigin, ticketsSold };
