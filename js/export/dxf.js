// DXF: writes an R12 DXF in inches. Lines and connected outlines become polylines (arcs kept as
// true arcs through bulges), whole circles become circles, text becomes text.

import * as layout from './layout.js';
import { forEachPage } from './pages.js';

export async function toDxf(items, progress) {
  const pages = [];
  await forEachPage(items, progress, (_item, _index, page) => pages.push(page));
  const dxf = new DxfWriter();
  let offset = 0;
  const multi = pages.length > 1;
  pages.forEach((page, n) => {
    dxf.addPage(page, offset, multi ? `P${n + 1} ` : '');
    offset += page.width / 72 + 1; // pages side by side, an inch apart
  });
  if (dxf.count === 0) {
    throw new Error(
      'No lines or text were found on the selected pages. They look like scans or pictures, ' +
      'and a DXF can only be made from pages drawn by a program (such as a PDF saved from SOLIDWORKS or AutoCAD).',
    );
  }
  progress('Saving…');
  return { bytes: new TextEncoder().encode(dxf.finish()), pages: pages.length };
}

/** Points to inches. */
const PT = 1 / 72;
/** Curve flattening tolerance, points. */
const FLAT_TOL = 0.15;

/** A polyline vertex; bulge (and the arc it came from) describe the segment that starts here. */
function V(x, y) {
  return { x, y, bulge: 0, cx: 0, cy: 0, r: 0, sweep: 0 };
}

export class DxfWriter {
  constructor() {
    this.entities = [];
    this.seen = new Set();
    this.layers = [];
    this.minX = Number.MAX_VALUE;
    this.minY = Number.MAX_VALUE;
    this.maxX = -Number.MAX_VALUE;
    this.maxY = -Number.MAX_VALUE;
    this.ox = 0;
    this.count = 0;
  }

  addPage(page, offsetInches, prefix) {
    this.ox = offsetInches;
    const lineLayer = `${prefix}Lines`, fillLayer = `${prefix}Fills`, textLayer = `${prefix}Text`;
    for (const p of page.paths) {
      const white = p.stroked ? isWhite(p.strokeColor) : isWhite(p.fillColor);
      if (white) continue;
      for (const s of p.subpaths) {
        if (!p.stroked && p.filled && this.thinBar(s, p.fillColor, lineLayer)) continue;
        const [layer, color] = p.stroked ? [lineLayer, p.strokeColor] : [fillLayer, p.fillColor];
        this.shape(s, layer, aci(color));
      }
    }
    for (const l of layout.lines(page.glyphs.filter((g) => g.visible), 0.6, null)) {
      for (const c of l.chunks) {
        const e = [];
        code(e, 0, 'TEXT');
        code(e, 8, this.layer(textLayer));
        code(e, 62, String(aci(c.color)));
        this.point(e, c.pageX, c.pageY, 10);
        code(e, 40, num(0.7 * c.size * PT));
        code(e, 1, escape(c.text));
        if (Math.abs(c.angle) > 0.01) code(e, 50, num(c.angle));
        this.add(e);
      }
    }
  }

