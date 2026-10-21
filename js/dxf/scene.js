// Geometry: flattens the drawing's entities (with block inserts expanded) into coloured polylines
// and text runs in drawing coordinates.

import { parseF64, toI32, trim } from './model.js';

const BLACK = [0, 0, 0];
const TAU = Math.PI * 2;

// Rust's to_radians / to_degrees, so angles come out bit for bit the same
export const toRadians = (deg) => deg * (Math.PI / 180);
export const toDegrees = (rad) => rad * (180 / Math.PI);

// f64::min / f64::max: a NaN argument is ignored rather than spread
const fmin = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.min(a, b));
const fmax = (a, b) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));

export const pt = (x, y) => ({ x, y });

/** 2D affine transform: x' = a x + c y + e, y' = b x + d y + f */
export class Xf {
  constructor(a, b, c, d, e, f) {
    Object.assign(this, { a, b, c, d, e, f });
  }

  static IDENTITY = new Xf(1, 0, 0, 1, 0, 0);

  apply(x, y) {
    return pt(this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f);
  }

  /** this ∘ o (apply `o` first) */
  then(o) {
    return new Xf(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    );
  }

  static translate(x, y) {
    return new Xf(1, 0, 0, 1, x, y);
  }

  static scale(sx, sy) {
    return new Xf(sx, 0, 0, sy, 0, 0);
  }

  static rotate(deg) {
    const r = toRadians(deg);
    const [s, c] = [Math.sin(r), Math.cos(r)];
    return new Xf(c, s, -s, c, 0, 0);
  }

  det() {
    return this.a * this.d - this.b * this.c;
  }

  angle() {
    return toDegrees(Math.atan2(this.b, this.a));
  }
}

// ---- colours

const ACI = [
  BLACK,
  [220, 0, 0],
  [190, 150, 0],
  [0, 150, 0],
  [0, 150, 170],
  [0, 0, 220],
  [180, 0, 180],
  BLACK,
  [110, 110, 110],
  [150, 150, 150],
];

function trueColor(tc) {
  return darken([(tc >> 16) & 255, (tc >> 8) & 255, tc & 255]);
}

/** Very light colours are hard to see on white paper */
function darken(c) {
  const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  if (lum < 170) return c;
  const f = 150 / lum;
  return c.map((v) => Math.min(255, Math.trunc(v * f)));
}

/**
 * The drawing flattened: `strokes` ({ points, closed, filled, color }) and `texts`
 * ({ x, y, height, rotation, widthFactor, lines, hAlign 0 left 1 center 2 right,
 * vAlign 0 baseline 1 bottom 2 middle 3 top, color }), all in drawing coordinates.
 */
export class Scene {
  constructor(dwg) {
    this.dwg = dwg;
    this.strokes = [];
    this.texts = [];
  }

  build() {
    for (const e of this.dwg.entities) {
      if (e.int(67, 0) === 1) continue; // paper space
      this.emit(e, Xf.IDENTITY, 0, BLACK, null);
    }
  }

  /** Extents [minX, minY, maxX, maxY] of everything, or (withText false) of the geometry alone when there is any. */
  extents(withText) {
    let [minX, minY, maxX, maxY] = [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE];
    for (const s of this.strokes) {
      for (const p of s.points) {
        minX = fmin(minX, p.x);
        maxX = fmax(maxX, p.x);
        minY = fmin(minY, p.y);
        maxY = fmax(maxY, p.y);
      }
    }
    if (!withText && this.strokes.length > 0) return [minX, minY, maxX, maxY];
    for (const t of this.texts) {
      const chars = Math.max(0, ...t.lines.map((l) => [...l].length));
      const len = chars * t.height * 0.6 * t.widthFactor;
      const r = toRadians(t.rotation);
      const dir = t.hAlign === 0 ? 1 : t.hAlign === 1 ? 0.5 : -1;
      for (const f of [0, 1]) {
        const x = t.x + Math.cos(r) * len * f * dir;
        const y = t.y + Math.sin(r) * len * f;
        minX = fmin(minX, x);
        maxX = fmax(maxX, x);
        minY = fmin(minY, y - t.height * 0.3);
        maxY = fmax(maxY, y + t.height);
      }
    }
    if (minX > maxX) return [0, 0, 1, 1];
    return [minX, minY, maxX, maxY];
  }

