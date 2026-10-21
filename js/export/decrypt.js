// Removes the encryption from PDFs that open without a password (the "owner password only" kind
// that only restricts printing or copying), the way lopdf does on load in the desktop app.
// pdf-lib can't decrypt, so the standard security handler is done here: RC4 40-128 bit, AES-128
// and AES-256 (revisions 2-6), with the empty user password. PDFs that need a password fail.

import {
  PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFNumber, PDFRef, PDFInvalidObject,
  PDFDocument,
} from '../../vendor/pdf-lib.esm.min.js';

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/**
 * Decrypts every string and stream of `doc` (loaded from `bytes`) and removes /Encrypt.
 * Returns the decrypted document (`doc` itself, or a new one when the file had to be read
 * again), or null when the document needs a password or uses a security handler this doesn't know.
 */
export async function decryptDocument(doc, bytes) {
  let ctx = doc.context;
  const handler = await openHandler(ctx);
  if (!handler) return null;

  // Object streams can't be parsed by pdf-lib while encrypted: it keeps them as invalid objects.
  // They're decrypted here and appended to the file as plain object streams, then the file is
  // read again so pdf-lib unpacks them. The objects inside aren't encrypted on their own.
  let packed = new Set();
  const appended = await decryptObjectStreams(ctx, handler, bytes);
  if (appended) {
    const before = new Set(ctx.enumerateIndirectObjects().map(([ref]) => ref.toString()));
    doc = await PDFDocument.load(appended, { ignoreEncryption: true, updateMetadata: false });
    ctx = doc.context;
    packed = new Set(ctx.enumerateIndirectObjects().map(([ref]) => ref.toString()).filter((r) => !before.has(r)));
  }

  const encryptRef = ctx.trailerInfo.Encrypt;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (encryptRef instanceof PDFRef && ref === encryptRef) continue;
    if (packed.has(ref.toString())) continue;
    const fixed = await decryptObject(obj, ref, handler);
    if (fixed !== obj) ctx.assign(ref, fixed);
  }
  delete ctx.trailerInfo.Encrypt;
  return doc;
}

// ------------------------------------------------------------ security handler

/** Reads /Encrypt and checks the empty user password; returns the key and methods, or null. */
async function openHandler(ctx) {
  const enc = lookupDict(ctx, ctx.trailerInfo.Encrypt);
  if (!enc) return null;
  const nameOf = (d, k) => {
    const v = d && ctx.lookup(d.get(PDFName.of(k)));
    return v instanceof PDFName ? v.asString().slice(1) : null;
  };
  const numOf = (d, k, dflt) => {
    const v = d && ctx.lookup(d.get(PDFName.of(k)));
    return v instanceof PDFNumber ? v.asNumber() : dflt;
  };
  const bytesOf = (d, k) => {
    const v = d && ctx.lookup(d.get(PDFName.of(k)));
    return v instanceof PDFString || v instanceof PDFHexString ? v.asBytes() : null;
  };
  if (nameOf(enc, 'Filter') !== 'Standard') return null;
  const V = numOf(enc, 'V', 0), R = numOf(enc, 'R', 2);
  const O = bytesOf(enc, 'O'), U = bytesOf(enc, 'U');
  if (!O || !U) return null;
  const P = numOf(enc, 'P', 0);
  const encryptMetadata = !(ctx.lookup(enc.get(PDFName.of('EncryptMetadata')))?.asBoolean?.() === false);

  // which method strings and streams use: RC4 ("V2"), AES ("AESV2"/"AESV3") or none ("Identity")
  let stm = 'V2', str = 'V2';
  if (V >= 4) {
    const cf = lookupDict(ctx, enc.get(PDFName.of('CF')));
    const method = (filter) => {
      if (!filter || filter === 'Identity') return 'Identity';
      return nameOf(lookupDict(ctx, cf?.get(PDFName.of(filter))), 'CFM') ?? 'None';
    };
    stm = method(nameOf(enc, 'StmF'));
    str = method(nameOf(enc, 'StrF'));
    if (stm === 'None') stm = 'Identity';
    if (str === 'None') str = 'Identity';
  }

  let key;
  if (R >= 5) {
    // AES-256: the file key is stored encrypted with a key made from the password
    const UE = bytesOf(enc, 'UE');
    if (!UE || U.length < 48) return null;
    const check = await hash(R, new Uint8Array(0), U.subarray(32, 40), new Uint8Array(0));
    if (!equal(check, U.subarray(0, 32))) return null;
    const ik = await hash(R, new Uint8Array(0), U.subarray(40, 48), new Uint8Array(0));
    key = await aesDecryptRaw(ik, new Uint8Array(16), UE.subarray(0, 32));
  } else {
    const length = R === 2 ? 5 : Math.max(5, Math.min(16, numOf(enc, 'Length', 40) / 8));
    const id = idBytes(ctx);
    const parts = [PAD, O.subarray(0, 32), le32(P), id];
    if (R >= 4 && !encryptMetadata) parts.push(new Uint8Array([255, 255, 255, 255]));
    let h = md5(concat(parts));
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, length));
    key = h.slice(0, length);
    // check the empty user password
    if (R === 2) {
      if (!equal(rc4(key, PAD), U.subarray(0, 32))) return null;
    } else {
      let x = rc4(key, md5(concat([PAD, id])));
      for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
      if (!equal(x, U.subarray(0, 16))) return null;
    }
  }
  return { key, R, stm, str, encryptMetadata };
}

