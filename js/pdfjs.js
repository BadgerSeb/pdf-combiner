// pdf.js set up for this app: opening PDFs and rendering pages to canvases.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

const base = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

const options = {
  cMapUrl: base + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: base + 'standard_fonts/',
  wasmUrl: base + 'wasm/',
  iccUrl: base + 'iccs/',
};

/** Opens PDF bytes with pdf.js (the bytes are copied; pdf.js takes ownership of what it's given). */
export async function openPdf(bytes, password) {
  return pdfjs.getDocument({ ...options, data: bytes.slice(), password }).promise;
}

/** Frees a document opened with openPdf (pdf.js 6 closes documents through their loading task). */
export async function closePdf(doc) {
  try {
    if (typeof doc?.destroy === 'function') await doc.destroy();
    else await doc?.loadingTask?.destroy();
  } catch { /* already closed */ }
}

/** Page sizes in points (as viewed, with the PDF's own /Rotate applied). */
export async function pageSizes(doc) {
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
  }
  return sizes;
}

/**
 * Renders page `index` (0-based) `width` pixels wide on white, turned clockwise by `rotation`
 * (0/90/180/270) on top of the PDF's own rotation. Returns a canvas.
 */
export async function renderPage(doc, index, width, rotation = 0) {
  const page = await doc.getPage(index + 1);
  const rot = (page.rotate + rotation) % 360;
  const unit = page.getViewport({ scale: 1, rotation: rot });
  const viewport = page.getViewport({ scale: Math.max(0.01, width / unit.width), rotation: rot });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return canvas;
}

export { pdfjs };
