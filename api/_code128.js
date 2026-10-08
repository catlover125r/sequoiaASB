// Minimal Code 128 encoder -> SVG (code set C for even-length digit strings such as student IDs, otherwise set B).
const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 ' +
  '123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 ' +
  '111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 ' +
  '141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 ' +
  '124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 ' +
  '311141 411131 211412 211214 211232 2331112').split(' ');

function values(text) {
  const s = String(text);
  if (!s.length) throw new Error('empty barcode text');
  const v = [];
  if (/^\d+$/.test(s) && s.length % 2 === 0) {
    v.push(105);
    for (let i = 0; i < s.length; i += 2) v.push(Number(s.slice(i, i + 2)));
  } else {
    v.push(104);
    for (const ch of s) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) throw new Error('unsupported character'); v.push(c - 32); }
  }
  let sum = v[0];
  for (let i = 1; i < v.length; i++) sum += i * v[i];
  v.push(sum % 103, 106);
  return v;
}

// alternating bar/space widths in modules, starting with a bar
function runs(text) {
  const out = [];
  values(text).forEach((val) => { for (const d of P[val]) out.push(Number(d)); });
  return out;
}

function svg(text, { module = 3, height = 110, quiet = 10 } = {}) {
  const r = runs(text);
  const total = r.reduce((a, b) => a + b, 0) + quiet * 2;
  let x = quiet, bar = true, rects = '';
  for (const w of r) { if (bar) rects += `<rect x="${x}" y="0" width="${w}" height="${height / module}"/>`; x += w; bar = !bar; }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height / module}" width="${total * module}" height="${height}" role="img" aria-label="Barcode ${String(text).replace(/[^0-9A-Za-z ]/g, '')}" shape-rendering="crispEdges"><rect width="${total}" height="${height / module}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

module.exports = { runs, svg };
