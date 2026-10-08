// Personal ticket links: https://sequoiaasb.org/t/<student id>-<mac>
// The mac is an HMAC of the student id, so links can't be guessed or made up for other students.
const crypto = require('crypto');

function secret() {
  const s = process.env.PASS_LINK_SECRET;
  if (!s || s.length < 24) throw new Error('PASS_LINK_SECRET is not set');
  return s;
}
const mac = (id) => crypto.createHmac('sha256', secret()).update('pass:' + id).digest('base64url').slice(0, 16);
const code = (id) => id + '-' + mac(id);

// returns the student id if the code is genuine, otherwise null
function verify(c) {
  const m = /^(\d{5,8})-([A-Za-z0-9_-]{16})$/.exec(String(c || ''));
  if (!m) return null;
  const a = Buffer.from(m[2]), b = Buffer.from(mac(m[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}

module.exports = { mac, code, verify };
