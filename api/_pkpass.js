// Builds and signs one Apple Wallet ticket (.pkpass) at the moment a student opens their link.
// Nothing is made in advance or stored: a late buyer, a corrected name or a new ticket design simply shows up
// the next time the link is opened.
//
// Signing needs the private key of the Pass Type ID certificate in the Vercel variable PASS_SIGNING_KEY
// (the PEM text, or the PEM text base64-encoded). Without it, or once the certificate has expired, available()
// says so and the ticket link shows the barcode page instead, which works on every phone.
//
// Files starting with "_" in /api are not exposed as routes by Vercel.
const crypto = require('crypto');
const zlib = require('zlib');
const A = require('./_pass_assets');

// ------------------------------------------------------------------ certificate + key
let signer;      // undefined = not looked at yet; null = not usable
function pem(name) {
  let v = String(process.env[name] || '').trim();
  if (!v) return '';
  if (v.indexOf('-----BEGIN') < 0) { try { v = Buffer.from(v, 'base64').toString('utf8').trim(); } catch (e) { return ''; } }
  return v.replace(/\\n/g, '\n');
}
function loadSigner() {
  if (signer !== undefined) return signer;
  signer = null;
  try {
    const keyPem = pem('PASS_SIGNING_KEY');
    if (!keyPem) return signer;
    const forge = require('node-forge');
    const cert = forge.pki.certificateFromPem(pem('PASS_CERT_PEM') || A.CERT);
    const wwdr = forge.pki.certificateFromPem(pem('PASS_WWDR_PEM') || A.WWDR);
    const key = forge.pki.privateKeyFromPem(keyPem);
    const field = (oid) => { const f = cert.subject.attributes.find((a) => a.type === oid); return f ? String(f.value) : ''; };
    const passTypeId = field('0.9.2342.19200300.100.1.1'), teamId = field('2.5.4.11');     // UID, OU
    if (!passTypeId || !teamId) throw new Error('the certificate is not a Pass Type ID certificate');
    if (cert.publicKey.n.compareTo(key.n) !== 0) throw new Error('PASS_SIGNING_KEY does not belong to the certificate');
    signer = { forge, cert, wwdr, key, passTypeId, teamId, notAfter: cert.validity.notAfter };
  } catch (e) {
    console.error('pass signing is off:', e && e.message);
    signer = null;
  }
  return signer;
}
/** Can we hand out Wallet passes right now? */
function available() {
  const s = loadSigner();
  return !!s && s.notAfter.getTime() > Date.now();
}
/** For the organizer page: when the certificate stops working (ISO), or null when signing is not set up. */
function expires() {
  const s = loadSigner();
  return s ? s.notAfter.toISOString() : null;
}
function _reset() { signer = undefined; }

function signature(manifest) {
  const s = loadSigner(), forge = s.forge;
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(s.cert);
  p7.addCertificate(s.wwdr);
  p7.addSigner({
    key: s.key, certificate: s.cert, digestAlgorithm: forge.pki.oids.sha1,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

// ------------------------------------------------------------------ a small zip writer (a .pkpass is a zip)
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  Object.keys(files).sort().forEach((name) => {
    const data = files[name], nameBuf = Buffer.from(name, 'utf8'), crc = crc32(data);
    const png = /\.png$/.test(name);                              // already compressed: store as is
    const body = png ? data : zlib.deflateRawSync(data), method = png ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);    // time 00:00, date 1980-01-01
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, body);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  });
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22), n = central.length / 2;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ------------------------------------------------------------------ the pass
const rgb = (hex) => { const n = parseInt(String(hex).slice(1), 16); return 'rgb(' + (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ')'; };

/**
 * ev       event code
 * settings {name, tagline, taglineLabel, when, startsAt, place, org}       from the sheet's Settings tab
 * design   {style: 'plain'|'background'|'banner', bg, fg, label, title}     from /tickets
 * art      {fileName: Buffer}                                               from /tickets
 * ticket   {id, name, no, guest}
 */
function passJson(ev, settings, design, ticket) {
  const s = loadSigner();
  const aux = [{ key: 'id', label: 'ID #', value: ticket.id }];
  if (ticket.no) aux.push({ key: 'ticket', label: 'TICKET #', value: String(ticket.no) });
  if (ticket.name) aux.push({ key: 'student', label: 'STUDENT', value: ticket.name, textAlignment: 'PKTextAlignmentRight' });
  const secondary = [];
  if (settings.tagline) secondary.push({ key: 'theme', label: (settings.taglineLabel || 'Theme').toUpperCase(), value: settings.tagline });
  if (settings.when) secondary.push({ key: 'when', label: 'WHEN', value: settings.when, ...(secondary.length ? { textAlignment: 'PKTextAlignmentRight' } : {}) });
  const back = [];
  if (settings.when) back.push({ key: 'bwhen', label: 'When', value: settings.when });
  if (settings.place) back.push({ key: 'bplace', label: 'Where', value: settings.place });
  if (ticket.guest) back.push({ key: 'bguest', label: 'Guest', value: ticket.guest });
  back.push({ key: 'babout', label: 'About this ticket', value: 'Show this barcode at the door. This ticket is personal to you and can be scanned in once.' + (settings.contact ? ' Questions: ' + settings.contact : '') });
  const fields = { secondaryFields: secondary, auxiliaryFields: aux, backFields: back };
  // A banner already carries the event's name as artwork; everywhere else the name is the big line on the ticket.
  if (design.style !== 'banner' || design.title) fields.primaryFields = [{ key: 'event', label: '', value: settings.name }];
  const json = {
    formatVersion: 1,
    passTypeIdentifier: s.passTypeId,
    teamIdentifier: s.teamId,
    organizationName: settings.org,
    description: settings.name + ' ticket',
    serialNumber: ev + '-' + ticket.id,
    backgroundColor: rgb(design.bg), foregroundColor: rgb(design.fg), labelColor: rgb(design.label),
    logoText: settings.org,
    eventTicket: fields,
    barcodes: [{ format: 'PKBarcodeFormatCode128', message: ticket.id, altText: ticket.id, messageEncoding: 'iso-8859-1' }],
  };
  if (settings.startsAt) json.relevantDate = settings.startsAt.replace(/\.\d{3}Z$/, 'Z');     // the phone offers the ticket on the lock screen around this time
  return json;
}

/** Returns the signed .pkpass as a Buffer. Throws if signing isn't available (check available() first). */
function build(ev, settings, design, art, ticket) {
  if (!available()) throw new Error('pass signing is not available');
  const files = {};
  Object.keys(A.IMAGES).forEach((f) => { files[f] = Buffer.from(A.IMAGES[f], 'base64'); });
  const want = design.style === 'background' ? /^background/ : design.style === 'banner' ? /^strip/ : null;
  let style = design.style;
  if (want) {
    const mine = Object.keys(art || {}).filter((f) => want.test(f));
    if (mine.length) mine.forEach((f) => { files[f] = art[f]; });
    else style = 'plain';                                         // the art is missing: still a good ticket, in plain colors
  }
  files['pass.json'] = Buffer.from(JSON.stringify(passJson(ev, settings, { ...design, style }, ticket), null, 2));
  const manifest = {};
  Object.keys(files).sort().forEach((f) => { manifest[f] = crypto.createHash('sha1').update(files[f]).digest('hex'); });
  files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
  files.signature = signature(files['manifest.json']);
  return zip(files);
}

module.exports = { available, expires, build, passJson, zip, _reset };
