// Saves the selected pages as pictures: one file per page, except TIFF, which holds every page.

import { openPdf, renderPage } from '../pdfjs.js';
import { GIFEncoder, quantize, applyPalette } from '../../vendor/gifenc.js';
import { fileStem, fileExtension } from './pages.js';
import { writeAvif } from './avif.js';

export const IMAGE_KINDS = Object.freeze([
  { name: 'PNG', ext: 'png', mime: 'image/png', oneFile: false },
  { name: 'JPEG', ext: 'jpg', mime: 'image/jpeg', oneFile: false },
  { name: 'BMP', ext: 'bmp', mime: 'image/bmp', oneFile: false },
  { name: 'GIF', ext: 'gif', mime: 'image/gif', oneFile: false },
  { name: 'TIFF', ext: 'tif', mime: 'image/tiff', oneFile: true },
  { name: 'WebP', ext: 'webp', mime: 'image/webp', oneFile: false },
  { name: 'AVIF', ext: 'avif', mime: 'image/avif', oneFile: false },
  { name: 'Photoshop', ext: 'psd', mime: 'image/vnd.adobe.photoshop', oneFile: false },
  { name: 'TGA', ext: 'tga', mime: 'image/x-tga', oneFile: false },
  { name: 'PPM', ext: 'ppm', mime: 'image/x-portable-pixmap', oneFile: false },
  { name: 'Icon', ext: 'ico', mime: 'image/x-icon', oneFile: false },
].map(Object.freeze));

export const RESOLUTIONS = Object.freeze([100, 150, 200, 300, 600]);

/** A 36 x 48 in sheet at 600 dpi would need gigabytes. */
const MAX_PIXELS = 80e6;
const JPEG_QUALITY = 0.92;
const WEBP_QUALITY = 0.92;

/**
 * The files a save writes: `baseName` itself, or "Name - 01.png", "Name - 02.png", … for
 * several pages (not for one-file kinds).
 */
export function targetNames(baseName, pages, kind) {
  if (pages <= 1 || kind.oneFile) return [baseName];
  const slash = Math.max(baseName.lastIndexOf('/'), baseName.lastIndexOf('\\'));
  const dir = baseName.slice(0, slash + 1);
  const stem = fileStem(baseName), ext = fileExtension(baseName);
  const digits = Math.max(2, String(pages).length);
  return Array.from({ length: pages }, (_, i) => `${dir}${stem} - ${String(i + 1).padStart(digits, '0')}.${ext}`);
}

/**
 * Renders the included pages at `dpi` and saves them as pictures. Returns the files in page
 * order (one for TIFF) and the number of pages; name them with targetNames().
 */
export async function saveImages(items, kind, dpi, progress) {
  const files = [];
  const tiffPages = [];
  const pages = await renderEach(items, dpi, progress, async (canvas, scale) => {
    if (kind.oneFile) tiffPages.push(tiffPage(canvas, scale));
    else files.push(await writeOne(canvas, scale, kind));
  });
  if (kind.oneFile) files.push(writeTiff(tiffPages));
  return { files, pages };
}

/**
 * Renders the included pages (or only those `want(itemIndex, pageIndex)` picks) at `dpi`, in
 * order, and hands each canvas, the resolution it was made at, and its item and page index to
 * `f`. The canvas is freed afterwards. Returns the number of pages rendered.
 */
export async function renderEach(items, dpi, progress, f, want = () => true) {
  const pages = items.flatMap((it, k) => it.pages.map((p, i) => [k, i, p]).filter(([, i, p]) => p.included && want(k, i)));
  if (!pages.length) throw new Error('No pages are selected.');
  let open = null; // [item index, pdf.js document]
  try {
    for (let n = 0; n < pages.length; n++) {
      const [k, index, info] = pages[n];
      progress(`Saving page ${n + 1} of ${pages.length}…`);
      if (!open || open[0] !== k) {
        if (open) await closePdf(open[1]);
        open = null;
        open = [k, await openPdf(items[k].bytes)];
      }
      const { canvas, scale } = await render(open[1], info, index, dpi);
      await f(canvas, scale, k, index);
      canvas.width = canvas.height = 0; // let the browser have the memory back
    }
  } finally {
    if (open) await closePdf(open[1]);
  }
  return pages.length;
}

