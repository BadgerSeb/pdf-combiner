// Combining: copies the included pages of every item, in order, into one new PDF.
//
// Each source is loaded on its own and only what its included pages use is copied across
// (renumbered into the new file). Attributes a page inherits from its page tree (Resources,
// MediaBox, CropBox, Rotate) are put on the page itself, since the old tree isn't copied.
// References to pages that aren't copied, and to the old page tree, become null; links between
// copied pages keep working.

import {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFRawStream, PDFStream, PDFNull,
} from '../../vendor/pdf-lib.esm.min.js';
import * as pdf from './pdfobj.js';

export async function combinePdf(items, progress) {
  const output = await PDFDocument.create({ updateMetadata: false });
  const octx = output.context;
  const pagesRef = output.catalog.get(PDFName.of('Pages'));
  const kids = [];
  for (const it of items) {
    if (!it.pages.some((p) => p.included)) continue;
    progress(`Adding ${it.name}…`);
    const input = await pdf.load(it.bytes, it.name);
    const sourcePages = pdf.pages(input);
    const imp = new Importer(input.context, octx, sourcePages.map((p) => p.ref));
    // give the included pages their new numbers first, so links between them keep working
    const chosen = [];
    for (let i = 0; i < Math.min(it.pages.length, sourcePages.length); i++) {
      const info = it.pages[i];
      if (info.included) chosen.push([sourcePages[i], imp.reserve(sourcePages[i].ref), info.rotation | 0]);
    }
    for (const [old, ref, rotation] of chosen) {
      octx.assign(ref, imp.page(old.dict, pagesRef, rotation));
      imp.drain();
      kids.push(ref);
    }
  }
  if (!kids.length) throw new Error('No pages are selected.');

  const pages = octx.lookup(pagesRef);
  pages.set(PDFName.of('Kids'), octx.obj(kids));
  pages.set(PDFName.of('Count'), PDFNumber.of(kids.length));
  output.setCreator('PDF Combiner');
  output.setProducer('PDF Combiner');

  progress('Saving…');
  const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes, pages: kids.length };
}

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/** Copies objects from one source document into the output, giving them new numbers. */
class Importer {
  constructor(src, out, pageRefs) {
    this.src = src;
    this.out = out;
    /** source ref -> output ref */
    this.map = new Map();
    this.queue = [];
    this.pages = new Set(pageRefs);
  }

  reserve(page) {
    const ref = this.out.nextRef();
    this.map.set(page, ref);
    return ref;
  }

  /** The new page dictionary: inherited attributes filled in, extra rotation added. */
  page(orig, parent, rotation) {
    const src = this.src;
    if (!orig) {
      return this.out.obj({ Type: 'Page', MediaBox: [0, 0, 612, 792], Parent: parent });
    }
    const d = new Map(orig.entries());
    d.delete(PDFName.of('Parent'));
    for (const key of INHERITED) {
      const k = PDFName.of(key);
      if (!d.has(k)) {
        const v = pdf.inherited(src, orig, key);
        if (v !== undefined) d.set(k, v);
      }
    }
    if (!d.has(PDFName.of('MediaBox'))) d.set(PDFName.of('MediaBox'), this.out.obj([0, 0, 612, 792]));
    if (rotation !== 0) {
      const r = d.get(PDFName.of('Rotate'));
      const current = r !== undefined ? Math.trunc(pdf.num(src, r)) : 0;
      d.set(PDFName.of('Rotate'), PDFNumber.of((((current + rotation) % 360) + 360) % 360));
    }
    const out = PDFDict.withContext(this.out);
    for (const [k, v] of d) out.set(k, this.translate(v));
    out.set(PDFName.of('Type'), PDFName.of('Page'));
    out.set(PDFName.of('Parent'), parent);
    return out;
  }

  /** Copies everything the translated objects referred to. */
  drain() {
    while (this.queue.length) {
      const old = this.queue.pop();
      const ref = this.map.get(old);
      const obj = this.src.lookup(old);
      this.out.assign(ref, obj === undefined ? PDFNull : this.translate(obj));
    }
  }

  /**
   * A copy of `obj` with its references renumbered. References to pages that aren't being
   * copied, to the old page tree or to missing objects become null.
   */
  translate(obj) {
    if (obj instanceof PDFRef) {
      const mapped = this.map.get(obj);
      if (mapped) return mapped;
      if (this.pages.has(obj)) return PDFNull;
      const target = this.src.lookup(obj);
      if (target === undefined) return PDFNull;
      const type = pdf.asDict(target)?.get(PDFName.of('Type'));
      if (type === PDFName.of('Pages') || type === PDFName.of('Catalog')) return PDFNull;
      const ref = this.out.nextRef();
      this.map.set(obj, ref);
      this.queue.push(obj);
      return ref;
    }
    if (obj instanceof PDFArray) {
      const a = PDFArray.withContext(this.out);
      for (const v of obj.asArray()) a.push(this.translate(v));
      return a;
    }
    if (obj instanceof PDFDict) return this.translateDict(obj);
    if (obj instanceof PDFRawStream) {
      const dict = this.translateDict(obj.dict);
      // the content may have been decrypted, so its length is set afresh
      dict.set(PDFName.of('Length'), PDFNumber.of(obj.contents.length));
      return PDFRawStream.of(dict, obj.contents);
    }
    if (obj instanceof PDFStream) {
      // a stream pdf-lib made itself (not read from the file)
      const contents = obj.getContents();
      const dict = this.translateDict(obj.dict);
      dict.set(PDFName.of('Length'), PDFNumber.of(contents.length));
      return PDFRawStream.of(dict, contents);
    }
    return obj;
  }

  translateDict(d) {
    const out = PDFDict.withContext(this.out);
    for (const [k, v] of d.entries()) out.set(k, this.translate(v));
    return out;
  }
}
