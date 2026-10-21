// SVG and EPS drawings, one file per page: the page's lines, curves, filled shapes and text as
// real vector shapes, from the same reading of the page as the DXF export. Pictures inside a
// page are left out; a page with nothing to draw (a scan) goes in as a picture instead.

import * as layout from './layout.js';
import { forEachPage } from './pages.js';
import { renderEach, pngOf } from './images.js';
import { xml, clean } from './excel.js';

const enc = new TextEncoder();
const n2 = (v) => String(Math.round(v * 100) / 100);
const hexColor = (c) => '#' + [c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Reads the pages, and renders the ones with nothing to draw. `raw` gives pixels instead of PNGs. */
async function readPages(items, dpi, progress, raw) {
  const pages = [];
  const want = new Set();
  await forEachPage(items, progress, (k, i, page) => {
    const text = layout.lines(page.glyphs, 0.25, null);
    const blank = !page.paths.length && !page.glyphs.some((g) => g.visible);
    if (blank) want.add(`${k}/${i}`);
    pages.push({ k, i, page, text, picture: null });
  });
  if (want.size) {
    await renderEach(items, dpi, progress, async (canvas, scale, k, i) => {
      const p = pages.find((x) => x.k === k && x.i === i);
      p.picture = raw
        ? { rgba: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, w: canvas.width, h: canvas.height }
        : { png: await pngOf(canvas, scale), w: canvas.width, h: canvas.height };
    }, (k, i) => want.has(`${k}/${i}`));
  }
  return pages;
}

// ------------------------------------------------------------ SVG

export async function toSvg(items, dpi, progress) {
  const pages = await readPages(items, dpi, progress, false);
  progress('Saving…');
  return { files: pages.map((p) => enc.encode(svgPage(p))), pages: pages.length };
}

function svgPage({ page, text, picture }) {
  const W = page.width, H = page.height;
  const out = [`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${n2(W / 72)}in" height="${n2(H / 72)}in" viewBox="0 0 ${n2(W)} ${n2(H)}">`];
  out.push(`<rect width="${n2(W)}" height="${n2(H)}" fill="#fff"/>`);
  if (picture) {
    let s = '';
    for (let i = 0; i < picture.png.length; i += 0x8000) s += String.fromCharCode(...picture.png.subarray(i, i + 0x8000));
    out.push(`<image width="${n2(W)}" height="${n2(H)}" href="data:image/png;base64,${btoa(s)}"/>`);
  }
  for (const p of page.paths) {
    const d = p.subpaths.map((s) => {
      const g0 = s.segs[0];
      let r = `M${n2(g0.x0)} ${n2(H - g0.y0)}`;
      for (const g of s.segs) {
        r += g.curve
          ? `C${n2(g.x1)} ${n2(H - g.y1)} ${n2(g.x2)} ${n2(H - g.y2)} ${n2(g.x3)} ${n2(H - g.y3)}`
          : `L${n2(g.x3)} ${n2(H - g.y3)}`;
      }
      return s.closed ? r + 'Z' : r;
    }).join('');
    const fill = p.filled ? hexColor(p.fillColor) : 'none';
    const stroke = p.stroked ? ` stroke="${hexColor(p.strokeColor)}" stroke-width="${n2(Math.max(0.25, p.lineWidth))}" stroke-linecap="round" stroke-linejoin="round"` : '';
    out.push(`<path d="${d}" fill="${fill}"${stroke}/>`);
  }
  for (const l of text) {
    for (const c of l.chunks) {
      const x = n2(c.pageX), y = n2(H - c.pageY);
      const turn = Math.abs(c.angle) > 0.01 ? ` transform="rotate(${n2(-c.angle)} ${x} ${y})"` : '';
      // text with no visible ink (the searchable layer of a scan) stays selectable but unseen
      const hidden = picture ? ' fill-opacity="0"' : '';
      out.push(`<text x="${x}" y="${y}" font-size="${n2(c.size)}" font-family="Arial, Helvetica, sans-serif" fill="${hexColor(c.color)}"${hidden}${turn} xml:space="preserve">${xml(clean(c.text))}</text>`);
    }
  }
  out.push('</svg>\n');
  return out.join('\n');
}

// ------------------------------------------------------------ EPS

export async function toEps(items, dpi, progress) {
  const pages = await readPages(items, Math.min(dpi, 150), progress, true);
  progress('Saving…');
  return { files: pages.map((p) => latin1(epsPage(p))), pages: pages.length };
}

function epsPage({ page, text, picture }) {
  const W = page.width, H = page.height;
  const rgb = (c) => `${n2(c.r / 255)} ${n2(c.g / 255)} ${n2(c.b / 255)} setrgbcolor`;
  const out = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(W)} ${Math.ceil(H)}`,
    `%%HiResBoundingBox: 0 0 ${n2(W)} ${n2(H)}`,
    '%%Creator: PDF Combiner',
    '%%LanguageLevel: 2',
    '%%EndComments',
    'save',
    '/HelveticaL /Helvetica findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall',
    '/Encoding ISOLatin1Encoding def currentdict end definefont pop',
    '1 setlinecap 1 setlinejoin',
    `1 1 1 setrgbcolor 0 0 ${n2(W)} ${n2(H)} rectfill`,
  ];
  if (picture) {
    const { rgba, w, h } = picture;
    out.push('gsave', `${n2(W)} ${n2(H)} scale`, `${w} ${h} 8 [${w} 0 0 -${h} 0 ${h}]`, 'currentfile /ASCIIHexDecode filter false 3 colorimage');
    const HEX = '0123456789abcdef';
    let line = '';
    const lines = [];
    for (let i = 0; i < w * h * 4; i += 4) {
      for (let c = 0; c < 3; c++) line += HEX[rgba[i + c] >> 4] + HEX[rgba[i + c] & 15];
      if (line.length >= 120) { lines.push(line); line = ''; }
    }
    lines.push(line + '>');
    out.push(lines.join('\n'), 'grestore');
  }
  for (const p of page.paths) {
    const parts = ['newpath'];
    for (const s of p.subpaths) {
      parts.push(`${n2(s.segs[0].x0)} ${n2(s.segs[0].y0)} moveto`);
      for (const g of s.segs) {
        parts.push(g.curve
          ? `${n2(g.x1)} ${n2(g.y1)} ${n2(g.x2)} ${n2(g.y2)} ${n2(g.x3)} ${n2(g.y3)} curveto`
          : `${n2(g.x3)} ${n2(g.y3)} lineto`);
      }
      if (s.closed) parts.push('closepath');
    }
    if (p.filled && p.stroked) parts.push(`gsave ${rgb(p.fillColor)} fill grestore`);
    else if (p.filled) parts.push(`${rgb(p.fillColor)} fill`);
    if (p.stroked) parts.push(`${rgb(p.strokeColor)} ${n2(Math.max(0.25, p.lineWidth))} setlinewidth stroke`);
    out.push(parts.join(' '));
  }
  if (!picture) {
    for (const l of text) {
      for (const c of l.chunks) {
        out.push(`gsave ${rgb(c.color)} /HelveticaL findfont ${n2(c.size)} scalefont setfont ${n2(c.pageX)} ${n2(c.pageY)} translate ${n2(c.angle)} rotate 0 0 moveto (${psString(c.text)}) show grestore`);
      }
    }
  }
  out.push('restore', 'showpage', '%%EOF', '');
  return out.join('\n');
}

/** A PostScript string body in Latin-1; other characters become "?". */
function psString(s) {
  let r = '';
  for (const ch of clean(s)) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') r += '\\' + ch;
    else if (c < 32 || c > 255) r += c > 255 ? '?' : ' ';
    else if (c > 126) r += '\\' + c.toString(8).padStart(3, '0');
    else r += ch;
  }
  return r;
}

function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