/** A PNG of a canvas, carrying its resolution. */
export async function pngOf(canvas, dpi) {
  return setPngDpi(new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer()), dpi);
}

/** Lets pdf.js free a document (and its worker side). */
async function closePdf(doc) {
  try {
    if (typeof doc.destroy === 'function') await doc.destroy();
    else await doc.loadingTask?.destroy();
  } catch {
    // nothing more to free
  }
}

/**
 * Renders one page at `dpi` (less for huge sheets), on white and turned by the page's extra
 * rotation. Returns the canvas and the resolution it was made at.
 */
async function render(doc, info, index, dpi) {
  const inchesW = info.width / 72, inchesH = info.height / 72;
  let scale = dpi;
  if (inchesW * inchesH * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (inchesW * inchesH));
  const rotation = ((info.rotation % 360) + 360) % 360;
  // renderPage takes the width of the turned picture
  const across = rotation % 180 === 0 ? inchesW : inchesH;
  const canvas = await renderPage(doc, index, Math.max(1, Math.round(across * scale)), rotation);
  return { canvas, scale };
}

function pixelsPerMeter(dpi) {
  return Math.round(dpi / 0.0254);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the picture (the page may be too big)."))), type, quality);
  });
}

/** Opaque RGBA pixels of a canvas. */
function pixels(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
}

async function writeOne(canvas, dpi, kind) {
  const { width: w, height: h } = canvas;
  switch (kind.ext) {
    case 'png': {
      const png = new Uint8Array(await (await toBlob(canvas, 'image/png')).arrayBuffer());
      return setPngDpi(png, dpi);
    }
    case 'jpg': {
      const jpg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', JPEG_QUALITY)).arrayBuffer());
      return setJpegDpi(jpg, dpi);
    }
    case 'bmp':
      return writeBmp(pixels(canvas), w, h, dpi);
    case 'gif': {
      const rgba = pixels(canvas);
      const palette = quantize(rgba, 256);
      const index = applyPalette(rgba, palette);
      const gif = GIFEncoder();
      gif.writeFrame(index, w, h, { palette });
      gif.finish();
      return gif.bytes();
    }
    case 'webp': {
      if (w > 16383 || h > 16383) {
        throw new Error(`This page is too big for a WebP picture at ${Math.round(dpi)} dpi (WebP allows at most 16383 pixels a side). Pick a lower resolution.`);
      }
      const blob = await toBlob(canvas, 'image/webp', WEBP_QUALITY);
      if (blob.type !== 'image/webp') throw new Error("This browser can't make WebP images.");
      return new Uint8Array(await blob.arrayBuffer());
    }
    case 'avif':
      return writeAvif(canvas);
    case 'psd':
      if (w > 30000 || h > 30000) {
        throw new Error(`This page is too big for a Photoshop file at ${Math.round(dpi)} dpi (at most 30000 pixels a side). Pick a lower resolution.`);
      }
      return writePsd(pixels(canvas), w, h, dpi);
    case 'tga':
      if (w > 65535 || h > 65535) throw new Error('This page is too big for a TGA picture at this resolution. Pick a lower resolution.');
      return writeTga(pixels(canvas), w, h);
    case 'ppm':
      return writePpm(pixels(canvas), w, h);
    case 'ico':
      return writeIco(canvas);
    default:
      throw new Error(`Unknown picture type: ${kind.ext}`);
  }
}

// ------------------------------------------------------------ PNG and JPEG resolution

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The PNG with a pHYs chunk (pixels per meter) right after IHDR; an existing one is dropped. */
export function setPngDpi(png, dpi) {
  const ppm = pixelsPerMeter(dpi);
  const chunk = new Uint8Array(21);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  v.setUint32(8, ppm);
  v.setUint32(12, ppm);
  chunk[16] = 1; // unit: meter
  v.setUint32(17, crc32(chunk.subarray(4, 17)));
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [png.subarray(0, 8)];
  for (let p = 8; p + 12 <= png.length; ) {
    const len = pv.getUint32(p);
    const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
    const end = p + 12 + len;
    if (type !== 'pHYs') parts.push(png.subarray(p, end));
    if (type === 'IHDR') parts.push(chunk);
    p = end;
  }
  return concat(parts);
}

