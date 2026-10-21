// Reads what a PDF page draws: its lines and curves, and every character of text with its
// position. Coordinates are in points with the origin at the bottom-left of the page as it
// is viewed (page rotation and the app's extra rotation already applied), y pointing up.
//
// Shapes (plain objects):
//   PageContent { width, height, paths: PathShape[], glyphs: Glyph[] }
//   PathShape   { subpaths: Subpath[], stroked, filled, strokeColor, fillColor, lineWidth }
//   Subpath     { segs: Seg[], closed }
//   Seg         { curve, x0, y0, x1, y1, x2, y2, x3, y3 }   (a line uses only 0 and 3)
//   Glyph       { text, x, y (start of the baseline), advance (length along the baseline),
//                 size (em height), angle (baseline direction, degrees counter-clockwise),
//                 visible (false for the hidden text layer of OCR'd scans), color }
//   Color       { r, g, b } (0-255)

import { PDFRawStream, PDFArray } from '../../vendor/pdf-lib.esm.min.js';
import { FontInfo } from './font.js';
import * as pdf from './pdfobj.js';

export const BLACK = Object.freeze({ r: 0, g: 0, b: 0 });

/** A 2D affine matrix [a b c d e f] in PDF row-vector order. */
export class Mat {
  constructor(a, b, c, d, e, f) {
    this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
  }

  static translate(x, y) {
    return new Mat(1, 0, 0, 1, x, y);
  }

  /** This, then m. */
  then(m) {
    return new Mat(
      this.a * m.a + this.b * m.c,
      this.a * m.b + this.b * m.d,
      this.c * m.a + this.d * m.c,
      this.c * m.b + this.d * m.d,
      this.e * m.a + this.f * m.c + m.e,
      this.e * m.b + this.f * m.d + m.f,
    );
  }

  apply(x, y) {
    return [x * this.a + y * this.c + this.e, x * this.b + y * this.d + this.f];
  }
}
Mat.IDENTITY = new Mat(1, 0, 0, 1, 0, 0);

export function emptyPage(width = 612, height = 792) {
  return { width, height, paths: [], glyphs: [] };
}

/**
 * Reads one page. `doc` is a pdf-lib PDFDocument, `page` the page's dictionary and
 * `extraRotation` the app's clockwise rotation on top of the page's /Rotate.
 */
export function readPage(doc, page, extraRotation) {
  const ctx = doc.context;
  if (!page) return emptyPage();
  const cb = pdf.inherited(ctx, page, 'CropBox');
  const mb = pdf.inherited(ctx, page, 'MediaBox');
  const rbox = (cb !== undefined && pdf.rect(ctx, cb)) || (mb !== undefined && pdf.rect(ctx, mb)) || [0, 0, 612, 792];
  const w = rbox[2] - rbox[0], h = rbox[3] - rbox[1];
  const r = pdf.inherited(ctx, page, 'Rotate');
  const pageRot = r !== undefined ? toI32(pdf.num(ctx, r)) : 0;
  const rot = ((((pageRot + extraRotation) | 0) % 360) + 360) % 360;
  // media box -> upright page as viewed
  let toPage = Mat.translate(-rbox[0], -rbox[1]);
  if (rot === 90) toPage = toPage.then(new Mat(0, -1, 1, 0, 0, w));
  else if (rot === 180) toPage = toPage.then(new Mat(-1, 0, 0, -1, w, h));
  else if (rot === 270) toPage = toPage.then(new Mat(0, 1, -1, 0, h, 0));
  const result = emptyPage(rot % 180 === 0 ? w : h, rot % 180 === 0 ? h : w);
  const res = pdf.inherited(ctx, page, 'Resources');
  const resources = res !== undefined ? pdf.asDict(pdf.resolve(ctx, res)) : null;
  const content = contentBytes(ctx, page);
  new Interpreter(ctx, result).run(content, resources, toPage, 0);
  return result;
}

