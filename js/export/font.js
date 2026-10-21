// A font as far as text extraction needs it: byte codes -> Unicode text and glyph widths.

import { PDFName, PDFArray, PDFDict } from '../../vendor/pdf-lib.esm.min.js';
import * as pdf from './pdfobj.js';

export class FontInfo {
  /** Reads a font dictionary; null gives the fallback used when no font is set (Windows-1252, half-em widths). */
  constructor(ctx, f) {
    this.twoByte = false;
    /** code -> text from the ToUnicode CMap */
    this.toUnicode = new Map();
    /** single-byte code -> text (or null) */
    this.simple = Array.from({ length: 256 }, (_, i) => (i < 32 ? null : ansi(i)));
    this.widths = new Map();
    this.defaultWidth = 0.5;
    this.widthScale = 0.001;
    if (!f) return;
    const subtype = pdf.getName(ctx, f, 'Subtype') ?? '';
    this.twoByte = subtype === 'Type0';

    if (subtype === 'Type3') {
      const fm = pdf.getArray(ctx, f, 'FontMatrix');
      if (fm && fm.length) this.widthScale = pdf.num(ctx, fm[0]);
    }

    if (this.twoByte) {
      const d = pdf.getArray(ctx, f, 'DescendantFonts');
      const cid = d && d.length ? pdf.asDict(pdf.resolve(ctx, d[0])) : null;
      this.defaultWidth = 1.0;
      if (cid) {
        const dw = pdf.getRaw(cid, 'DW');
        if (dw !== undefined) this.defaultWidth = pdf.num(ctx, dw) * 0.001;
        const w = pdf.getArray(ctx, cid, 'W');
        if (w) this.readCidWidths(ctx, w);
      }
    } else {
      this.readEncoding(ctx, pdf.get(ctx, f, 'Encoding'));
      const fc = pdf.get(ctx, f, 'FirstChar');
      const first = fc ? Math.trunc(pdf.num(ctx, fc)) : 0;
      const w = pdf.getArray(ctx, f, 'Widths');
      if (w) w.forEach((v, i) => this.widths.set(first + i, pdf.num(ctx, v) * this.widthScale));
      const fd = pdf.getDict(ctx, f, 'FontDescriptor');
      const mw = fd && pdf.getRaw(fd, 'MissingWidth');
      if (mw !== undefined && mw !== null) this.defaultWidth = pdf.num(ctx, mw) * 0.001;
      if (this.defaultWidth <= 0) this.defaultWidth = 0.5;
    }

    const tu = pdf.get(ctx, f, 'ToUnicode');
    const data = tu && pdf.streamBytes(tu);
    if (data) this.readCmap(data);
  }

  /** The codes in a shown string: [{ text (or null), width (in text space units per em), isSpace }]. */
  decode(bytes) {
    const step = this.twoByte ? 2 : 1;
    const out = [];
    for (let i = 0; i + step - 1 < bytes.length; i += step) {
      const code = this.twoByte ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      let text = this.toUnicode.get(code);
      if (text === undefined) text = this.twoByte ? null : this.simple[code];
      const width = this.widths.get(code) ?? this.defaultWidth;
      out.push({ text, width, isSpace: !this.twoByte && code === 32 });
    }
    return out;
  }

  readCidWidths(ctx, w) {
    let i = 0;
    while (i < w.length) {
      const first = Math.trunc(pdf.num(ctx, w[i]));
      if (i + 1 >= w.length) break;
      const list = pdf.resolve(ctx, w[i + 1]);
      if (list instanceof PDFArray) {
        list.asArray().forEach((v, k) => this.widths.set(first + k, pdf.num(ctx, v) * 0.001));
        i += 2;
      } else {
        if (i + 2 >= w.length) break;
        const last = Math.trunc(pdf.num(ctx, w[i + 1]));
        const width = pdf.num(ctx, w[i + 2]) * 0.001;
        for (let c = first; c <= last && c - first < 65536; c++) this.widths.set(c, width);
        i += 3;
      }
    }
  }