/** The JPEG with its JFIF header saying `dpi` (one is added when missing). */
export function setJpegDpi(jpg, dpi) {
  const d = Math.min(65535, Math.max(1, Math.round(dpi)));
  const isJfif = jpg[2] === 0xff && jpg[3] === 0xe0 && String.fromCharCode(...jpg.subarray(6, 11)) === 'JFIF\0';
  if (isJfif) {
    const out = jpg.slice();
    out[13] = 1; // dots per inch
    out[14] = d >> 8; out[15] = d & 255;
    out[16] = d >> 8; out[17] = d & 255;
    return out;
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
  return concat([jpg.subarray(0, 2), app0, jpg.subarray(2)]);
}

// ------------------------------------------------------------ BMP

/** A 24-bit Windows bitmap, bottom-up, with its resolution in pixels per meter. */
export function writeBmp(rgba, w, h, dpi) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const imageSize = row * h;
  if (54 + imageSize > 0xffffffff) {
    throw new Error('This page is too big for a bitmap at this resolution. Pick a lower resolution.');
  }
  const ppm = pixelsPerMeter(dpi);
  const out = new Uint8Array(54 + imageSize);
  const v = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d; // "BM"
  v.setUint32(2, 54 + imageSize, true);
  v.setUint32(6, 0, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, w, true);
  v.setInt32(22, h, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(30, 0, true); // BI_RGB
  v.setUint32(34, imageSize, true);
  v.setUint32(38, ppm, true);
  v.setUint32(42, ppm, true);
  v.setUint32(46, 0, true);
  v.setUint32(50, 0, true);
  let o = 54;
  for (let y = h - 1; y >= 0; y--) {
    let s = y * w * 4;
    for (let x = 0; x < w; x++, s += 4) {
      out[o + x * 3] = rgba[s + 2];
      out[o + x * 3 + 1] = rgba[s + 1];
      out[o + x * 3 + 2] = rgba[s];
    }
    o += row;
  }
  return out;
}

// ------------------------------------------------------------ PSD, TGA, PPM, ICO

/** A flat RGB Photoshop file (no layers, raw planes) with its resolution. */
export function writePsd(rgba, w, h, dpi) {
  const plane = w * h;
  const res = 12 + 16; // one image resource: ResolutionInfo
  const out = new Uint8Array(26 + 4 + 4 + res + 4 + 2 + plane * 3);
  const v = new DataView(out.buffer);
  out.set([0x38, 0x42, 0x50, 0x53], 0); // "8BPS"
  v.setUint16(4, 1); // version
  v.setUint16(12, 3); // channels
  v.setUint32(14, h);
  v.setUint32(18, w);
  v.setUint16(22, 8); // bits per channel
  v.setUint16(24, 3); // RGB
  let o = 26;
  v.setUint32(o, 0); o += 4; // color mode data
  v.setUint32(o, res); o += 4;
  out.set([0x38, 0x42, 0x49, 0x4d], o); // "8BIM"
  v.setUint16(o + 4, 0x03ed); // ResolutionInfo
  v.setUint16(o + 6, 0); // empty name, padded
  v.setUint32(o + 8, 16);
  const fixed = Math.round(dpi * 65536);
  v.setUint32(o + 12, fixed); v.setUint16(o + 16, 1); v.setUint16(o + 18, 1); // horizontal, pixels per inch, inches
  v.setUint32(o + 20, fixed); v.setUint16(o + 24, 1); v.setUint16(o + 26, 1);
  o += res;
  v.setUint32(o, 0); o += 4; // layers and masks
  v.setUint16(o, 0); o += 2; // raw
  for (let c = 0; c < 3; c++) {
    for (let i = 0, s = c; i < plane; i++, s += 4) out[o + i] = rgba[s];
    o += plane;
  }
  return out;
}

/** An uncompressed 24-bit Targa, top row first. */
export function writeTga(rgba, w, h) {
  const out = new Uint8Array(18 + w * h * 3);
  const v = new DataView(out.buffer);
  out[2] = 2; // true color
  v.setUint16(12, w, true);
  v.setUint16(14, h, true);
  out[16] = 24;
  out[17] = 0x20; // origin at the top left
  for (let i = 0, s = 0, o = 18; i < w * h; i++, s += 4, o += 3) {
    out[o] = rgba[s + 2];
    out[o + 1] = rgba[s + 1];
    out[o + 2] = rgba[s];
  }
  return out;
}

/** A binary PPM (P6). */
export function writePpm(rgba, w, h) {
  const head = new TextEncoder().encode(`P6\n${w} ${h}\n255\n`);
  const out = new Uint8Array(head.length + w * h * 3);
  out.set(head);
  for (let i = 0, s = 0, o = head.length; i < w * h; i++, s += 4, o += 3) {
    out[o] = rgba[s];
    out[o + 1] = rgba[s + 1];
    out[o + 2] = rgba[s + 2];
  }
  return out;
}

/** A Windows icon holding the page at 256, 48, 32 and 16 pixels (longest side), as PNGs. */
async function writeIco(canvas) {
  const sizes = [256, 48, 32, 16];
  const pngs = [];
  for (const s of sizes) {
    const k = s / Math.max(canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * k));
    c.height = Math.max(1, Math.round(canvas.height * k));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvas, 0, 0, c.width, c.height);
    pngs.push([c.width, c.height, new Uint8Array(await (await toBlob(c, 'image/png')).arrayBuffer())]);
  }
  const head = new Uint8Array(6 + 16 * pngs.length);
  const v = new DataView(head.buffer);
  v.setUint16(2, 1, true); // icon
  v.setUint16(4, pngs.length, true);
  let at = head.length;
  pngs.forEach(([w, h, png], i) => {
    const e = 6 + i * 16;
    head[e] = w >= 256 ? 0 : w;
    head[e + 1] = h >= 256 ? 0 : h;
    v.setUint16(e + 4, 1, true); // planes
    v.setUint16(e + 6, 32, true); // bits per pixel
    v.setUint32(e + 8, png.length, true);
    v.setUint32(e + 12, at, true);
    at += png.length;
  });
  return concat([head, ...pngs.map((p) => p[2])]);
}

