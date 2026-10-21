// Test helper: makes encrypted copies of a PDF (empty user password) with the standard security
// handler, to check js/export/decrypt.js. pdf.js reads them too, which shows they follow the spec.
//   method: 'RC4' (V2/R3, 128 bit), 'AESV2' (V4/R4) or 'AESV3' (V5/R6, AES-256)
//   objectStreams: put the objects in (encrypted) object streams (RC4 only)

import { PDFDocument, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFName, PDFNumber } from '../vendor/pdf-lib.esm.min.js';
import { md5, _forTests } from '../js/export/decrypt.js';

const { rc4, hash, objectKey, aesEncryptRaw, PAD } = _forTests;

const random = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const le32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function aesPadded(key, data) {
  const iv = random(16);
  const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  return concat([iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data))]);
}

export async function encryptPdf(plain, method, objectStreams = false) {
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const ctx = doc.context;
  const id = random(16);
  let h, enc;
  if (method === 'AESV3') {
    const key = random(32), vs = random(8), ks = random(8);
    const none = new Uint8Array(0);
    const U = concat([await hash(6, none, vs, none), vs, ks]);
    const UE = await aesEncryptRaw(await hash(6, none, ks, none), new Uint8Array(16), key);
    h = { key, R: 6 };
    enc = ctx.obj({
      Filter: 'Standard', V: 5, R: 6, Length: 256, P: -4,
      O: PDFHexString.of(hex(random(48))), U: PDFHexString.of(hex(U)),
      OE: PDFHexString.of(hex(random(32))), UE: PDFHexString.of(hex(UE)), Perms: PDFHexString.of(hex(random(16))),
      CF: { StdCF: { CFM: 'AESV3', Length: 32, AuthEvent: 'DocOpen' } }, StmF: 'StdCF', StrF: 'StdCF',
    });
  } else {
    const R = method === 'AESV2' ? 4 : 3;
    const O = random(32), P = -4;
    let k = md5(concat([PAD, O, le32(P), id]));
    for (let i = 0; i < 50; i++) k = md5(k.subarray(0, 16));
    const key = k.slice(0, 16);
    let u = rc4(key, md5(concat([PAD, id])));
    for (let i = 1; i <= 19; i++) u = rc4(key.map((b) => b ^ i), u);
    h = { key, R };
    const common = { Filter: 'Standard', R, Length: 128, P, O: PDFHexString.of(hex(O)), U: PDFHexString.of(hex(concat([u, new Uint8Array(16)]))) };
    enc = method === 'AESV2'
      ? ctx.obj({ ...common, V: 4, CF: { StdCF: { CFM: 'AESV2', Length: 16, AuthEvent: 'DocOpen' } }, StmF: 'StdCF', StrF: 'StdCF' })
      : ctx.obj({ ...common, V: 2 });
  }
  const aes = method !== 'RC4';
  const crypt = async (data, ref) => {
    const key = objectKey(h, ref, aes);
    return aes ? aesPadded(key, data) : rc4(key, data);
  };
  const walk = async (obj, ref) => {
    if (obj instanceof PDFString || obj instanceof PDFHexString) return PDFHexString.of(hex(await crypt(obj.asBytes(), ref)));
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) obj.set(i, await walk(obj.get(i), ref));
      return obj;
    }
    if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) obj.set(k, await walk(v, ref));
      return obj;
    }
    if (obj instanceof PDFRawStream) {
      await walk(obj.dict, ref);
      const data = await crypt(obj.contents, ref);
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(data.length));
      return PDFRawStream.of(obj.dict, data);
    }
    return obj;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    // objects that go into object streams are encrypted with the stream, below
    if (objectStreams && !(obj instanceof PDFRawStream)) continue;
    ctx.assign(ref, await walk(obj, ref));
  }
  ctx.trailerInfo.Encrypt = enc;
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(hex(id)), PDFHexString.of(hex(id))]);
  const bytes = await doc.save({ useObjectStreams: objectStreams, addDefaultPage: false, updateFieldAppearances: false });
  if (objectStreams) {
    // RC4 keeps the length, so the object streams can be encrypted where they are
    const s = new TextDecoder('latin1').decode(bytes);
    const re = /(\d+) (\d+) obj\s*<<([^]*?)>>\s*stream\r?\n/g;
    for (let m; (m = re.exec(s)); ) {
      if (!/\/Type\s*\/ObjStm/.test(m[3])) continue;
      const len = Number(/\/Length (\d+)/.exec(m[3])[1]);
      const at = m.index + m[0].length;
      const ref = { objectNumber: Number(m[1]), generationNumber: Number(m[2]) };
      bytes.set(rc4(objectKey(h, ref, false), bytes.subarray(at, at + len)), at);
    }
  }
  return bytes;
}