  readEncoding(ctx, enc) {
    let base = null, dict = null;
    if (enc instanceof PDFName) base = pdf.name(enc);
    else if (enc instanceof PDFDict) {
      base = pdf.getName(ctx, enc, 'BaseEncoding');
      dict = enc;
    }
    if (base === 'MacRomanEncoding') {
      for (let i = 128; i < 256; i++) this.simple[i] = MAC_ROMAN_HIGH[i - 128];
    }
    const diffs = dict && pdf.getArray(ctx, dict, 'Differences');
    if (!diffs) return;
    let code = 0;
    for (const e of diffs) {
      const o = pdf.resolve(ctx, e);
      if (o instanceof PDFName) {
        if (code >= 0 && code < 256) this.simple[code] = glyphText(utf8Lossy(o.asBytes()));
        code += 1;
      } else {
        code = Math.trunc(pdf.num(ctx, o));
      }
    }
  }

  /** ToUnicode CMap: bfchar and bfrange sections. */
  readCmap(data) {
    for (const [code, text] of parseCmap(data)) this.toUnicode.set(code, text);
  }
}

const isWs = (c) => c === 32 || (c >= 9 && c <= 13);

/** The code -> text pairs of a ToUnicode CMap, in file order. */
export function parseCmap(data) {
  const tokens = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    if (c === 0x3c /* < */) {
      const e = data.indexOf(0x3e /* > */, i);
      if (e < 0) break;
      tokens.push(pdf.latin1(data.subarray(i, e + 1)));
      i = e + 1;
    } else if (c === 0x5b || c === 0x5d) {
      tokens.push(String.fromCharCode(c));
      i += 1;
    } else if (isWs(c)) {
      i += 1;
    } else {
      const st = i;
      while (i < data.length && !isWs(data[i]) && data[i] !== 0x3c && data[i] !== 0x5b && data[i] !== 0x5d) i++;
      tokens.push(pdf.latin1(data.subarray(st, i)));
    }
  }

  const out = [];
  i = 0;
  while (i < tokens.length) {
    if (tokens[i] === 'beginbfchar') {
      i += 1;
      while (i + 1 < tokens.length && tokens[i] !== 'endbfchar') {
        out.push([hexNum(tokens[i]), utf16Lossy(hexText(tokens[i + 1]))]);
        i += 2;
      }
    } else if (tokens[i] === 'beginbfrange') {
      i += 1;
      while (i + 2 < tokens.length && tokens[i] !== 'endbfrange') {
        const lo = hexNum(tokens[i]), hi = hexNum(tokens[i + 1]);
        if (tokens[i + 2] === '[') {
          let k = i + 3;
          let c = lo;
          while (k < tokens.length && tokens[k] !== ']') {
            out.push([c, utf16Lossy(hexText(tokens[k]))]);
            c += 1;
            k += 1;
          }
          i = k + 1;
        } else {
          const start = hexText(tokens[i + 2]);
          for (let c = lo; c <= hi && c - lo < 65536; c++) {
            if (!start.length) break;
            const units = start.slice();
            units[units.length - 1] = (units[units.length - 1] + ((c - lo) & 0xffff)) & 0xffff;
            out.push([c, utf16Lossy(units)]);
          }
          i += 3;
        }
      }
    }
    i += 1;
  }
  return out;
}

function trimAngles(t) {
  let st = 0;
  while (st < t.length && (t[st] === '<' || t[st] === '>')) st++;
  let en = t.length;
  while (en > st && (t[en - 1] === '<' || t[en - 1] === '>')) en--;
  return t.slice(st, en);
}

const hexDigit = (ch) => {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
};

/** A hex code, wrapped to a signed 32-bit number like the desktop app. */
function hexNum(t) {
  let v = 0;
  for (const ch of trimAngles(t)) {
    const d = hexDigit(ch);
    if (d >= 0) v = (v * 16 + d) % 4294967296;
  }
  return v | 0;
}

/** Hex digits as UTF-16 code units, four digits each (or one byte when there are just two digits). */
function hexText(t) {
  const h = [...trimAngles(t)].map(hexDigit).filter((d) => d >= 0);
  const units = [];
  for (let i = 0; i + 4 <= h.length; i += 4) units.push((h[i] << 12) | (h[i + 1] << 8) | (h[i + 2] << 4) | h[i + 3]);
  if (h.length === 2) units.push((h[0] << 4) | h[1]);
  return units;
}

const utf16Decoder = new TextDecoder('utf-16le');
const utf8Decoder = new TextDecoder('utf-8');