// ------------------------------------------------------------ TIFF

/** One page of the multi-page TIFF: RGB, LZW compressed in strips, with its resolution. */
function tiffPage(canvas, dpi) {
  const { width: w, height: h } = canvas;
  const rgba = pixels(canvas);
  const rowsPerStrip = Math.max(1, Math.floor(65536 / (w * 3)));
  const strips = [];
  const row = new Uint8Array(w * 3 * rowsPerStrip);
  for (let y0 = 0; y0 < h; y0 += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, h - y0);
    let o = 0;
    for (let s = y0 * w * 4, e = (y0 + rows) * w * 4; s < e; s += 4) {
      row[o++] = rgba[s];
      row[o++] = rgba[s + 1];
      row[o++] = rgba[s + 2];
    }
    strips.push(lzw(row.subarray(0, o)));
  }
  // resolution as a fraction, like the desktop app: dpi * 1000 / 1000, reduced
  let num = Math.round(dpi * 1000), den = 1000;
  const g = gcd(num, den);
  if (g > 1) {
    num /= g;
    den /= g;
  }
  return { w, h, rowsPerStrip, strips, res: [num, den] };
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/** TIFF LZW (MSB first, codes widen one code early, as libtiff writes it). */
export function lzw(data) {
  const out = [];
  let acc = 0, nbits = 0;
  const put = (code, width) => {
    acc = (acc << width) | code;
    nbits += width;
    while (nbits >= 8) {
      nbits -= 8;
      out.push((acc >>> nbits) & 255);
    }
    acc &= (1 << nbits) - 1;
  };
  const CLEAR = 256, EOI = 257, FIRST = 258;
  let width = 9, next = FIRST;
  // dictionary: prefix code * 256 + byte -> code
  let dict = new Map();
  // after each code written a table entry is used up; the table restarts when it's full
  const used = () => {
    next++;
    if (next === 4094) {
      put(CLEAR, width);
      dict = new Map();
      next = FIRST;
      width = 9;
    } else if (next > (1 << width) - 1) {
      width++;
    }
  };
  put(CLEAR, width);
  if (data.length) {
    let w = data[0];
    for (let i = 1; i < data.length; i++) {
      const c = data[i];
      const key = w * 256 + c;
      const found = dict.get(key);
      if (found !== undefined) {
        w = found;
        continue;
      }
      put(w, width);
      dict.set(key, next);
      used();
      w = c;
    }
    put(w, width);
    used();
  }
  put(EOI, width);
  if (nbits) out.push((acc << (8 - nbits)) & 255);
  return Uint8Array.from(out);
}
/** A little-endian, multi-page TIFF. */
function writeTiff(pages) {
  // layout: header, then for each page its IFD, its out-of-line values and its strips
  const parts = [];
  let offset = 8;
  const header = new Uint8Array(8);
  const hv = new DataView(header.buffer);
  header[0] = header[1] = 0x49; // "II"
  hv.setUint16(2, 42, true);
  hv.setUint32(4, 8, true);
  parts.push(header);
  pages.forEach((p, n) => {
    const count = p.strips.length;
    const tags = 14;
    const ifdSize = 2 + tags * 12 + 4;
    const extraStart = offset + ifdSize;
    // out-of-line values: bits per sample (3 shorts), x and y resolution, strip offsets and counts
    const bpsAt = extraStart;
    const xresAt = bpsAt + 6;
    const yresAt = xresAt + 8;
    const offsAt = yresAt + 8;
    const countsAt = offsAt + (count > 1 ? count * 4 : 0);
    let dataAt = countsAt + (count > 1 ? count * 4 : 0);
    const block = new Uint8Array(dataAt - offset);
    const v = new DataView(block.buffer);
    const at = (abs) => abs - offset;
    v.setUint16(0, tags, true);
    let e = 2;
    const entry = (tag, type, cnt, value) => {
      v.setUint16(e, tag, true);
      v.setUint16(e + 2, type, true);
      v.setUint32(e + 4, cnt, true);
      if (type === 3 && cnt === 1) v.setUint16(e + 8, value, true);
      else v.setUint32(e + 8, value, true);
      e += 12;
    };
    const stripOffsets = [];
    for (const s of p.strips) {
      stripOffsets.push(dataAt);
      dataAt += s.length;
    }
    entry(254, 4, 1, n > 0 ? 2 : 0); // NewSubfileType: a page of a multi-page file
    entry(256, 4, 1, p.w); // ImageWidth
    entry(257, 4, 1, p.h); // ImageLength
    entry(258, 3, 3, bpsAt); // BitsPerSample 8,8,8
    entry(259, 3, 1, 5); // Compression: LZW
    entry(262, 3, 1, 2); // Photometric: RGB
    entry(273, 4, count, count > 1 ? offsAt : stripOffsets[0]); // StripOffsets
    entry(277, 3, 1, 3); // SamplesPerPixel
    entry(278, 4, 1, p.rowsPerStrip); // RowsPerStrip
    entry(279, 4, count, count > 1 ? countsAt : p.strips[0].length); // StripByteCounts
    entry(282, 5, 1, xresAt); // XResolution
    entry(283, 5, 1, yresAt); // YResolution
    entry(284, 3, 1, 1); // PlanarConfiguration: chunky
    entry(296, 3, 1, 2); // ResolutionUnit: inch
    const nextIfd = n + 1 < pages.length ? dataAt + (dataAt & 1) : 0;
    v.setUint32(e, nextIfd, true);
    for (let k = 0; k < 3; k++) v.setUint16(at(bpsAt) + k * 2, 8, true);
    v.setUint32(at(xresAt), p.res[0], true);
    v.setUint32(at(xresAt) + 4, p.res[1], true);
    v.setUint32(at(yresAt), p.res[0], true);
    v.setUint32(at(yresAt) + 4, p.res[1], true);
    if (count > 1) {
      p.strips.forEach((s, i) => {
        v.setUint32(at(offsAt) + i * 4, stripOffsets[i], true);
        v.setUint32(at(countsAt) + i * 4, s.length, true);
      });
    }
    parts.push(block, ...p.strips);
    offset = dataAt;
    if (nextIfd && dataAt & 1) {
      parts.push(new Uint8Array(1)); // IFDs start on a word boundary
      offset += 1;
    }
  });
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
