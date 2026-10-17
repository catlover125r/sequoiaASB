// Where the Wallet passes live. They are stored in Redis (the same Upstash database the check-in app uses):
//   ravenchella:pass:bin:<student id>   the signed .pkpass, base64
//   ravenchella:pass:info:<student id>  {"name": "...", "ticketNo": "..."}
// (They used to be in a private Vercel Blob store; its free tier ran out, so ticket.js falls back to Blob only if Redis has nothing.)
// Only ticket.js reads this, and only for a link whose HMAC checks out.
const PREFIX = 'ravenchella:pass:';
let client;

function redis() {
  if (client !== undefined) return client;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { client = null; return client; }
  const { Redis } = require('@upstash/redis');
  client = new Redis({ url, token, automaticDeserialization: false });
  return client;
}

/** @returns {Promise<{bytes: Buffer|null, info: {name?: string, ticketNo?: string}|null}>} */
async function getPass(id, { wantBytes }) {
  const r = redis();
  if (!r) return { bytes: null, info: null };
  const [bin, info] = await Promise.all([wantBytes ? r.get(PREFIX + 'bin:' + id) : null, r.get(PREFIX + 'info:' + id)]);
  let parsed = null;
  try { parsed = info ? JSON.parse(info) : null; } catch (e) { /* the name is optional */ }
  return { bytes: bin ? Buffer.from(String(bin), 'base64') : null, info: parsed };
}

module.exports = { getPass, PREFIX };
