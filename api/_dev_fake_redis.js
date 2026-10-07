// In-memory stand-in for the Redis client, used ONLY for local development and automated tests.
// Implements just the commands the check-in store uses, with Redis's semantics (hsetnx is atomic, set NX/EX, etc).
function fakeRedis(latencyMs = 0) {
  const h = new Map(), s = new Map(), l = new Map(), str = new Map(), exp = new Map();
  const wait = () => (latencyMs ? new Promise((r) => setTimeout(r, latencyMs)) : Promise.resolve());
  const alive = (k) => { if (exp.has(k) && exp.get(k) < Date.now()) { str.delete(k); exp.delete(k); } return str.has(k); };
  const H = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
  const S = (k) => { if (!s.has(k)) s.set(k, new Set()); return s.get(k); };
  const L = (k) => { if (!l.has(k)) l.set(k, []); return l.get(k); };
  const api = {
    calls: 0,
    async set(k, v, o = {}) { await wait(); api.calls++; if (o.nx && alive(k)) return null; str.set(k, v); if (o.ex) exp.set(k, Date.now() + o.ex * 1000); return 'OK'; },
    async get(k) { await wait(); api.calls++; return alive(k) ? str.get(k) : null; },
    async exists(k) { await wait(); api.calls++; return alive(k) || h.has(k) || s.has(k) || l.has(k) ? 1 : 0; },
    async del(...ks) { await wait(); api.calls++; let n = 0; ks.forEach((k) => { if (str.delete(k) | h.delete(k) | s.delete(k) | l.delete(k)) n++; exp.delete(k); }); return n; },
    async rename(a, b) { await wait(); api.calls++; if (h.has(a)) { h.set(b, h.get(a)); h.delete(a); } return 'OK'; },
    async hget(k, f) { await wait(); api.calls++; const m = h.get(k); return m && m.has(f) ? m.get(f) : null; },
    async hset(k, o) { await wait(); api.calls++; let n = 0; const m = H(k); Object.keys(o).forEach((f) => { if (!m.has(f)) n++; m.set(f, String(o[f])); }); return n; },
    async hsetnx(k, f, v) { await wait(); api.calls++; const m = H(k); if (m.has(f)) return 0; m.set(f, String(v)); return 1; },
    async hdel(k, ...fs) { await wait(); api.calls++; const m = h.get(k); let n = 0; fs.forEach((f) => { if (m && m.delete(f)) n++; }); return n; },
    async hlen(k) { await wait(); api.calls++; const m = h.get(k); return m ? m.size : 0; },
    async hgetall(k) { await wait(); api.calls++; const m = h.get(k); return m && m.size ? Object.fromEntries(m) : null; },
    async sadd(k, ...ms) { await wait(); api.calls++; const st = S(k); let n = 0; ms.forEach((m) => { if (!st.has(m)) { st.add(m); n++; } }); return n; },
    async srem(k, ...ms) { await wait(); api.calls++; const st = s.get(k); let n = 0; ms.forEach((m) => { if (st && st.delete(m)) n++; }); return n; },
    async smembers(k) { await wait(); api.calls++; return s.has(k) ? Array.from(s.get(k)) : []; },
    async scard(k) { await wait(); api.calls++; return s.has(k) ? s.get(k).size : 0; },
    async rpush(k, ...vs) { await wait(); api.calls++; const a = L(k); vs.forEach((v) => a.push(String(v))); return a.length; },
    async llen(k) { await wait(); api.calls++; return l.has(k) ? l.get(k).length : 0; },
    async lrange(k, a, b) { await wait(); api.calls++; const x = l.get(k) || []; return x.slice(a, b < 0 ? x.length + b + 1 : b + 1); },
    async ltrim(k, a, b) { await wait(); api.calls++; const x = l.get(k) || []; l.set(k, x.slice(a, b < 0 ? x.length + b + 1 : b + 1)); return 'OK'; },
  };
  return api;
}
module.exports = { fakeRedis };