  /** Table borders and underlines are often thin filled boxes; a single line suits CAD better. */
  thinBar(s, color, layer) {
    if (s.segs.length !== 4 || s.segs.some((g) => g.curve)) return false;
    const x0 = s.segs.reduce((m, g) => Math.min(m, g.x0), Number.MAX_VALUE);
    const x1 = s.segs.reduce((m, g) => Math.max(m, g.x0), -Number.MAX_VALUE);
    const y0 = s.segs.reduce((m, g) => Math.min(m, g.y0), Number.MAX_VALUE);
    const y1 = s.segs.reduce((m, g) => Math.max(m, g.y0), -Number.MAX_VALUE);
    if (s.segs.some((g) => !(near(g.x0, x0) || near(g.x0, x1)) || !(near(g.y0, y0) || near(g.y0, y1)))) return false;
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) > 1.5) return false;
    const e = [];
    code(e, 0, 'LINE');
    code(e, 8, this.layer(layer));
    code(e, 62, String(aci(color)));
    if (w >= h) {
      this.point(e, x0, (y0 + y1) / 2, 10);
      this.point(e, x1, (y0 + y1) / 2, 11);
    } else {
      this.point(e, (x0 + x1) / 2, y0, 10);
      this.point(e, (x0 + x1) / 2, y1, 11);
    }
    this.add(e);
    return true;
  }

  shape(s, layer, color) {
    // a whole circle drawn as Bézier arcs
    let total = 0;
    let allArcs = s.segs.length > 0;
    let c0x = 0, c0y = 0, r0 = 0;
    for (const g of s.segs) {
      const a = g.curve ? arc(g) : null;
      if (!a) {
        allArcs = false;
        break;
      }
      const [cx, cy, r, sweep] = a;
      if (r0 === 0) {
        c0x = cx; c0y = cy; r0 = r;
      } else if (Math.abs(cx - c0x) > 0.01 * r0 + 0.05 || Math.abs(cy - c0y) > 0.01 * r0 + 0.05 ||
        Math.abs(r - r0) > 0.01 * r0 + 0.05) {
        allArcs = false;
        break;
      }
      total += sweep;
    }
    if (allArcs && Math.abs(Math.abs(total) - 2 * Math.PI) < 0.05) {
      const e = [];
      code(e, 0, 'CIRCLE');
      code(e, 8, this.layer(layer));
      code(e, 62, String(color));
      this.point(e, c0x, c0y, 10);
      code(e, 40, num(r0 * PT));
      this.add(e);
      return;
    }

    const vs = [V(s.segs[0].x0, s.segs[0].y0)];
    for (const g of s.segs) {
      if (!g.curve) {
        vs.push(V(g.x3, g.y3));
        continue;
      }
      const a = arc(g);
      if (a) {
        const [cx, cy, r, sweep] = a;
        // pieces of the same circle in a row (some programs split every corner) become one arc
        if (vs.length >= 2) {
          const k = vs.length - 2;
          const prev = vs[k];
          const tol = 0.01 * r + 0.05;
          if (prev.sweep !== 0 && Math.sign(prev.sweep) === Math.sign(sweep) &&
            Math.abs(prev.sweep + sweep) <= 1.5 * Math.PI &&
            Math.abs(prev.cx - cx) < tol && Math.abs(prev.cy - cy) < tol && Math.abs(prev.r - r) < tol) {
            vs[k].sweep += sweep;
            vs[k].bulge = Math.tan(vs[k].sweep / 4);
            vs[k + 1] = V(g.x3, g.y3);
            continue;
          }
        }
        const last = vs.at(-1);
        last.bulge = Math.tan(sweep / 4);
        last.cx = cx; last.cy = cy; last.r = r; last.sweep = sweep;
        vs.push(V(g.x3, g.y3));
        continue;
      }
      const len = dist(g.x0, g.y0, g.x1, g.y1) + dist(g.x1, g.y1, g.x2, g.y2) + dist(g.x2, g.y2, g.x3, g.y3);
      let n = Math.ceil(Math.sqrt(len / FLAT_TOL));
      if (Number.isNaN(n)) n = 0;
      n = Math.min(64, Math.max(2, n));
      for (let k = 1; k <= n; k++) {
        const [px, py] = bez(g, k / n);
        vs.push(V(px, py));
      }
    }
    // drop repeated points
    const clean = [vs[0]];
    for (const v of vs.slice(1)) {
      const l = clean.at(-1);
      if (dist(v.x, v.y, l.x, l.y) > 0.01) clean.push(v);
      else if (v.bulge !== 0) {
        l.bulge = v.bulge; l.cx = v.cx; l.cy = v.cy; l.r = v.r; l.sweep = v.sweep;
      }
    }
    let closed = s.closed;
    if (clean.length > 2 && dist(clean[0].x, clean[0].y, clean.at(-1).x, clean.at(-1).y) <= 0.01) {
      clean.pop();
      closed = true;
    }
    if (clean.length < 2) return;

    const en = [];
    if (clean.length === 2 && !closed && clean[0].sweep !== 0) {
      // one open arc
      const a = clean[0];
      let a0 = Math.atan2(a.y - a.cy, a.x - a.cx) * (180 / Math.PI);
      let a1 = Math.atan2(clean[1].y - a.cy, clean[1].x - a.cx) * (180 / Math.PI);
      if (a.sweep < 0) [a0, a1] = [a1, a0];
      code(en, 0, 'ARC');
      code(en, 8, this.layer(layer));
      code(en, 62, String(color));
      this.point(en, a.cx, a.cy, 10);
      code(en, 40, num(a.r * PT));
      code(en, 50, num(a0));
      code(en, 51, num(a1));
      this.add(en);
      return;
    }
    if (clean.length === 2 && !closed && clean[0].bulge === 0) {
      code(en, 0, 'LINE');
      code(en, 8, this.layer(layer));
      code(en, 62, String(color));
      this.point(en, clean[0].x, clean[0].y, 10);
      this.point(en, clean[1].x, clean[1].y, 11);
      this.add(en);
      return;
    }
    const lay = this.layer(layer);
    code(en, 0, 'POLYLINE');
    code(en, 8, lay);
    code(en, 62, String(color));
    code(en, 66, '1');
    code(en, 10, '0');
    code(en, 20, '0');
    code(en, 30, '0');
    code(en, 70, closed ? '1' : '0');
    for (const v of clean) {
      code(en, 0, 'VERTEX');
      code(en, 8, lay);
      this.point(en, v.x, v.y, 10);
      if (Math.abs(v.bulge) > 1e-9) code(en, 42, num(v.bulge));
    }
    code(en, 0, 'SEQEND');
    code(en, 8, lay);
    this.add(en);
  }

  add(parts) {
    const entity = parts.join('');
    if (this.seen.has(entity)) return;
    this.entities.push(entity);
    this.seen.add(entity);
    this.count += 1;
  }

  layer(name) {
    if (!this.layers.includes(name)) this.layers.push(name);
    return name;
  }

  point(e, x, y, codeX) {
    const ix = x * PT + this.ox, iy = y * PT;
    this.minX = Math.min(this.minX, ix);
    this.maxX = Math.max(this.maxX, ix);
    this.minY = Math.min(this.minY, iy);
    this.maxY = Math.max(this.maxY, iy);
    code(e, codeX, num(ix));
    code(e, codeX + 10, num(iy));
    code(e, codeX + 20, '0');
  }

  /** The whole file. */
  finish() {
    const o = [];
    code(o, 0, 'SECTION');
    code(o, 2, 'HEADER');
    code(o, 9, '$ACADVER');
    code(o, 1, 'AC1009');
    code(o, 9, '$INSUNITS');
    code(o, 70, '1');
    code(o, 9, '$EXTMIN');
    code(o, 10, num(this.minX));
    code(o, 20, num(this.minY));
    code(o, 30, '0');
    code(o, 9, '$EXTMAX');
    code(o, 10, num(this.maxX));
    code(o, 20, num(this.maxY));
    code(o, 30, '0');
    code(o, 0, 'ENDSEC');
    code(o, 0, 'SECTION');
    code(o, 2, 'TABLES');
    code(o, 0, 'TABLE');
    code(o, 2, 'LTYPE');
    code(o, 70, '1');
    code(o, 0, 'LTYPE');
    code(o, 2, 'CONTINUOUS');
    code(o, 70, '0');
    code(o, 3, 'Solid line');
    code(o, 72, '65');
    code(o, 73, '0');
    code(o, 40, '0.0');
    code(o, 0, 'ENDTAB');
    code(o, 0, 'TABLE');
    code(o, 2, 'LAYER');
    code(o, 70, String(this.layers.length));
    for (const l of this.layers) {
      code(o, 0, 'LAYER');
      code(o, 2, l);
      code(o, 70, '0');
      code(o, 62, '7');
      code(o, 6, 'CONTINUOUS');
    }
    code(o, 0, 'ENDTAB');
    code(o, 0, 'TABLE');
    code(o, 2, 'STYLE');
    code(o, 70, '1');
    code(o, 0, 'STYLE');
    code(o, 2, 'STANDARD');
    code(o, 70, '0');
    code(o, 40, '0.0');
    code(o, 41, '1.0');
    code(o, 50, '0.0');
    code(o, 71, '0');
    code(o, 42, '0.2');
    code(o, 3, 'txt');
    code(o, 4, '');
    code(o, 0, 'ENDTAB');
    code(o, 0, 'ENDSEC');
    code(o, 0, 'SECTION');
    code(o, 2, 'ENTITIES');
    o.push(...this.entities);
    code(o, 0, 'ENDSEC');
    code(o, 0, 'EOF');
    return o.join('');
  }
}

