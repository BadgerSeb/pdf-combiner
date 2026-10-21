// Turns each supported file into PDF bytes in the browser, and reads its page sizes.
// Word, Excel, PowerPoint, SOLIDWORKS, DWG and web pages need programs a browser can't use,
// so those point to the desktop app.

import { PDFDocument, StandardFonts, rgb, degrees } from '../vendor/pdf-lib.esm.min.js';
import { openPdf, closePdf, pageSizes, renderPage } from './pdfjs.js';

export const KINDS = [
  { via: 'pdf', label: 'PDF', color: '#dc2626', ext: ['pdf'] },
  { via: 'image', label: 'Image', color: '#7c3aed', ext: ['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'svg'] },
  { via: 'text', label: 'Text file', color: '#4b5563', ext: ['txt', 'log', 'md', 'xml', 'json', 'ini', 'nc', 'csv'] },
  { via: 'dxf', label: 'DXF drawing', color: '#0e7490', ext: ['dxf'] },
  { via: 'desktop', label: 'Word document', color: '#2563eb', ext: ['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt'] },
  { via: 'desktop', label: 'Excel workbook', color: '#16803d', ext: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods'] },
  { via: 'desktop', label: 'PowerPoint', color: '#ea580c', ext: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp'] },
  { via: 'desktop', label: 'SOLIDWORKS drawing', color: '#be123c', ext: ['slddrw'] },
  { via: 'desktop', label: 'DWG drawing', color: '#0e7490', ext: ['dwg'] },
  { via: 'desktop', label: 'Web page', color: '#0d9488', ext: ['htm', 'html', 'mht', 'mhtml'] },
];

export function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function kindOf(name) {
  const ext = extOf(name);
  return KINDS.find(k => k.ext.includes(ext)) || null;
}

export const ACCEPT = KINDS.flatMap(k => k.ext.map(e => '.' + e)).join(',');

/** Converts one file. Resolves to { bytes, pages:[{width,height,included,rotation}], note }. */
export async function convert(file, progress) {
  const kind = kindOf(file.name);
  if (!kind) throw new Error("This kind of file isn't supported.");
  if (kind.via === 'desktop') {
    throw new Error(`${kind.label}s need the PDF Combiner desktop app (or save it as a PDF first).`);
  }
  let bytes;
  let note = null;
  if (kind.via === 'pdf') {
    progress('Reading…');
    ({ bytes, note } = await preparePdf(new Uint8Array(await file.arrayBuffer())));
  } else if (kind.via === 'image') {
    progress('Converting…');
    bytes = await imageToPdf(file);
  } else if (kind.via === 'text') {
    progress('Converting…');
    bytes = await textToPdf(file);
  } else if (kind.via === 'dxf') {
    progress('Drawing…');
    const { dxfToPdf } = await import('./dxf/index.js');
    bytes = await dxfToPdf(new Uint8Array(await file.arrayBuffer()), file.name);
  }
  const doc = await openPdf(bytes);
  try {
    const sizes = await pageSizes(doc);
    if (sizes.length === 0) throw new Error('This PDF has no pages.');
    return { bytes, note, pages: sizes.map(s => ({ ...s, included: true, rotation: 0 })) };
  } finally {
    await closePdf(doc);
  }
}

// ---------------------------------------------------------------- PDFs

/** PDFs are used as they are; ones that can't be merged (usually protected) are rebuilt from page images. */
async function preparePdf(bytes) {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return { bytes, note: null };
  } catch (e) {
    let doc;
    try {
      doc = await openPdf(bytes);
    } catch (e2) {
      if (e2?.name === 'PasswordException') throw new Error('This PDF needs a password to open.');
      throw new Error("This file isn't a PDF that can be read.");
    }
    try {
      const out = await PDFDocument.create();
      const sizes = await pageSizes(doc);
      for (let i = 0; i < sizes.length; i++) {
        const canvas = await renderPage(doc, i, Math.min(4000, Math.round(sizes[i].width / 72 * 200)));
        const jpg = await out.embedJpg(await canvasBytes(canvas, 'image/jpeg', 0.88));
        const page = out.addPage([sizes[i].width, sizes[i].height]);
        page.drawImage(jpg, { x: 0, y: 0, width: sizes[i].width, height: sizes[i].height });
      }
      return { bytes: await out.save(), note: 'Protected PDF, copied as images' };
    } finally {
      await closePdf(doc);
    }
  }
}

// ---------------------------------------------------------------- images

export async function canvasBytes(canvas, type, quality) {
  const blob = await new Promise(r => canvas.toBlob(r, type, quality));
  if (!blob) throw new Error("The picture couldn't be encoded.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Page size and placement for one image: a Letter page turned to match, the image fitted inside
 *  a small margin and never blown up past its real size. */
function imagePage(pxW, pxH, dpiX, dpiY) {
  if (!(dpiX >= 50 && dpiX <= 2400)) dpiX = 96;
  if (!(dpiY >= 50 && dpiY <= 2400)) dpiY = 96;
  const w = pxW * 72 / dpiX, h = pxH * 72 / dpiY;
  const [pageW, pageH] = w > h ? [792, 612] : [612, 792];
  const margin = 18;
  const scale = Math.min((pageW - 2 * margin) / w, (pageH - 2 * margin) / h, 1);
  const iw = w * scale, ih = h * scale;
  return { pageW, pageH, x: (pageW - iw) / 2, y: (pageH - ih) / 2, width: iw, height: ih };
}

/** Resolution stored in a JPEG (JFIF density) or PNG (pHYs), if any */
function storedDpi(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let p = 2;
    while (p + 4 < bytes.length && bytes[p] === 0xff) {
      const marker = bytes[p + 1], len = v.getUint16(p + 2);
      if (marker === 0xe0 && bytes[p + 4] === 0x4a && bytes[p + 5] === 0x46) {
        const unit = bytes[p + 11], x = v.getUint16(p + 12), y = v.getUint16(p + 14);
        if (unit === 1) return [x, y];
        if (unit === 2) return [x * 2.54, y * 2.54];
        return null;
      }
      if (marker === 0xda) break;
      p += 2 + len;
    }
  } else if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    let p = 8;
    while (p + 8 < bytes.length) {
      const len = v.getUint32(p);
      const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      if (type === 'pHYs' && bytes[p + 16] === 1) return [v.getUint32(p + 8) * 0.0254, v.getUint32(p + 12) * 0.0254];
      if (type === 'IDAT') break;
      p += 12 + len;
    }
  }
  return null;
}

/** EXIF orientation of a JPEG (1 when there is none) */
function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 2;
  while (p + 4 < bytes.length && bytes[p] === 0xff) {
    const marker = bytes[p + 1], len = v.getUint16(p + 2);
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(p + 4, p + 8)) === 'Exif') {
      const t = p + 10, little = v.getUint16(t) === 0x4949;
      const ifd = t + v.getUint32(t + 4, little);
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little);
      }
      return 1;
    }
    if (marker === 0xda) break;
    p += 2 + len;
  }
  return 1;
}

