// Small helpers over pdf-lib's object model: following references, reading numbers, names,
// dictionaries and stream contents, and page attributes that can be inherited from the page tree.
// (The Rust app does the same over lopdf; see crates/export/src/pdf.rs.)

import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream, PDFStream, PDFNull,
  decodePDFRawStream,
} from '../../vendor/pdf-lib.esm.min.js';
import { decryptDocument } from './decrypt.js';

/** Follows references until it reaches a direct object; null for null, missing objects or a loop. */
export function resolve(ctx, obj) {
  for (let i = 0; i < 32; i++) {
    if (obj instanceof PDFRef) {
      obj = ctx.lookup(obj);
      continue;
    }
    return obj === undefined || obj === PDFNull ? null : obj;
  }
  return null;
}

/** The value of `key` (a string) in a dictionary, references followed; null when missing. */
export function get(ctx, dict, key) {
  if (!dict) return null;
  return resolve(ctx, dict.get(PDFName.of(key)));
}

/** The raw (unresolved) value of `key`, or undefined. */
export function getRaw(dict, key) {
  return dict ? dict.get(PDFName.of(key)) : undefined;
}

/**
 * A number, or 0 for anything else. lopdf keeps real numbers as 32-bit floats, so fractions
 * are rounded the same way here to give the same results as the desktop app.
 */
export function num(ctx, obj) {
  const o = resolve(ctx, obj);
  if (!(o instanceof PDFNumber)) return 0;
  const v = o.asNumber();
  return Number.isInteger(v) ? v : Math.fround(v);
}

/** A name's text (#xx escapes decoded, each byte one character), or null. */
export function name(obj) {
  return obj instanceof PDFName ? latin1(obj.asBytes()) : null;
}

/** A dictionary (a stream counts as its dictionary), or null. */
export function asDict(obj) {
  if (obj instanceof PDFDict) return obj;
  if (obj instanceof PDFStream) return obj.dict;
  return null;
}

export function getDict(ctx, dict, key) {
  return asDict(get(ctx, dict, key));
}

/** An array's elements (unresolved), or null. */
export function getArray(ctx, dict, key) {
  const a = get(ctx, dict, key);
  return a instanceof PDFArray ? a.asArray() : null;
}

export function getName(ctx, dict, key) {
  return name(get(ctx, dict, key));
}

/** A stream's decoded content, or null when it isn't a stream or can't be decoded. */
export function streamBytes(obj) {
  if (!(obj instanceof PDFRawStream)) {
    // streams pdf-lib made itself (not from a file) can encode their own contents
    if (obj instanceof PDFStream && typeof obj.getUnencodedContents === 'function') {
      try { return obj.getUnencodedContents(); } catch { return null; }
    }
    return null;
  }
  try {
    return decodePDFRawStream(obj).decode();
  } catch {
    return null;
  }
}

/**
 * A page attribute, looked up the page tree when the page itself doesn't have it
 * (Resources, MediaBox, CropBox and Rotate are inheritable). Returns the raw value.
 */
export function inherited(ctx, page, key) {
  let node = page;
  const k = PDFName.of(key);
  for (let i = 0; i < 64; i++) {
    const v = node.get(k);
    if (v !== undefined) return v;
    const parent = node.get(PDFName.of('Parent'));
    if (parent === undefined) return undefined;
    node = asDict(resolve(ctx, parent));
    if (!node) return undefined;
  }
  return undefined;
}

/** A rectangle [x1 y1 x2 y2] with its corners put in order, or null. */
export function rect(ctx, obj) {
  const a = resolve(ctx, obj);
  if (!(a instanceof PDFArray) || a.size() !== 4) return null;
  const v = a.asArray().map((o) => num(ctx, o));
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/** Bytes as a string of the same character codes. */
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return s;
}

/**
 * Opens a PDF with pdf-lib. Encrypted PDFs that open without a password are decrypted on load;
 * ones that need a password are refused with a message for the user.
 */
export async function load(bytes, fileName) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (e) {
    throw new Error(`${fileName} couldn't be read as a PDF (${e?.message ?? e}).`);
  }
  if (doc.context.trailerInfo.Encrypt) {
    let plain = null;
    try {
      plain = await decryptDocument(doc, bytes);
    } catch {
      plain = null;
    }
    if (!plain) throw new Error(`${fileName} is password-protected, so its pages can't be read.`);
    doc = plain;
  }
  return doc;
}

/** The page dictionaries of a document, in order, with their references. */
export function pages(doc) {
  return doc.getPages().map((p) => ({ ref: p.ref, dict: p.node }));
}
