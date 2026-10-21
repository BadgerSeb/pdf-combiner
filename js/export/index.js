// Saving: combining into one PDF, and exporting to Excel, DXF and pictures.
//
// Every function takes the items to save (only pages with `included` are written, each turned
// by its `rotation`) and a progress callback for status text, and returns the bytes written and
// the number of pages. Errors carry a message fit to show the user.
//
//   item: { name, bytes: Uint8Array (the PDF), pages: [{ width, height, included, rotation }] }
//   (width and height in points as pdf.js reports them, the PDF's own /Rotate applied; rotation is
//   the extra clockwise turn: 0, 90, 180 or 270)
//
// Excel and DXF only work for pages that hold real text and lines (made by a program), not
// scans or pictures: they read what the page's content stream draws (content.js), put the
// characters back together into lines (layout.js) and rebuild a table or a drawing from that.
//
// A port of the desktop app's export crate (PdfCombinerRs/crates/export); outputs match it.

export { combinePdf } from './combine.js';
export { toExcel } from './excel.js';
export { toDxf } from './dxf.js';
export { IMAGE_KINDS, RESOLUTIONS, targetNames, saveImages } from './images.js';
export { toCsv, toOds } from './tables.js';
export { toText, toDocx, toOdt, toRtf, toHtml, toPptx } from './docs.js';
export { toSvg, toEps } from './vector.js';

import { combinePdf } from './combine.js';

/** One PDF per included page. */
export async function splitPdf(items, progress) {
  const files = [];
  for (let k = 0; k < items.length; k++) {
    for (let i = 0; i < items[k].pages.length; i++) {
      if (!items[k].pages[i].included) continue;
      const only = items.map((it, kk) => ({ ...it, pages: it.pages.map((p, ii) => ({ ...p, included: kk === k && ii === i })) }));
      files.push((await combinePdf(only, () => progress(`Saving page ${files.length + 1}…`))).bytes);
    }
  }
  if (!files.length) throw new Error('No pages are selected.');
  return { files, pages: files.length };
}