  resolveColor(e, layerName, byBlock) {
    const tc = e.int(420, -1);
    if (tc >= 0) return trueColor(tc);
    let c = e.int(62, 256);
    if (c === 0) return byBlock;
    if (c === 256) {
      const layer = this.dwg.layer(layerName);
      if (!layer) return BLACK;
      if (layer.trueColor >= 0) return trueColor(layer.trueColor);
      c = layer.color;
    }
    return ACI[Math.abs(c)] ?? [70, 70, 70];
  }

  layerVisible(name) {
    const l = this.dwg.layer(name);
    return !l || l.visible;
  }

  // ---- entities

  emit(e, xf, depth, byBlock, insertLayer) {
    if (depth > 12) return;
    let layer = trim(e.str(8, '0'));
    if (layer === '0' && insertLayer !== null) layer = insertLayer;
    if (!this.layerVisible(layer)) return;
    const color = this.resolveColor(e, layer, byBlock);

    // Object coordinate system with extrusion (0,0,-1) mirrors X
    const kind = e.kind;
    if (e.dbl(230, 1) < 0 && !['LINE', 'POINT', 'SPLINE', 'LEADER'].includes(kind)) {
      xf = xf.then(Xf.scale(-1, 1));
    }

    switch (kind) {
      case 'LINE': {
        const pts = [pt(e.dbl(10, 0), e.dbl(20, 0)), pt(e.dbl(11, 0), e.dbl(21, 0))];
        this.add(xf, color, false, pts);
        break;
      }
      case 'CIRCLE':
        this.add(xf, color, true, arc(e.dbl(10, 0), e.dbl(20, 0), e.dbl(40, 0), 0, 360));
        break;
      case 'ARC': {
        const a0 = e.dbl(50, 0);
        let a1 = e.dbl(51, 360);
        while (a1 <= a0) a1 += 360;
        this.add(xf, color, false, arc(e.dbl(10, 0), e.dbl(20, 0), e.dbl(40, 0), a0, a1));
        break;
      }
      case 'ELLIPSE':
        this.add(xf, color, false, ellipse(e));
        break;
      case 'LWPOLYLINE':
        this.polyline(xf, color, lwVertices(e), (e.int(70, 0) & 1) !== 0);
        break;
      case 'POLYLINE': {
        const flags = e.int(70, 0);
        if ((flags & (16 | 64)) !== 0) return; // 3D meshes / polyface meshes
        const verts = e.children
          .filter((v) => (v.int(70, 0) & (16 | 128)) === 0) // spline frame / face records
          .map((v) => [pt(v.dbl(10, 0), v.dbl(20, 0)), v.dbl(42, 0)]);
        this.polyline(xf, color, verts, (flags & 1) !== 0);
        break;
      }
      case 'SPLINE':
        this.add(xf, color, (e.int(70, 0) & 1) !== 0, spline(e));
        break;
      case 'LEADER': {
        const [xs, ys] = [e.all(10), e.all(20)];
        const pts = xs.slice(0, ys.length).map((x, i) => pt(x, ys[i]));
        this.add(xf, color, false, pts);
        break;
      }
      case 'SOLID':
      case 'TRACE':
      case '3DFACE': {
        const p0 = pt(e.dbl(10, 0), e.dbl(20, 0));
        const p1 = pt(e.dbl(11, 0), e.dbl(21, 0));
        const p2 = pt(e.dbl(12, 0), e.dbl(22, 0));
        const p3 = pt(e.dbl(13, p2.x), e.dbl(23, p2.y));
        if (kind === '3DFACE') {
          this.add(xf, color, true, [p0, p1, p2, p3]);
        } else {
          // SOLID/TRACE are filled areas (arrowheads etc.); their corners zig-zag
          this.add(xf, color, true, [p0, p1, p3, p2]);
          const last = this.strokes.at(-1);
          if (last) last.filled = true;
        }
        break;
      }
      case 'TEXT':
      case 'ATTRIB':
        if (kind === 'ATTRIB' && (e.int(70, 0) & 1) !== 0) return; // invisible attribute
        this.text(e, xf, color);
        break;
      case 'MTEXT':
        this.mtext(e, xf, color);
        break;
      case 'INSERT':
        this.insert(e, xf, depth, color, layer);
        break;
      case 'DIMENSION': {
        const b = this.dwg.block(trim(e.str(2, '')));
        if (b) for (const c of b.entities) this.emit(c, xf, depth + 1, color, layer);
        break;
      }
    }
  }

