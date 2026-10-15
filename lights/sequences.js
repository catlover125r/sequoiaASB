// HOCO Flashlights: the light shows. Shared by the phone page (/hocoflights), the control page
// (/hocoflightscontrol, for its live preview) and the tests, so the preview is exactly what phones do.
//
// Every phone runs the same math on the same (server-synced) clock, so nothing has to be sent while a show runs:
//   on = HocoLights.lightAt(state, serverNowMs, me)
// state : { mode: 'off'|'on'|'split'|'seq', seq: '<id>', at: <server ms it starts>, prev: <the state before it> }
// me    : { n: join number (1, 2, 3...), x: 0..19 across (left to right on the diagram), y: 0..9 row (0 = front, by the field) }
(function (root) {
  'use strict';
  // The student section has 10 rows; how many people fit across is unknown, so it is split into 20 spots.
  // On the map the rows are spaced as if there were 12, leaving the very front and back strips unused,
  // which makes a spot about as tall as it is wide (so circles look like circles).
  var COLS = 20, ROWS = 10;
  var CX = (COLS - 1) / 2, CY = (ROWS - 1) / 2;   // centre of the section (9.5, 4.5)
  var MAXD = Math.sqrt(CX * CX + CY * CY);         // centre to a corner

  // A stable "random" number in [0, 1) for any pair of integers (no Math.random: every phone must agree).
  function rnd(a, b) {
    var h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function mod(a, m) { return ((a % m) + m) % m; }
  // blink: on for the first `onMs` of every `periodMs`
  function blink(t, periodMs, onMs) { return mod(t, periodMs) < (onMs == null ? periodMs / 2 : onMs); }
  // Moving shapes are drawn in steps of TICK ms, so no phone ever gets a flash shorter than that
  // (a flashlight takes ~0.1 s to switch, a shorter blip would just look like a glitch).
  var TICK = 150;
  function tick(t) { return Math.floor(t / TICK) * TICK; }
  var odd = function (p) { return p.n % 2 === 1; };

  // Split a sequence into back-to-back parts: [[lengthMs, fn(localT, p, partLength)], ...]
  function parts(list) {
    var total = 0;
    list.forEach(function (s) { total += s[0]; });
    function f(t, p) {
      t = mod(t, total);
      for (var i = 0; i < list.length; i++) {
        if (t < list[i][0]) return !!list[i][1](t, p, list[i][0]);
        t -= list[i][0];
      }
      return false;
    }
    return { dur: total, f: f };
  }
  var ON = function () { return true; }, OFF = function () { return false; };

  // ------------------------------------------------------------------ sequences that work anywhere
  var heartbeat = parts([
    [8000, function (t) { return blink(t, 2000); }],                                   // slow: 1 s on, 1 s off
    [6000, function (t) { return blink(t, 1000); }],                                   // faster
    [6000, function (t) { var m = mod(t, 1500); return m < 160 || (m >= 330 && m < 490); }], // lub-dub heartbeat
    [2400, function (t) { return blink(t, 400); }],                                    // quick flashes
    [1600, ON],                                                                         // everybody on
    [800, OFF],
  ]);

  var oddEven = parts([
    [8000, function (t, p) { return blink(t, 2000) === odd(p); }],     // halves trade places every second
    [6000, function (t, p) { return blink(t, 1000) === odd(p); }],     // every half second
    [3600, function (t, p) { return blink(t, 600) === odd(p); }],      // faster
    [2000, ON],                                                          // everyone together
    [1000, OFF],
    [3000, function (t, p) { return t < 1000 ? odd(p) : t < 2000 ? !odd(p) : true; }], // odd, even, ALL
    [1000, OFF],
  ]);

  var twinkle = parts([
    // stars: every 300 ms each phone has a 1 in 4 chance of being on
    [8000, function (t, p) { return rnd(p.n, Math.floor(t / 300)) < 0.25; }],
    // count off 1-2-3-4: four groups take turns
    [6400, function (t, p) { return Math.floor(t / 400) % 4 === (p.n - 1) % 4; }],
    // the stars fill in until everyone is on
    [6000, function (t, p, L) { return t > TICK + rnd(p.n, 7777) * (L - 2 * TICK); }],
    [2000, ON],
    // and go out one by one
    [4000, function (t, p, L) { return t < TICK + rnd(p.n, 9999) * (L - 2 * TICK); }],
    [1000, OFF],
  ]);

  // ------------------------------------------------------------------ sequences that use the seat map
  function band(pos, at, width) { return Math.abs(at - pos) < width; }
  var wave = parts([
    // a band of light sweeps left -> right -> left -> right -> left (2 s per sweep)
    [8000, function (t, p) {
      var k = Math.floor(t / 2000), u = mod(t, 2000) / 2000, pos = -4 + u * (COLS + 7);
      return band(k % 2 ? COLS - 1 - pos : pos, p.x, 1.6);
    }],
    // front to back and back again (1.5 s each)
    [6000, function (t, p) {
      var k = Math.floor(t / 1500), u = mod(t, 1500) / 1500, pos = -4 + u * (ROWS + 7);
      return band(k % 2 ? ROWS - 1 - pos : pos, p.y, 1.6);
    }],
    // corner to corner diagonals
    [6000, function (t, p) {
      var span = COLS + ROWS - 2, k = Math.floor(t / 2000), u = mod(t, 2000) / 2000, pos = -5 + u * (span + 10);
      var d = k === 1 ? (COLS - 1 - p.x) + p.y : p.x + p.y;
      return band(k === 2 ? span - pos : pos, d, 2.2);
    }],
    // fill up from the left, hold, out
    [2800, function (t, p) { return p.x <= ((t - 300) / 2000) * COLS; }],
    [1500, OFF],
  ]);

  function dist(p, cx, cy) { var dx = p.x - cx, dy = p.y - cy; return Math.sqrt(dx * dx + dy * dy); }
  // ring number k = 0..lastRing passes a phone when phase is in [k * gap, k * gap + width)
  function ring(phase, gap, width, lastRing) { return phase >= 0 && Math.floor(phase / gap) <= lastRing && mod(phase, gap) < width; }
  var ripple = parts([
    // rings spread out from the middle of the section
    [10000, function (t, p) { return ring(t * 0.008 - dist(p, CX, CY), 7, 2.4, 9); }],
    // a splash from the field: rings roll from the front row to the back
    [6000, function (t, p) { return ring(t * 0.01 - dist(p, CX, -3), 8, 2.8, 4); }],
    // rings close in on the middle
    [4000, function (t, p) { return ring(t * 0.008 - (MAXD + 0.5 - dist(p, CX, CY)), 7, 2.4, 2); }],
    // a spotlight wanders around the section
    [4800, function (t, p) {
      var a = tick(t) / 4800 * Math.PI * 2;
      return dist(p, CX + Math.sin(a) * 6.5, CY + Math.sin(a * 2) * 2.5) < 3.6;
    }],
    [1200, ON],   // the whole section lights up
    [1000, OFF],
  ]);

  var checkers = parts([
    // checkerboard, flipping
    [6000, function (t, p) { return blink(t, 1500) === ((p.x + p.y) % 2 === 0); }],
    // big squares (4 across, 2 deep), flipping
    [6000, function (t, p) { return blink(t, 2000) === ((Math.floor(p.x / 5) + Math.floor(p.y / 5)) % 2 === 0); }],
    // diagonal stripes rolling across
    [6000, function (t, p) { return mod(p.x + p.y - tick(t) / TICK, 8) < 4; }],
    // left half / right half, then front half / back half
    [2000, function (t, p) { return blink(t, 1000) === (p.x < COLS / 2); }],
    [2000, function (t, p) { return blink(t, 1000) === (p.y < ROWS / 2); }],
    // a lighthouse beam spins around the middle (two beams, one turn every 3 s)
    [4500, function (t, p) {
      var a = Math.atan2(p.y - CY, p.x - CX), b = tick(t) / 3000 * Math.PI * 2;
      return Math.abs(mod(a - b, Math.PI) - Math.PI / 2) > Math.PI / 2 - 0.42 || dist(p, CX, CY) < 1.2;
    }],
    [1500, ON],
    [1000, OFF],
  ]);

  var SEQS = [
    { id: 'heartbeat', name: 'Heartbeat', seat: false, desc: 'Everyone together: slow blinks, faster, a heartbeat, quick flashes, all on.', s: heartbeat },
    { id: 'oddeven', name: 'Odd / Even', seat: false, desc: 'Half the section on, half off, trading places faster and faster, then all together.', s: oddEven },
    { id: 'twinkle', name: 'Twinkle', seat: false, desc: 'Random stars, a 1-2-3-4 count, stars filling in to all on, then going out one by one.', s: twinkle },
    { id: 'wave', name: 'The Wave', seat: true, desc: 'A band of light sweeps side to side, front to back, corner to corner, then fills up.', s: wave },
    { id: 'ripple', name: 'Ripple', seat: true, desc: 'Rings spread from the middle, roll back from the field, close in, a wandering spotlight, then everyone.', s: ripple },
    { id: 'checkers', name: 'Checkers & Stripes', seat: true, desc: 'Flipping checkerboards, rolling stripes, halves, and a spinning lighthouse beam.', s: checkers },
  ];
  SEQS.forEach(function (q) { q.dur = q.s.dur; });
  var BY_ID = {};
  SEQS.forEach(function (q) { BY_ID[q.id] = q; });

  // The state that is in effect at server time `now` (a change is announced a few seconds early, with the old one kept as `prev`).
  function activeState(state, now) {
    var s = state;
    while (s && s.at != null && now < s.at) s = s.prev;
    return s || { mode: 'off' };
  }

  // Should this phone be lit at server time `now`?
  function lightAt(state, now, p) {
    var s = activeState(state, now);
    if (s.mode === 'on') return true;
    if (s.mode === 'split') return odd(p);
    if (s.mode === 'seq' && BY_ID[s.seq]) return BY_ID[s.seq].s.f(now - (s.at || 0), p);
    return false;
  }

  function describe(s) {
    if (!s || s.mode === 'off') return 'All off';
    if (s.mode === 'on') return 'All on';
    if (s.mode === 'split') return 'Half & half (odd on, even off)';
    if (s.mode === 'seq') return BY_ID[s.seq] ? BY_ID[s.seq].name : 'Unknown show';
    return '?';
  }

  // A made-up join number for a seat, used by the control page's "full section" preview.
  function fakeN(x, y) { return 1 + Math.floor(rnd(x + 101, y + 211) * 1000); }

  var api = { COLS: COLS, ROWS: ROWS, SEQS: SEQS, BY_ID: BY_ID, lightAt: lightAt, activeState: activeState, describe: describe, fakeN: fakeN, rnd: rnd };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HocoLights = api;
})(this);