async function decodeToCanvas(file, scale = 1) {
  if (extOf(file.name) === 'svg') {
    // SVG: drawn by the browser at three times its size so it stays sharp on paper
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 800, h = img.naturalHeight || 600;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * 3);
      canvas.height = Math.round(h * 3);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return { canvas, dpi: [288, 288] };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return { canvas, dpi: null };
}

let utifLoaded;
function loadUtif() {
  utifLoaded ??= new Promise((resolve, reject) => {
    if (self.UTIF) return resolve(self.UTIF);
    const s = document.createElement('script');
    s.src = new URL('../vendor/UTIF.js', import.meta.url).href;
    s.onload = () => resolve(self.UTIF);
    s.onerror = () => reject(new Error("The TIFF reader couldn't be loaded."));
    document.head.appendChild(s);
  });
  return utifLoaded;
}

/** Each image (or TIFF page) on its own Letter page */
async function imageToPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = extOf(file.name);
  const out = await PDFDocument.create();
  out.setCreator('PDF Combiner');
  const place = (img, pxW, pxH, dpi) => {
    const l = imagePage(pxW, pxH, dpi?.[0], dpi?.[1]);
    out.addPage([l.pageW, l.pageH]).drawImage(img, { x: l.x, y: l.y, width: l.width, height: l.height });
  };

  if (ext === 'tif' || ext === 'tiff') {
    const UTIF = await loadUtif();
    const ifds = UTIF.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pages = ifds.filter(f => f.t256 && f.t257);
    if (pages.length === 0) throw new Error("This TIFF doesn't contain any pictures.");
    for (const ifd of pages) {
      UTIF.decodeImage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ifd);
      const rgba = UTIF.toRGBA8(ifd);
      const canvas = document.createElement('canvas');
      canvas.width = ifd.width;
      canvas.height = ifd.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, ifd.width * ifd.height * 4), ifd.width, ifd.height), 0, 0);
      const res = (tag) => (Array.isArray(tag) ? tag[0] : tag);
      let dpi = ifd.t282 && ifd.t283 ? [res(ifd.t282), res(ifd.t283)] : null;
      if (dpi && ifd.t296 && res(ifd.t296) === 3) dpi = dpi.map(d => d * 2.54);
      place(await out.embedPng(await canvasBytes(canvas, 'image/png')), canvas.width, canvas.height, dpi);
    }
    return out.save();
  }

  // JPEG and PNG go in unchanged when they can (no quality lost); everything else is redrawn
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (isJpeg && jpegOrientation(bytes) === 1) {
    const img = await out.embedJpg(bytes);
    place(img, img.width, img.height, storedDpi(bytes));
    return out.save();
  }
  if (isPng) {
    try {
      const img = await out.embedPng(bytes);
      place(img, img.width, img.height, storedDpi(bytes));
      return out.save();
    } catch { /* unusual PNG: redraw it below */ }
  }
  let decoded;
  try {
    decoded = await decodeToCanvas(file);
  } catch {
    throw new Error("This picture couldn't be read.");
  }
  const { canvas, dpi } = decoded;
  place(await out.embedPng(await canvasBytes(canvas, 'image/png')), canvas.width, canvas.height, dpi ?? storedDpi(bytes));
  return out.save();
}

