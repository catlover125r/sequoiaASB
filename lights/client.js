// HOCO Flashlights: browser helpers shared by /hocoflights and /hocoflightscontrol.
//   HocoClient.now()            server time in ms (synced, typically within a few tens of ms)
//   HocoClient.syncClock(n)     take n clock samples
//   HocoClient.sample(promiseFn) time a request that returns { t: server ms } and keep it as a clock sample
//   HocoClient.watchState(cb)   poll /api/lights/state every 2 s, cb(state) when it changes
//   HocoClient.api(action, body, headers)
(function () {
  'use strict';
  var samples = [];   // { rtt, off, at }
  var offset = Date.now() - performance.now();   // until the first sample: trust the phone's own clock

  function now() { return performance.now() + offset; }

  function addSample(t0, t1, serverT) {
    if (typeof serverT !== 'number') return;
    samples.push({ rtt: t1 - t0, off: serverT - (t0 + t1) / 2, at: t1 });
    if (samples.length > 12) samples.shift();
    // the quickest round trip has the least room for error
    var best = null;
    samples.forEach(function (s) { if (t1 - s.at < 5 * 60 * 1000 && (!best || s.rtt < best.rtt)) best = s; });
    if (best) offset = best.off;
  }

  function api(action, body, headers) {
    var opt = { cache: 'no-store', headers: Object.assign({}, headers || {}) };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch('/api/lights/' + action, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  // time any request whose answer carries the server clock as `t`
  function sample(fn) {
    var t0 = performance.now();
    return fn().then(function (j) { addSample(t0, performance.now(), j && j.t); return j; });
  }

  function syncClock(n) {
    var i = 0;
    function one() {
      return sample(function () { return api('time'); }).catch(function () {}).then(function () {
        if (++i < (n || 5)) return one();
      });
    }
    return one();
  }

  function watchState(cb, everyMs) {
    var last = '', timer = null, stopped = false;
    function poll() {
      clearTimeout(timer);
      if (stopped) return;
      if (document.hidden) { timer = setTimeout(poll, everyMs || 2000); return; }
      api('state').then(function (s) {
        delete s.t;
        var key = JSON.stringify(s);
        if (key !== last) { last = key; cb(s); }
      }).catch(function () {}).then(function () {
        if (!stopped) timer = setTimeout(poll, everyMs || 2000);
      });
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
    poll();
    return { now: poll, stop: function () { stopped = true; clearTimeout(timer); } };
  }

  window.HocoClient = { now: now, syncClock: syncClock, sample: sample, watchState: watchState, api: api, rtt: function () {
    var best = null; samples.forEach(function (s) { if (!best || s.rtt < best.rtt) best = s; }); return best ? best.rtt : null;
  } };
})();
