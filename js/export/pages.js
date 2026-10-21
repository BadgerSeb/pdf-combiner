// Walking the included pages of the items, and small name helpers shared by the exports.

import * as pdf from './pdfobj.js';
import { readPage, emptyPage } from './content.js';

/**
 * Reads every included page of every item, in order, and hands it to `f` with the item's index
 * and the page's index. A page that can't be read comes through blank (Letter size).
 */
export async function forEachPage(items, progress, f) {
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!it.pages.some((p) => p.included)) continue;
    progress(`Reading ${it.name}…`);
    const doc = await pdf.load(it.bytes, it.name);
    const pages = pdf.pages(doc);
    for (let i = 0; i < Math.min(it.pages.length, pages.length); i++) {
      const info = it.pages[i];
      if (!info.included) continue;
      let page;
      try {
        page = readPage(doc, pages[i].dict, info.rotation | 0);
      } catch {
        page = emptyPage();
      }
      f(k, i, page);
    }
  }
}

/** The file name without its folder and extension, as Rust's Path::file_stem. */
export function fileStem(name) {
  const file = name.split(/[\\/]/).pop();
  if (file === '..') return file;
  const dot = file.lastIndexOf('.');
  return dot <= 0 ? file : file.slice(0, dot);
}

/** The extension without the dot, as Rust's Path::extension ('' when there is none). */
export function fileExtension(name) {
  const file = name.split(/[\\/]/).pop();
  if (file === '..') return '';
  const dot = file.lastIndexOf('.');
  return dot <= 0 ? '' : file.slice(dot + 1);
}