  insert(e, xf, depth, color, layer) {
    const b = this.dwg.block(trim(e.str(2, '')));
    if (b) {
      const [sx, sy, rot] = [e.dbl(41, 1), e.dbl(42, 1), e.dbl(50, 0)];
      const cols = Math.max(e.int(70, 1), 1);
      const rows = Math.max(e.int(71, 1), 1);
      const [dx, dy] = [e.dbl(44, 0), e.dbl(45, 0)];
      for (let r = 0; r < Math.min(rows, 100); r++) {
        for (let c = 0; c < Math.min(cols, 100); c++) {
          // array offsets are along the rotated block axes
          const local = Xf.translate(e.dbl(10, 0), e.dbl(20, 0))
            .then(Xf.rotate(rot))
            .then(Xf.translate(c * dx, r * dy))
            .then(Xf.scale(sx, sy))
            .then(Xf.translate(-b.baseX, -b.baseY));
          const full = xf.then(local);
          for (const child of b.entities) {
            if (child.kind !== 'ATTDEF') this.emit(child, full, depth + 1, color, layer);
          }
        }
      }
    }
    // attributes carry their own (absolute) positions
    for (const a of e.children) this.emit(a, xf, depth + 1, color, layer);
  }

  add(xf, color, closed, pts) {
    if (pts.length < 2) return;
    const points = pts.map((p) => xf.apply(p.x, p.y));
    this.strokes.push({ points, closed, filled: false, color });
  }

  /** Polyline whose vertices may carry a bulge (arc to the next vertex: bulge = tan(angle / 4)) */
  polyline(xf, color, verts, closed) {
    if (verts.length < 2) return;
    this.add(xf, color, false, polylinePoints(verts, closed));
  }

  // ---- text

  addText(xf, color, x, y, height, rotation, widthFactor, text, h, v) {
    if (height <= 0 || text === '') return;
    const p = xf.apply(x, y);
    const scale = Math.sqrt(Math.abs(xf.det()));
    // mirrored: keep text readable
    const angle = xf.det() < 0 ? rotation - xf.angle() : rotation + xf.angle();
    this.texts.push({
      x: p.x,
      y: p.y,
      height: height * scale,
      rotation: angle,
      widthFactor: widthFactor <= 0 ? 1 : widthFactor,
      lines: text.split('\n'),
      hAlign: h,
      vAlign: v,
      color,
    });
  }

  text(e, xf, color) {
    const h = e.int(72, 0);
    const v = e.int(e.kind === 'ATTRIB' ? 74 : 73, 0);
    const aligned = h !== 0 || v !== 0;
    let x = aligned ? e.dbl(11, e.dbl(10, 0)) : e.dbl(10, 0);
    let y = aligned ? e.dbl(21, e.dbl(20, 0)) : e.dbl(20, 0);
    let ha = h === 1 || h === 4 ? 1 : h === 2 ? 2 : 0;
    let va = h === 4 ? 2 : v;
    if (h === 3 || h === 5) {
      // aligned / fit: draw from the start point
      x = e.dbl(10, 0);
      y = e.dbl(20, 0);
      ha = 0;
      va = 0;
    }
    const s = decode(e.str(1, ''));
    this.addText(xf, color, x, y, e.dbl(40, 1), e.dbl(50, 0), e.dbl(41, 1), s, ha, va);
  }