/** Rust's `as i32` on a float: truncated, saturated, NaN as 0. */
function toI32(v) {
  if (Number.isNaN(v)) return 0;
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(v)));
}

function contentBytes(ctx, page) {
  const c = pdf.get(ctx, page, 'Contents');
  if (!c) return null;
  const parts = [];
  if (c instanceof PDFArray) {
    for (const p of c.asArray()) {
      const b = pdf.streamBytes(pdf.resolve(ctx, p));
      if (b) parts.push(b, NEWLINE);
    }
  } else {
    const b = pdf.streamBytes(c);
    if (!b) return null;
    parts.push(b, NEWLINE);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
}
const NEWLINE = new Uint8Array([10]);

// ------------------------------------------------------------ interpreter

function defaultState() {
  return {
    ctm: Mat.IDENTITY,
    stroke: BLACK,
    fill: BLACK,
    lineWidth: 1,
    font: null,
    fontSize: 12,
    charSpace: 0,
    wordSpace: 0,
    scale: 1,
    leading: 0,
    rise: 0,
    render: 0,
  };
}

/** The number at operand i, or 0. */
function n(o, i) {
  const t = o[i];
  return t && t.t === 'num' ? t.v : 0;
}

class Interpreter {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.gs = defaultState();
    this.saved = [];
    /** Fonts already read, by their dictionary. */
    this.fonts = new Map();
    this.fallback = new FontInfo(ctx, null);
    this.tm = Mat.IDENTITY;
    this.tlm = Mat.IDENTITY;
    this.current = null;
    // current point and subpath start, in page space
    this.cx = 0;
    this.cy = 0;
    this.sx = 0;
    this.sy = 0;
  }

  run(content, resources, ctm, depth) {
    if (!content) return;
    if (depth > 12) return;
    const outer = { ...this.gs };
    this.gs.ctm = ctm;
    const savedDepth = this.saved.length;
    const lexer = new Lexer(content);
    let operands = [];
    for (let tok; (tok = lexer.next()) !== null; ) {
      if (tok.t === 'op') {
        this.execute(tok.v, operands, resources, depth);
        operands = [];
      } else {
        operands.push(tok);
      }
    }
    this.saved.length = Math.min(this.saved.length, savedDepth);
    this.gs = outer;
  }

  execute(op, o, res, depth) {
    const gs = this.gs;
    switch (op) {
      case 'q': this.saved.push({ ...gs }); break;
      case 'Q': if (this.saved.length) this.gs = this.saved.pop(); break;
      case 'cm': gs.ctm = new Mat(n(o, 0), n(o, 1), n(o, 2), n(o, 3), n(o, 4), n(o, 5)).then(gs.ctm); break;
      case 'w': gs.lineWidth = n(o, 0); break;

      // colors
      case 'g': gs.fill = gray(n(o, 0)); break;
      case 'G': gs.stroke = gray(n(o, 0)); break;
      case 'rg': gs.fill = rgb(n(o, 0), n(o, 1), n(o, 2)); break;
      case 'RG': gs.stroke = rgb(n(o, 0), n(o, 1), n(o, 2)); break;
      case 'k': gs.fill = cmyk(n(o, 0), n(o, 1), n(o, 2), n(o, 3)); break;
      case 'K': gs.stroke = cmyk(n(o, 0), n(o, 1), n(o, 2), n(o, 3)); break;
      case 'sc': case 'scn': gs.fill = anyColor(o, gs.fill); break;
      case 'SC': case 'SCN': gs.stroke = anyColor(o, gs.stroke); break;
      case 'cs': gs.fill = BLACK; break;
      case 'CS': gs.stroke = BLACK; break;

      // paths
      case 'm': { const [x, y] = gs.ctm.apply(n(o, 0), n(o, 1)); this.moveTo(x, y); break; }
      case 'l': { const [x, y] = gs.ctm.apply(n(o, 0), n(o, 1)); this.lineTo(x, y); break; }
      case 'c': this.curve(n(o, 0), n(o, 1), n(o, 2), n(o, 3), n(o, 4), n(o, 5), false); break;
      case 'v': this.curve(0, 0, n(o, 0), n(o, 1), n(o, 2), n(o, 3), true); break;
      case 'y': this.curve(n(o, 0), n(o, 1), n(o, 2), n(o, 3), n(o, 2), n(o, 3), false); break;
      case 'h': this.close(); break;
      case 're': {
        const x = n(o, 0), y = n(o, 1), rw = n(o, 2), rh = n(o, 3);
        const ctm = gs.ctm;
        this.moveTo(...ctm.apply(x, y));
        this.lineTo(...ctm.apply(x + rw, y));
        this.lineTo(...ctm.apply(x + rw, y + rh));
        this.lineTo(...ctm.apply(x, y + rh));
        this.close();
        break;
      }
      case 'S': this.paint(true, false, false); break;
      case 's': this.paint(true, false, true); break;
      case 'f': case 'F': case 'f*': this.paint(false, true, false); break;
      case 'B': case 'B*': this.paint(true, true, false); break;
      case 'b': case 'b*': this.paint(true, true, true); break;
      case 'n': this.current = null; break;

      // text
      case 'BT': this.tm = Mat.IDENTITY; this.tlm = Mat.IDENTITY; break;
      case 'Tc': gs.charSpace = n(o, 0); break;
      case 'Tw': gs.wordSpace = n(o, 0); break;
      case 'Tz': gs.scale = n(o, 0) / 100; break;
      case 'TL': gs.leading = n(o, 0); break;
      case 'Ts': gs.rise = n(o, 0); break;
      case 'Tr': gs.render = toI32(n(o, 0)); break;
      case 'Tf':
        gs.fontSize = n(o, 1);
        if (o[0] && o[0].t === 'name') gs.font = this.font(res, o[0].v);
        break;
      case 'Td':
        this.tlm = Mat.translate(n(o, 0), n(o, 1)).then(this.tlm);
        this.tm = this.tlm;
        break;
      case 'TD':
        gs.leading = -n(o, 1);
        this.tlm = Mat.translate(n(o, 0), n(o, 1)).then(this.tlm);
        this.tm = this.tlm;
        break;
      case 'Tm':
        this.tlm = new Mat(n(o, 0), n(o, 1), n(o, 2), n(o, 3), n(o, 4), n(o, 5));
        this.tm = this.tlm;
        break;
      case 'T*': this.nextLine(); break;
      case 'Tj': if (o[0] && o[0].t === 'str') this.show(o[0].v); break;
      case "'":
        this.nextLine();
        if (o[0] && o[0].t === 'str') this.show(o[0].v);
        break;
      case '"':
        gs.wordSpace = n(o, 0);
        gs.charSpace = n(o, 1);
        this.nextLine();
        if (o[2] && o[2].t === 'str') this.show(o[2].v);
        break;
      case 'TJ':
        if (o[0] && o[0].t === 'arr') {
          for (const e of o[0].v) {
            if (e.t === 'str') this.show(e.v);
            else if (e.t === 'num') {
              const dx = (-e.v / 1000) * this.gs.fontSize * this.gs.scale;
              this.tm = Mat.translate(dx, 0).then(this.tm);
            }
          }
        }
        break;

      // form XObjects
      case 'Do': this.form(o, res, depth); break;
      default: break;
    }
  }

  form(o, res, depth) {
    const ctx = this.ctx;
    if (!(o[0] && o[0].t === 'name') || !res) return;
    const xobjs = pdf.getDict(ctx, res, 'XObject');
    if (!xobjs) return;
    const x = pdf.get(ctx, xobjs, o[0].v);
    if (!(x instanceof PDFRawStream)) return;
    if (pdf.getName(ctx, x.dict, 'Subtype') !== 'Form') return;
    let m = Mat.IDENTITY;
    const ma = pdf.getArray(ctx, x.dict, 'Matrix');
    if (ma && ma.length === 6) {
      const v = ma.map((e) => pdf.num(ctx, e));
      m = new Mat(v[0], v[1], v[2], v[3], v[4], v[5]);
    }
    const xres = pdf.getDict(ctx, x.dict, 'Resources') ?? res;
    const savedTm = this.tm, savedTlm = this.tlm;
    const bytes = pdf.streamBytes(x);
    const ctm = m.then(this.gs.ctm);
    this.run(bytes, xres, ctm, depth + 1);
    this.tm = savedTm;
    this.tlm = savedTlm;
  }

  moveTo(x, y) {
    (this.current ??= newShape()).subpaths.push({ segs: [], closed: false });
    this.cx = x;
    this.sx = x;
    this.cy = y;
    this.sy = y;
  }

  lineTo(x, y) {
    const sub = this.current?.subpaths.at(-1);
    if (!sub) {
      this.moveTo(x, y);
      return;
    }
    sub.segs.push(lineSeg(this.cx, this.cy, x, y));
    this.cx = x;
    this.cy = y;
  }

  curve(x1, y1, x2, y2, x3, y3, firstIsCurrent) {
    const ctm = this.gs.ctm;
    const sub = this.current?.subpaths.at(-1);
    if (!sub) return;
    const [p1x, p1y] = firstIsCurrent ? [this.cx, this.cy] : ctm.apply(x1, y1);
    const [p2x, p2y] = ctm.apply(x2, y2);
    const [p3x, p3y] = ctm.apply(x3, y3);
    sub.segs.push({ curve: true, x0: this.cx, y0: this.cy, x1: p1x, y1: p1y, x2: p2x, y2: p2y, x3: p3x, y3: p3y });
    this.cx = p3x;
    this.cy = p3y;
  }

  close() {
    const sub = this.current?.subpaths.at(-1);
    if (!sub) return;
    if (Math.abs(this.cx - this.sx) > 1e-6 || Math.abs(this.cy - this.sy) > 1e-6) {
      sub.segs.push(lineSeg(this.cx, this.cy, this.sx, this.sy));
    }
    sub.closed = true;
    this.cx = this.sx;
    this.cy = this.sy;
  }

  paint(stroke, fill, close) {
    if (close) this.close();
    const current = this.current;
    this.current = null;
    if (!current) return;
    const gs = this.gs;
    current.stroked = stroke;
    current.filled = fill;
    current.strokeColor = gs.stroke;
    current.fillColor = gs.fill;
    const lx = gs.ctm.a + gs.ctm.c, ly = gs.ctm.b + gs.ctm.d;
    current.lineWidth = gs.lineWidth * Math.sqrt((lx * lx + ly * ly) / 2);
    current.subpaths = current.subpaths.filter((s) => s.segs.length);
    if (current.subpaths.length) this.output.paths.push(current);
  }

  nextLine() {
    this.tlm = Mat.translate(0, -this.gs.leading).then(this.tlm);
    this.tm = this.tlm;
  }

  font(res, name) {
    const ctx = this.ctx;
    if (!res) return null;
    const fontDict = pdf.getDict(ctx, res, 'Font');
    if (!fontDict) return null;
    const f = pdf.asDict(pdf.get(ctx, fontDict, name));
    if (!f) return null;
    let info = this.fonts.get(f);
    if (!info) {
      info = new FontInfo(ctx, f);
      this.fonts.set(f, info);
    }
    return info;
  }

  show(bytes) {
    const font = this.gs.font ?? this.fallback;
    for (const code of font.decode(bytes)) {
      const gs = this.gs;
      const adv = code.width * gs.fontSize * gs.scale;
      const m = this.tm.then(gs.ctm);
      const [x0, y0] = m.apply(0, gs.rise);
      const [x1, y1] = m.apply(adv, gs.rise);
      const [ux, uy] = m.apply(0, gs.rise + gs.fontSize);
      const size = Math.sqrt((ux - x0) * (ux - x0) + (uy - y0) * (uy - y0));
      const angle = Math.atan2(m.b, m.a) * (180 / Math.PI);
      if (code.text && size > 0.01) {
        this.output.glyphs.push({
          text: code.text,
          x: x0,
          y: y0,
          size,
          angle,
          advance: Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)),
          visible: gs.render !== 3 && gs.render !== 7,
          color: gs.render === 1 ? gs.stroke : gs.fill,
        });
      }
      const tx = adv + (gs.charSpace + (code.isSpace ? gs.wordSpace : 0)) * gs.scale;
      this.tm = Mat.translate(tx, 0).then(this.tm);
    }
  }
}

