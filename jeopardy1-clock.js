// Server clock for the Jeopardy pages. Keeps the sample with the shortest round trip, which has the least network noise.
window.JClock = (() => {
  const samples = [];
  let offset = 0;
  async function sample() {
    try {
      const w0 = Date.now(), p0 = performance.now();
      const r = await fetch('/api/jeopardy/time', { cache: 'no-store' });
      const { t } = await r.json();
      const rtt = performance.now() - p0;
      samples.push({ rtt, off: t - (w0 + rtt / 2) });
      if (samples.length > 8) samples.shift();
      offset = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
    } catch (e) {}
  }
  (async () => { for (let i = 0; i < 5; i++) await sample(); setInterval(sample, 15000); })();
  return { now: () => Date.now() + offset };
})();