  mtext(e, xf, color) {
    let raw = e.codes.filter(([c]) => c === 3).map(([, v]) => v).join('');
    raw += e.str(1, '');
    let text = stripMtext(decode(raw));
    const height = e.dbl(40, 1);
    let rotation = e.dbl(50, NaN);
    if (Number.isNaN(rotation)) rotation = toDegrees(Math.atan2(e.dbl(21, 0), e.dbl(11, 1)));
    text = wrap(text, e.dbl(41, 0), height);
    const attach = e.int(71, 1);
    const ha = (attach - 1) % 3;
    const va = attach <= 3 ? 3 : attach <= 6 ? 2 : 1;
    this.addText(xf, color, e.dbl(10, 0), e.dbl(20, 0), height, rotation, 1, text, ha, va);
  }
}

// ---- curve sampling

/** `ceil(v) as i64` followed by `.max(lo)`, as the Rust code counts segments. */
const segments = (v, lo) => Math.max(Number.isNaN(v) ? 0 : Math.ceil(v), lo);

function arc(cx, cy, r, a0, a1) {
  if (r <= 0) return [];
  const n = segments(((a1 - a0) / 360) * 120, 8);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = toRadians(a0 + ((a1 - a0) * i) / n);
    pts.push(pt(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return pts;
}

function ellipse(e) {
  const [cx, cy] = [e.dbl(10, 0), e.dbl(20, 0)];
  const [mx, my, ratio] = [e.dbl(11, 1), e.dbl(21, 0), e.dbl(40, 1)];
  const t0 = e.dbl(41, 0);
  let t1 = e.dbl(42, TAU);
  while (t1 <= t0) t1 += TAU;
  const [nx, ny] = [-my * ratio, mx * ratio]; // minor axis: major rotated 90° CCW, scaled
  const n = segments(((t1 - t0) / TAU) * 120, 8);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    pts.push(pt(cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t)));
  }
  return pts;
}

/** LWPOLYLINE vertices as [point, bulge] (a 42 belongs to the vertex before it). */
export function lwVertices(e) {
  const verts = [];
  let x = 0;
  let haveX = false;
  for (const [code, value] of e.codes) {
    const v = parseF64(value);
    if (v === undefined) continue;
    if (code === 10) {
      x = v;
      haveX = true;
    } else if (code === 20 && haveX) {
      verts.push([pt(x, v), 0]);
      haveX = false;
    } else if (code === 42 && verts.length > 0) {
      verts.at(-1)[1] = v;
    }
  }
  return verts;
}

/** Points along a bulged polyline (the closing segment included when `closed`). */
export function polylinePoints(verts, closed) {
  const pts = [verts[0][0]];
  const segs = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < segs; i++) {
    const [a, bulge] = verts[i];
    const b = verts[(i + 1) % verts.length][0];
    if (Math.abs(bulge) > 1e-9) {
      const theta = 4 * Math.atan(bulge);
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const chord = Math.sqrt(dx * dx + dy * dy);
      if (chord > 1e-12) {
        const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
        const [mx, my] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        const h = r * Math.cos(theta / 2); // centre distance from the chord midpoint
        const sign = bulge > 0 ? 1 : -1;
        const [cx, cy] = [mx - (sign * h * dy) / chord, my + (sign * h * dx) / chord];
        const a0 = Math.atan2(a.y - cy, a.x - cx);
        const n = segments((Math.abs(theta) / TAU) * 120, 4);
        for (let k = 1; k <= n; k++) {
          const ang = a0 + (theta * k) / n;
          pts.push(pt(cx + r * Math.cos(ang), cy + r * Math.sin(ang)));
        }
        continue;
      }
    }
    pts.push(b);
  }
  return pts;
}