function isWhite(c) {
  return c.r > 245 && c.g > 245 && c.b > 245;
}

function near(a, b) {
  return Math.abs(a - b) < 0.01;
}

function dist(ax, ay, bx, by) {
  return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}

function bez(g, t) {
  const u = 1 - t;
  return [
    u * u * u * g.x0 + 3 * u * u * t * g.x1 + 3 * u * t * t * g.x2 + t * t * t * g.x3,
    u * u * u * g.y0 + 3 * u * u * t * g.y1 + 3 * u * t * t * g.y2 + t * t * t * g.y3,
  ];
}

/**
 * Is this Bézier a circular arc (as CAD programs write them)? Returns [cx, cy, r, sweep], the
 * sweep signed, counter-clockwise positive; or null.
 */
export function arc(g) {
  const [mx, my] = bez(g, 0.5);
  const ax = g.x0, ay = g.y0, bx = mx, by = my, qx = g.x3, qy = g.y3;
  const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, q2 = qx * qx + qy * qy;
  const cx = (a2 * (by - qy) + b2 * (qy - ay) + q2 * (ay - by)) / d;
  const cy = (a2 * (qx - bx) + b2 * (ax - qx) + q2 * (bx - ax)) / d;
  const r = dist(ax, ay, cx, cy);
  if (!(r >= 0.05 && r <= 1e5)) return null;
  const tol = 0.003 * r + 0.02;
  for (const t of [0.25, 0.75]) {
    const [px, py] = bez(g, t);
    if (Math.abs(dist(px, py, cx, cy) - r) > tol) return null;
  }
  if (Math.abs(dist(qx, qy, cx, cy) - r) > tol) return null;
  const cross = (bx - ax) * (qy - by) - (by - ay) * (qx - bx);
  const a0 = Math.atan2(ay - cy, ax - cx), a1 = Math.atan2(qy - cy, qx - cx);
  let sw = a1 - a0;
  if (cross > 0) {
    while (sw <= 0) sw += 2 * Math.PI;
  } else {
    while (sw >= 0) sw -= 2 * Math.PI;
  }
  if (Math.abs(sw) > Math.PI * 1.1) return null;
  return [cx, cy, r, sw];
}