function newShape() {
  return { subpaths: [], stroked: false, filled: false, strokeColor: BLACK, fillColor: BLACK, lineWidth: 0 };
}

function lineSeg(x0, y0, x3, y3) {
  return { curve: false, x0, y0, x1: 0, y1: 0, x2: 0, y2: 0, x3, y3 };
}

function clamp(v) {
  const r = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return Number.isNaN(r) ? 0 : r;
}

function gray(g) {
  const v = clamp(g);
  return { r: v, g: v, b: v };
}

function rgb(r, g, b) {
  return { r: clamp(r), g: clamp(g), b: clamp(b) };
}

function cmyk(c, m, y, k) {
  return { r: clamp((1 - c) * (1 - k)), g: clamp((1 - m) * (1 - k)), b: clamp((1 - y) * (1 - k)) };
}

function anyColor(o, keep) {
  const v = o.filter((t) => t.t === 'num').map((t) => t.v);
  switch (v.length) {
    case 1: return gray(v[0]);
    case 3: return rgb(v[0], v[1], v[2]);
    case 4: return cmyk(v[0], v[1], v[2], v[3]);
    default: return keep;
  }
}

// ------------------------------------------------------------ lexer

// Tokens: { t: 'num', v: number } | { t: 'str', v: Uint8Array } | { t: 'name', v: string }
// (without its slash, #xx escapes decoded, one character per byte; dictionaries come back as the
// name "<<dict>>") | { t: 'arr', v: Token[] } | { t: 'op', v: string }.