/** NURBS evaluation (de Boor); falls back to fit points or the control polygon */
function spline(e) {
  const degree = Math.max(e.int(71, 3), 1);
  const knots = e.all(40);
  const weights = e.all(41);
  const [cx, cy] = [e.all(10), e.all(20)];
  const n = Math.min(cx.length, cy.length);
  if (n > degree && knots.length === n + degree + 1) {
    const result = [];
    const [t0, t1] = [knots[degree], knots[n]];
    const samples = Math.max(n * 16, 16);
    for (let s = 0; s <= samples; s++) {
      let t = t0 + ((t1 - t0) * s) / samples;
      if (s === samples) t = t1 - 1e-12 * Math.max(Math.abs(t1), 1);
      let span = degree;
      while (span < n - 1 && t >= knots[span + 1]) span++;
      const dx = [];
      const dy = [];
      const dw = [];
      for (let j = 0; j <= degree; j++) {
        const idx = span - degree + j;
        const w = weights[idx] > 0 ? weights[idx] : 1;
        dx[j] = cx[idx] * w;
        dy[j] = cy[idx] * w;
        dw[j] = w;
      }
      for (let r = 1; r <= degree; r++) {
        for (let j = degree; j >= r; j--) {
          const i = span - degree + j;
          const denom = knots[i + degree - r + 1] - knots[i];
          const alpha = denom === 0 ? 0 : (t - knots[i]) / denom;
          dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
          dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
          dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
        }
      }
      result.push(pt(dx[degree] / dw[degree], dy[degree] / dw[degree]));
    }
    return result;
  }
  const [fx, fy] = [e.all(11), e.all(21)];
  if (fx.length >= 2) return fx.slice(0, fy.length).map((x, i) => pt(x, fy[i]));
  return cx.slice(0, n).map((x, i) => pt(x, cy[i]));
}

// ---- text

const UNICODE = /\\U\+([0-9A-Fa-f]{4})/g;
const DIAMETER = /%%[cC]/g;
const DEGREE = /%%[dD]/g;
const PLUS_MINUS = /%%[pP]/g;
const UNDERLINE = /%%[uUoOkK]/g;
const PARAGRAPH = /\\[Pp]/g;
const STACK = /\\S([^;^/#]*)[\^/#]([^;]*);/gu;
const FORMAT = /\\[ACFHQTWfhqtwacp][^;\\]*;/gu;
const TOGGLE = /\\[LlOoKkNX]/g;

/** Replaces \U+XXXX escapes and %% control codes. */
export function decode(s) {
  return s
    .replace(UNICODE, (_, hex) => {
      const code = parseInt(hex, 16);
      return code >= 0xd800 && code <= 0xdfff ? '?' : String.fromCharCode(code);
    })
    .replace(DIAMETER, 'Ø')
    .replace(DEGREE, '°')
    .replace(PLUS_MINUS, '±')
    .replace(UNDERLINE, '')
    .replaceAll('%%%', '%');
}

/** Removes MTEXT formatting codes, keeping paragraph breaks as newlines and stacks as a/b. */
export function stripMtext(s) {
  return s
    .replaceAll('\\\\', '\u0001')
    .replaceAll('\\{', '\u0002')
    .replaceAll('\\}', '\u0003')
    .replace(PARAGRAPH, '\n')
    .replace(STACK, '$1/$2')
    .replace(FORMAT, '')
    .replace(TOGGLE, '')
    .replaceAll('\\~', ' ')
    .replace(/[{}]/g, '')
    .replaceAll('\u0001', '\\')
    .replaceAll('\u0002', '{')
    .replaceAll('\u0003', '}');
}

/** Rough word wrap to the MTEXT reference width (average Arial glyph ≈ 0.55 × height) */
function wrap(text, width, height) {
  if (width <= 0) return text;
  const maxChars = Math.max(toI32(width / (height * 0.55)), 4);
  const output = [];
  for (const para of text.split('\n')) {
    let line = '';
    let len = 0; // in characters
    for (const word of para.split(' ')) {
      const wlen = [...word].length;
      if (len > 0 && len + 1 + wlen > maxChars) {
        output.push(line);
        line = '';
        len = 0;
      }
      if (len > 0) {
        line += ' ';
        len++;
      }
      line += word;
      len += wlen;
    }
    output.push(line);
  }
  return output.join('\n');
}