/** Round half to even, as Rust's f64::round_ties_even. */
function roundTiesEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Rounded to 6 places, without trailing zeros (as .NET's "0.######"). */
export function num(v) {
  const r = roundTiesEven(v * 1e6) / 1e6;
  let s = r.toFixed(6);
  s = s.replace(/0+$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s === '-0' ? '0' : s;
}

function code(e, c, value) {
  e.push(`${c}\r\n${value}\r\n`);
}

/** Nearest AutoCAD color index; black and white both map to 7 (shown black on white, white on black). */
export function aci(c) {
  const PAL = [
    [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255], [5, 0, 0, 255],
    [6, 255, 0, 255], [8, 128, 128, 128], [9, 192, 192, 192], [7, 0, 0, 0],
  ];
  const { r, g, b } = c;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 40) return max < 90 ? 7 : max < 170 ? 8 : 9;
  let best = 7, bestD = Number.MAX_SAFE_INTEGER;
  for (const p of PAL) {
    const d = (r - p[1]) * (r - p[1]) + (g - p[2]) * (g - p[2]) + (b - p[3]) * (b - p[3]);
    if (d < bestD) {
      bestD = d;
      best = p[0];
    }
  }
  return best;
}

/** DXF text: degree, plus-minus and diameter as %% codes, other non-ASCII as \U+XXXX. */
export function escape(s) {
  let sb = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    const c = s[i];
    if (c === '°') sb += '%%d';
    else if (c === '±') sb += '%%p';
    else if (c === '⌀' || c === 'Ø' || c === 'ø') sb += '%%c';
    else if (ch < 32) continue;
    else if (ch < 127) sb += c;
    else sb += `\\U+${ch.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return sb;
}