// ---------------------------------------------------------------- text

function readText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Characters the standard PDF fonts can show (Windows-1252); anything else becomes "?" */
function winAnsi(s) {
  const extra = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  return s.replace(/[^\x20-\x7e\xa0-\xff]/g, c => (extra.includes(c) ? c : c === '\t' ? '    ' : '?'));
}

/** Text files: the file name as a heading, then the text in a fixed-width font, Letter pages */
async function textToPdf(file) {
  const text = readText(new Uint8Array(await file.arrayBuffer())).replace(/\r\n?/g, '\n');
  const out = await PDFDocument.create();
  out.setCreator('PDF Combiner');
  const mono = await out.embedFont(StandardFonts.Courier);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const [pw, ph, margin] = [612, 792, 43.2];
  const size = 9.5, lead = size * 1.25, width = pw - 2 * margin;
  const charW = mono.widthOfTextAtSize('M', size);
  const perLine = Math.max(10, Math.floor(width / charW));

  const lines = [];
  for (const raw of text.split('\n')) {
    const line = winAnsi(raw.replace(/\t/g, '    ')).replace(/\s+$/, '');
    if (line.length === 0) { lines.push(''); continue; }
    for (let i = 0; i < line.length; i += perLine) lines.push(line.slice(i, i + perLine));
  }

  let page, y;
  const newPage = (first) => {
    page = out.addPage([pw, ph]);
    y = ph - margin;
    if (first) {
      const title = winAnsi(file.name);
      page.drawText(title, { x: margin, y: y - 10, size: 10, font: bold, color: rgb(0, 0, 0) });
      page.drawLine({ start: { x: margin, y: y - 15 }, end: { x: pw - margin, y: y - 15 }, thickness: 0.75, color: rgb(0.6, 0.6, 0.6) });
      y -= 15 + 10 + lead;
    } else {
      y -= lead;
    }
  };
  newPage(true);
  for (const line of lines) {
    if (y < margin) newPage(false);
    if (line) page.drawText(line, { x: margin, y, size, font: mono, color: rgb(0, 0, 0) });
    y -= lead;
  }
  return out.save();
}

export { degrees };