function lookupDict(ctx, obj) {
  const d = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  return d instanceof PDFDict ? d : null;
}

function idBytes(ctx) {
  const id = ctx.trailerInfo.ID;
  const arr = id instanceof PDFRef ? ctx.lookup(id) : id;
  const first = arr instanceof PDFArray ? arr.lookup(0) : null;
  return first instanceof PDFString || first instanceof PDFHexString ? first.asBytes() : new Uint8Array(0);
}

/** Revision 5/6 password hash (ISO 32000-2, algorithm 2.B; plain SHA-256 for revision 5). */
async function hash(R, password, salt, udata) {
  let k = await sha('SHA-256', concat([password, salt, udata]));
  if (R === 5) return k;
  for (let i = 0; ; ) {
    const k1 = concat(Array(64).fill(concat([password, k, udata])));
    const e = await aesEncryptRaw(k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = await sha(['SHA-256', 'SHA-384', 'SHA-512'][sum % 3], e);
    i++;
    if (i >= 64 && e[e.length - 1] <= i - 32) break;
  }
  return k.subarray(0, 32);
}

async function sha(alg, data) {
  return new Uint8Array(await crypto.subtle.digest(alg, data));
}

// ------------------------------------------------------------ objects

/** The key for one object (RC4 and AES-128 mix in its number); AES-256 uses the file key. */
function objectKey(h, ref, aes) {
  if (h.R >= 5) return h.key;
  const n = ref.objectNumber, g = ref.generationNumber;
  const parts = [h.key, new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, g & 255, (g >> 8) & 255])];
  if (aes) parts.push(new Uint8Array([0x73, 0x41, 0x6c, 0x54])); // "sAlT"
  return md5(concat(parts)).subarray(0, Math.min(h.key.length + 5, 16));
}

async function decryptBytes(data, method, h, ref) {
  if (method === 'Identity') return data;
  if (method === 'AESV2' || method === 'AESV3') {
    if (data.length < 32 || data.length % 16 !== 0) return data.length < 16 ? new Uint8Array(0) : data;
    const key = objectKey(h, ref, true);
    try {
      return await aesDecryptPadded(key, data.subarray(0, 16), data.subarray(16));
    } catch {
      return data;
    }
  }
  return rc4(objectKey(h, ref, false), data);
}