/** UTF-16 code units as text, lone surrogates replaced by U+FFFD. */
export function utf16Lossy(units) {
  const b = new Uint8Array(units.length * 2);
  units.forEach((u, i) => {
    b[i * 2] = u & 255;
    b[i * 2 + 1] = u >> 8;
  });
  return utf16Decoder.decode(b);
}

function utf8Lossy(bytes) {
  return utf8Decoder.decode(bytes);
}

/** Windows-1252, as .NET decodes it (the five undefined bytes map to the same code point). */
export function ansi(b) {
  const HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
  return b >= 0x80 && b < 0xa0 ? HIGH[b - 0x80] : String.fromCharCode(b);
}

/** Mac OS Roman, bytes 128-255. */
const MAC_ROMAN_HIGH = [...(
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü' +
  '†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ' +
  '‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'
)];

/** Adobe glyph names that turn up in font /Differences arrays. */
const GLYPH_NAMES = new Map([
  ['space', ' '], ['exclam', '!'], ['quotedbl', '"'], ['numbersign', '#'], ['dollar', '$'],
  ['percent', '%'], ['ampersand', '&'], ['quotesingle', "'"], ['quoteright', '’'], ['quoteleft', '‘'],
  ['parenleft', '('], ['parenright', ')'], ['asterisk', '*'], ['plus', '+'], ['comma', ','],
  ['hyphen', '-'], ['minus', '−'], ['period', '.'], ['slash', '/'], ['zero', '0'], ['one', '1'],
  ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'], ['six', '6'], ['seven', '7'],
  ['eight', '8'], ['nine', '9'], ['colon', ':'], ['semicolon', ';'], ['less', '<'], ['equal', '='],
  ['greater', '>'], ['question', '?'], ['at', '@'], ['bracketleft', '['], ['backslash', '\\'],
  ['bracketright', ']'], ['asciicircum', '^'], ['underscore', '_'], ['grave', '`'], ['braceleft', '{'],
  ['bar', '|'], ['braceright', '}'], ['asciitilde', '~'], ['bullet', '•'], ['endash', '–'],
  ['emdash', '—'], ['quotedblleft', '“'], ['quotedblright', '”'], ['degree', '°'], ['plusminus', '±'],
  ['multiply', '×'], ['divide', '÷'], ['mu', 'µ'], ['Oslash', 'Ø'], ['oslash', 'ø'], ['diameter', '⌀'],
  ['copyright', '©'], ['registered', '®'], ['trademark', '™'], ['section', '§'], ['paragraph', '¶'],
  ['fi', 'fi'], ['fl', 'fl'], ['ff', 'ff'], ['ffi', 'ffi'], ['ffl', 'ffl'], ['ellipsis', '…'],
  ['onehalf', '½'], ['onequarter', '¼'], ['threequarters', '¾'], ['nbspace', ' '],
  ['nonbreakingspace', ' '], ['periodcentered', '·'], ['dagger', '†'], ['Euro', '€'], ['cent', '¢'],
  ['sterling', '£'], ['yen', '¥'], ['quotesinglbase', '‚'], ['quotedblbase', '„'],
  ['guillemotleft', '«'], ['guillemotright', '»'],
]);

/** A code point as text; null for surrogates and values past U+10FFFF (they can't be shown). */
function fromCodePoint(v) {
  if (v > 0x10ffff || (v >= 0xd800 && v <= 0xdfff)) return null;
  return String.fromCodePoint(v);
}

/** Rust's u32::from_str_radix(s, 16): an optional plus sign and hex digits only. */
function parseHex(s) {
  if (!/^\+?[0-9A-Fa-f]+$/.test(s)) return null;
  const v = parseInt(s, 16);
  return v > 0xffffffff ? null : v;
}

/** The text for a glyph name, or null when it isn't known. */
export function glyphText(name) {
  const dot = name.indexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  const known = GLYPH_NAMES.get(name);
  if (known !== undefined) return known;
  if ([...name].length === 1) return name;
  const byteLen = new TextEncoder().encode(name).length;
  if (name.startsWith('uni') && byteLen >= 7) {
    const v = parseHex(name.slice(3, 7));
    if (v !== null) return fromCodePoint(v);
  }
  if (name.startsWith('u') && byteLen >= 5) {
    const v = parseHex(name.slice(1));
    if (v !== null && v < 0x110000) return fromCodePoint(v);
  }
  return null;
}