const white = (b) => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
// ( ) < > [ ] { } / %
const delim = (b) => b === 0x28 || b === 0x29 || b === 0x3c || b === 0x3e || b === 0x5b || b === 0x5d ||
  b === 0x7b || b === 0x7d || b === 0x2f || b === 0x25;

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

// what Rust's f64 parser accepts (inf and nan are refused afterwards anyway)
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export class Lexer {
  constructor(s) {
    this.s = s;
    this.p = 0;
  }

  /** The next token, or null at the end. */
  next() {
    return this.nextAt(0);
  }

  nextAt(depth) {
    const s = this.s;
    for (;;) {
      for (;;) {
        while (this.p < s.length && white(s[this.p])) this.p++;
        if (this.p >= s.length) return null;
        if (s[this.p] === 0x25 /* % */) {
          while (this.p < s.length && s[this.p] !== 10 && s[this.p] !== 13) this.p++;
          continue;
        }
        break;
      }
      const c = s[this.p];
      if (c === 0x5b /* [ */) {
        this.p++;
        if (depth > 64) continue; // absurdly deep nesting: flatten rather than recurse
        const list = [];
        for (let t; (t = this.nextAt(depth + 1)) !== null; ) {
          if (t.t === 'op' && t.v === ']') break;
          list.push(t);
        }
        return { t: 'arr', v: list };
      }
      if (c === 0x5d /* ] */) {
        this.p++;
        return { t: 'op', v: ']' };
      }
      if (c === 0x3c && this.p + 1 < s.length && s[this.p + 1] === 0x3c) {
        // dictionary (marked-content properties, inline image params): read and drop
        this.p += 2;
        for (let t; (t = this.nextAt(depth + 1)) !== null; ) {
          if (t.t === 'op' && t.v === '>>') break;
        }
        return { t: 'name', v: '<<dict>>' };
      }
      if (c === 0x3e && this.p + 1 < s.length && s[this.p + 1] === 0x3e) {
        this.p += 2;
        return { t: 'op', v: '>>' };
      }
      if (c === 0x28 /* ( */) return { t: 'str', v: this.literal() };
      if (c === 0x3c /* < */) return { t: 'str', v: this.hex() };
      if (c === 0x2f /* / */) {
        this.p++;
        const st = this.p;
        while (this.p < s.length && !white(s[this.p]) && !delim(s[this.p])) this.p++;
        return { t: 'name', v: pdf.latin1(unescapeName(s.subarray(st, this.p))) };
      }
      if (c === 0x7b || c === 0x7d) {
        this.p++;
        continue;
      }
      const start = this.p;
      while (this.p < s.length && !white(s[this.p]) && !delim(s[this.p])) this.p++;
      if (this.p === start) {
        this.p++;
        continue;
      }
      const word = pdf.latin1(s.subarray(start, this.p));
      const w0 = word.charCodeAt(0);
      if ((w0 >= 48 && w0 <= 57) || w0 === 0x2d || w0 === 0x2b || w0 === 0x2e) {
        if (NUMBER.test(word)) {
          const v = Number(word);
          if (Number.isFinite(v)) return { t: 'num', v };
        }
      }
      if (word === 'BI') {
        this.skipInlineImage();
        continue;
      }
      return { t: 'op', v: word };
    }
  }

  literal() {
    const s = this.s;
    this.p++;
    const b = [];
    let depth = 1;
    while (this.p < s.length) {
      const c = s[this.p++];
      if (c === 0x5c /* \ */ && this.p < s.length) {
        const e = s[this.p++];
        switch (e) {
          case 0x6e: b.push(10); break; // n
          case 0x72: b.push(13); break; // r
          case 0x74: b.push(9); break; // t
          case 0x62: b.push(8); break; // b
          case 0x66: b.push(12); break; // f
          case 13:
            if (this.p < s.length && s[this.p] === 10) this.p++;
            break;
          case 10: break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = e - 0x30;
              for (let k = 0; k < 2 && this.p < s.length && s[this.p] >= 0x30 && s[this.p] <= 0x37; k++) {
                v = v * 8 + (s[this.p] - 0x30);
                this.p++;
              }
              b.push(v & 255);
            } else {
              b.push(e);
            }
        }
      } else if (c === 0x28) {
        depth++;
        b.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        b.push(c);
      } else {
        b.push(c);
      }
    }
    return Uint8Array.from(b);
  }

  hex() {
    const s = this.s;
    this.p++;
    const b = [];
    let hi = -1;
    while (this.p < s.length && s[this.p] !== 0x3e) {
      const v = hexVal(s[this.p]);
      this.p++;
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        b.push(hi * 16 + v);
        hi = -1;
      }
    }
    this.p++;
    if (hi >= 0) b.push(hi * 16);
    return Uint8Array.from(b);
  }

  skipInlineImage() {
    // skip the parameters up to ID, then the image data up to a free-standing EI
    for (let t; (t = this.next()) !== null; ) {
      if (t.t === 'op' && t.v === 'ID') break;
    }
    const s = this.s;
    this.p++;
    while (this.p + 1 < s.length) {
      const p = this.p;
      if (s[p] === 0x45 && s[p + 1] === 0x49 && (p === 0 || white(s[p - 1])) && (p + 2 >= s.length || white(s[p + 2]))) {
        this.p += 2;
        return;
      }
      this.p++;
    }
    this.p = s.length;
  }
}

function unescapeName(raw) {
  const out = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === 0x23 /* # */ && i + 2 < raw.length) {
      const h = hexVal(raw[i + 1]), l = hexVal(raw[i + 2]);
      if (h >= 0 && l >= 0) {
        out.push(h * 16 + l);
        i += 3;
        continue;
      }
    }
    out.push(raw[i]);
    i++;
  }
  return Uint8Array.from(out);
}