/** A copy of `obj` with its strings (and its stream data) decrypted. */
async function decryptObject(obj, ref, h) {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    return PDFHexString.of(hex(await decryptBytes(obj.asBytes(), h.str, h, ref)));
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      const nv = await decryptObject(v, ref, h);
      if (nv !== v) obj.set(i, nv);
    }
    return obj;
  }
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      const nv = await decryptObject(v, ref, h);
      if (nv !== v) obj.set(k, nv);
    }
    return obj;
  }
  if (obj instanceof PDFRawStream) {
    await decryptObject(obj.dict, ref, h);
    const type = obj.dict.get(PDFName.of('Type'));
    if (type === PDFName.of('XRef')) return obj;
    if (type === PDFName.of('Metadata') && !h.encryptMetadata) return obj;
    const plain = await decryptBytes(obj.contents, h.stm, h, ref);
    obj.dict.set(PDFName.of('Length'), PDFNumber.of(plain.length));
    return PDFRawStream.of(obj.dict, plain);
  }
  return obj;
}

/**
 * The file with its encrypted object streams appended again, decrypted; null when it has none.
 */
async function decryptObjectStreams(ctx, h, bytes) {
  const parts = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFInvalidObject)) continue;
    const raw = obj.data;
    const text = latin1(raw.subarray(0, Math.min(raw.length, 2048)));
    if (!/\/Type\s*\/ObjStm/.test(text)) continue;
    const at = text.indexOf('stream');
    if (at < 0) continue;
    const dict = text.slice(0, at);
    const n = /\/N\s+(\d+)/.exec(dict), first = /\/First\s+(\d+)/.exec(dict);
    if (!n || !first) continue;
    let start = at + 6;
    if (raw[start] === 13) start++;
    if (raw[start] === 10) start++;
    let end = lastIndexOf(raw, 'endstream');
    if (end < start) continue;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (len && start + Number(len[1]) <= end) end = start + Number(len[1]);
    else while (end > start && (raw[end - 1] === 10 || raw[end - 1] === 13)) end--;
    const data = await decryptBytes(raw.subarray(start, end), h.stm, h, ref);
    const filter = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(dict);
    const parms = /\/DecodeParms\s*(<<[^>]*>>|\[[^\]]*\])/.exec(dict);
    const head = `\n${ref.objectNumber} ${ref.generationNumber} obj\n<</Type/ObjStm/N ${n[1]}/First ${first[1]}` +
      `/Length ${data.length}${filter ? '/Filter' + filter[1] : ''}${parms ? '/DecodeParms' + parms[1] : ''}>>\nstream\n`;
    parts.push(bytesOf(head), data, bytesOf('\nendstream\nendobj\n'));
  }
  if (!parts.length) return null;
  return concat([bytes, ...parts]);
}

// ------------------------------------------------------------ ciphers

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

async function aesKey(key, use) {
  return crypto.subtle.importKey('raw', key, 'AES-CBC', false, [use]);
}

async function aesDecryptPadded(key, iv, data) {
  const k = await aesKey(key, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, data));
}

/** AES-CBC encryption without padding (the data is a whole number of blocks). */
async function aesEncryptRaw(key, iv, data) {
  const k = await aesKey(key, 'encrypt');
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data));
  return out.subarray(0, data.length);
}

/** AES-CBC decryption without padding: a block that decrypts to full padding is added first. */
async function aesDecryptRaw(key, iv, data) {
  const enc = await aesKey(key, 'encrypt');
  const last = data.subarray(data.length - 16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, enc, new Uint8Array(16).fill(16)));
  const dec = await aesKey(key, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, dec, concat([data, extra.subarray(0, 16)])));
}

/** MD5 (RFC 1321). */
export function md5(data) {
  const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
  const len = data.length, total = ((len + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getInt32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const s = S[(i >> 4) * 4 + (i & 3)];
      const x = (a + f + K[i] + M[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setInt32(i * 4, v, true));
  return out;
}

/** Pieces the tests use to make encrypted files. */
export const _forTests = { rc4, hash, objectKey, aesEncryptRaw, PAD };

// ------------------------------------------------------------ bytes

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function le32(v) {
  return new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
}

function equal(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function bytesOf(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

function lastIndexOf(bytes, word) {
  outer: for (let i = bytes.length - word.length; i >= 0; i--) {
    for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
