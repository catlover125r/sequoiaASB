const { CONFIG, stripe, siteOrigin, ticketsSold } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const qty = Math.floor(Number((req.body || {}).quantity || 1));
    if (!(qty >= 1 && qty <= CONFIG.maxPerOrder)) {
      return res.status(400).json({ error: 'bad_quantity' });
    }

    const s = stripe();
    const sold = await ticketsSold(s);
    if (sold + qty > CONFIG.capacity) {
      return res.status(409).json({ error: 'sold_out', remaining: Math.max(0, CONFIG.capacity - sold) });
    }

    const origin = siteOrigin(req);
    const meta = { event: CONFIG.event, quantity: String(qty) };
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: qty,
        price_data: {
          currency: CONFIG.currency,
          unit_amount: CONFIG.priceCents,
          product_data: { name: CONFIG.name },
        },
      }],
      custom_fields: [
        { key: 'student_name', label: { type: 'custom', custom: 'Student full name' }, type: 'text',
          text: { minimum_length: 2, maximum_length: 80 } },
        { key: 'student_id', label: { type: 'custom', custom: 'Student ID number' }, type: 'numeric',
          numeric: { minimum_length: 5, maximum_length: 8 } },
        { key: 'grade', label: { type: 'custom', custom: 'Grade' }, type: 'dropdown',
          dropdown: { options: [
            { label: '9th', value: '9' }, { label: '10th', value: '10' },
            { label: '11th', value: '11' }, { label: '12th', value: '12' },
          ] } },
      ],
      metadata: meta,
      payment_intent_data: { metadata: meta, description: `${CONFIG.name} x${qty}` },
      success_url: `${origin}/homecoming-tickets/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/homecoming-tickets`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout error', err.message);
    return res.status(500).json({ error: 'server_error' });
  }
};
