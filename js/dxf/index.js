// DXF reading and drawing: turns a .dxf file into a one-page vector PDF with a caption, the way
// the desktop app's `dxf_to_pdf` (crates/dxf, itself a port of Dxf.cs) does.
//
// Reads ASCII DXF files and draws them, as vectors, onto a Letter page fitted to the drawing.
// Supports LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE/POLYLINE (with bulges), SPLINE, TEXT, MTEXT,
// INSERT (blocks, arrays, attributes), DIMENSION, LEADER, SOLID, TRACE and 3DFACE.

import { PDFDocument, PDFName } from '../../vendor/pdf-lib.esm.min.js';
import { Drawing } from './model.js';
import { Scene } from './scene.js';
import { encodeWinAnsi, textWidth } from './font.js';

/**
 * Draws a DXF (file bytes) into a one-page vector PDF fitted to Letter, with the caption.
 * Throws Error with a plain-English message on bad files.
 */
export async function dxfToPdf(bytes, fileName) {
  const { content, pageW, pageH } = dxfContent(bytes, fileName);
  return save(content, pageW, pageH);
}

/** Reads and lays out a DXF: the page's content stream (text) and the page size in points. */
export function dxfContent(bytes, fileName) {
  const dwg = Drawing.fromBytes(bytes);
  const scene = new Scene(dwg);
  scene.build();
  if (scene.strokes.length === 0 && scene.texts.length === 0) {
    throw new Error("This DXF doesn't contain anything that can be drawn.");
  }
  return layout(scene, dwg, fileName ?? '');
}

/** A PDF number: up to 3 decimals, no trailing zeros. */
const num = (v) => formatDecimals(v, 3);

/**
 * Formats like .NET's "0.###" custom format (`decimals` optional digits, rounded half away
 * from zero).
 */
export function formatDecimals(v, decimals) {
  const p = 10 ** decimals;
  const scaled = v * p;
  const r = (Math.sign(scaled) * Math.round(Math.abs(scaled))) / p;
  let s = r.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

const color = (c) => c.map((v) => num(v / 255)).join(' ');

/** A PDF literal string from WinAnsi bytes. */
function pdfString(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
    else s += '\\' + b.toString(8).padStart(3, '0');
  }
  return s + ')';
}

/** One line of text with its baseline-left at (x, y) in the current coordinate space. */
const showText = (font, size, x, y, bytes) =>
  `BT /${font} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfString(bytes)} Tj ET\n`;

function layout(scene, dwg, name) {
  const [minX, minY, maxX, maxY] = scene.extents(true);
  const w = Math.max(maxX - minX, 1e-9);
  const h = Math.max(maxY - minY, 1e-9);
  const landscape = w >= h;
  const [pageW, pageH] = landscape ? [792, 612] : [612, 792];

  const [margin, band] = [36, 30];
  const areaW = pageW - 2 * margin;
  const areaH = pageH - 2 * margin - band;
  const k = Math.min(areaW / w, areaH / h);
  const ox = margin + (areaW - w * k) / 2;
  const oy = margin + (areaH - h * k) / 2;
  // drawing coordinates to PDF user space (the layout above is measured from the page top)
  const map = (x, y) => [ox + (x - minX) * k, pageH - (oy + (maxY - y) * k)];

  let out = '0.5 w 1 J 1 j\n';
  out += strokes(scene, map);
  out += texts(scene, map, k);
  out += caption(scene, dwg, name, pageW, pageH, margin, band);
  return { content: out, pageW, pageH };
}

function strokes(scene, map) {
  let out = '';
  for (const s of scene.strokes) {
    if (s.points.length < 2) continue;
    const c = color(s.color);
    out += `${c} RG\n`;
    s.points.forEach((p, i) => {
      const [x, y] = map(p.x, p.y);
      out += `${num(x)} ${num(y)} ${i === 0 ? 'm' : 'l'}\n`;
    });
    const many = s.points.length > 2;
    if (s.filled && many) out += `${c} rg b\n`;
    else if (s.closed && many) out += 's\n';
    else out += 'S\n';
  }
  return out;
}

function texts(scene, map, k) {
  let out = '';
  for (const t of scene.texts) {
    const size = (t.height * k) / 0.72; // DXF height is roughly the cap height
    if (size < 0.5) continue;
    const lineStep = t.height * k * 1.667;
    const blockH = t.height * k + lineStep * (t.lines.length - 1);
    const capH = t.height * k;
    // baseline of the first line below the anchor (measured downwards, as on the page)
    const y0 =
      t.vAlign === 3 ? capH
      : t.vAlign === 2 ? capH - blockH / 2
      : t.vAlign === 1 ? -(blockH - capH) - capH * 0.25
      : -(blockH - capH);
    const [ax, ay] = map(t.x, t.y);
    const r = t.rotation * (Math.PI / 180);
    const [sin, cos] = [Math.sin(r), Math.cos(r)];
    const wf = Math.abs(t.widthFactor - 1) > 0.01 ? t.widthFactor : 1;
    out += `q ${color(t.color)} rg ${num(wf * cos)} ${num(wf * sin)} ${num(-sin)} ${num(cos)} ${num(ax)} ${num(ay)} cm\n`;
    t.lines.forEach((line, i) => {
      const bytes = encodeWinAnsi(line);
      const lw = textWidth(bytes, size, false);
      const x = t.hAlign === 1 ? -lw / 2 : t.hAlign === 2 ? -lw : 0;
      out += showText('F1', size, x, -(y0 + i * lineStep), bytes);
    });
    out += 'Q\n';
  }
  return out;
}

/** Title band: file name, overall size, scale. */
function caption(scene, dwg, name, pageW, pageH, margin, band) {
  const by = pageH - margin - band + 12;
  const ruleY = num(pageH - (by - 8));
  let out = `0 J 0 j ${color([160, 160, 160])} RG ${num(margin)} ${ruleY} m ${num(pageW - margin)} ${ruleY} l S\n`;
  out += '0 0 0 rg\n';
  out += showText('F2', 9, margin, pageH - (by + 8), encodeWinAnsi(name));
  // size of the geometry itself (text such as notes and title lines is left out)
  const [gx0, gy0, gx1, gy1] = scene.extents(false);
  const units = dwg.unitName();
  const decimals = dwg.units === 4 || dwg.units === 5 ? 1 : 3;
  const info = encodeWinAnsi(
    `Size ${formatDecimals(gx1 - gx0, decimals)} × ${formatDecimals(gy1 - gy0, decimals)}` +
      `${units ? ' ' + units : ''}   ·   not to scale (fitted to page)`,
  );
  const iw = textWidth(info, 8, false);
  out += `${color([105, 105, 105])} rg\n`; // DimGray
  out += showText('F1', 8, pageW - margin - iw, pageH - (by + 8), info);
  return out;
}

/** Writes a one-page PDF with the given content stream and the two Helvetica fonts. */
async function save(content, pageW, pageH) {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const font = (base) =>
    ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding' }));
  const resources = ctx.obj({
    Font: { F1: font('Helvetica'), F2: font('Helvetica-Bold') },
    ProcSet: ['PDF', 'Text'],
  });
  const ascii = Uint8Array.from(content, (ch) => ch.charCodeAt(0)); // the stream is pure ASCII
  const stream = ctx.register(ctx.flateStream(ascii));
  const page = doc.addPage([pageW, pageH]);
  page.node.set(PDFName.of('Resources'), resources);
  page.node.set(PDFName.of('Contents'), stream);
  return doc.save();
}
