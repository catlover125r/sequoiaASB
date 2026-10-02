const { CONFIG, stripe, isTestMode, ticketsSold } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const sold = await ticketsSold(stripe());
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
    res.status(200).json({
      remaining: Math.max(0, CONFIG.capacity - sold),
      priceCents: CONFIG.priceCents,
      maxPerOrder: CONFIG.maxPerOrder,
      testMode: isTestMode(),
    });
  } catch (err) {
    console.error('status error', err.message);
    res.status(500).json({ error: 'server_error' });
  }
};
