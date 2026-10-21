// Renders page thumbnails one at a time in the background and keeps a size-limited cache of
// picture URLs. Asking for a page returns the best picture available now and queues the right size.

import { openPdf, closePdf, renderPage } from './pdfjs.js';

const BUCKETS = [120, 180, 260, 380, 560, 820, 1200, 1700, 2400];
const MAX_PIXELS = 120_000_000;
const bucket = (w) => BUCKETS.find(b => b >= w) ?? BUCKETS[BUCKETS.length - 1];

export class Thumbs {
  constructor(onReady) {
    this.onReady = onReady;      // called with the item id when a new picture is ready
    this.cache = new Map();      // key -> { url, pixels }, in least-recently-used order
    this.failed = new Set();
    this.queue = [];             // { key, item, index, width }
    this.queued = new Set();
    this.docs = new Map();       // item id -> Promise<pdf.js document>
    this.pixels = 0;
    this.busy = false;
  }

  key(id, index, b) { return `${id}|${index}|${b}`; }

  /** Best picture URL available for this page right now (or null), queuing `width` px at the front */
  get(item, index, width) {
    const b = bucket(width);
    const k = this.key(item.id, index, b);
    const hit = this.cache.get(k);
    if (hit) {
      this.cache.delete(k);
      this.cache.set(k, hit);
      return hit.url;
    }
    if (!this.failed.has(k)) {
      if (this.queued.has(k)) {
        const i = this.queue.findIndex(q => q.key === k);
        if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
      } else {
        this.queued.add(k);
        this.queue.unshift({ key: k, item, index, width: b });
        while (this.queue.length > 400) this.queued.delete(this.queue.pop().key);
        this.pump();
      }
    }
    for (let i = BUCKETS.length - 1; i >= 0; i--) {
      const other = this.cache.get(this.key(item.id, index, BUCKETS[i]));
      if (other) return other.url;
    }
    return null;
  }

  isFailed(item, index, width) {
    return this.failed.has(this.key(item.id, index, bucket(width)));
  }

  /** Drop everything for an item (it was removed) */
  forget(id) {
    const prefix = id + '|';
    for (const [k, v] of this.cache) {
      if (k.startsWith(prefix)) {
        URL.revokeObjectURL(v.url);
        this.pixels -= v.pixels;
        this.cache.delete(k);
      }
    }
    this.queue = this.queue.filter(q => !q.key.startsWith(prefix));
    for (const k of [...this.queued]) if (k.startsWith(prefix)) this.queued.delete(k);
    const doc = this.docs.get(id);
    if (doc) doc.then(closePdf).catch(() => {});
    this.docs.delete(id);
  }

  doc(item) {
    let d = this.docs.get(item.id);
    if (!d) {
      d = openPdf(item.bytes);
      this.docs.set(item.id, d);
    }
    return d;
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const req = this.queue.shift();
        let url = null, pixels = 0;
        try {
          const doc = await this.doc(req.item);
          if (req.index < doc.numPages) {
            const canvas = await renderPage(doc, req.index, req.width);
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
            url = URL.createObjectURL(blob);
            pixels = canvas.width * canvas.height;
          }
        } catch { /* shown as "No preview" */ }
        this.queued.delete(req.key);
        if (!this.docs.has(req.item.id)) {
          if (url) URL.revokeObjectURL(url);
          continue; // removed while rendering
        }
        if (url) {
          this.cache.set(req.key, { url, pixels });
          this.pixels += pixels;
          for (const [k, v] of this.cache) {
            if (this.pixels <= MAX_PIXELS || this.cache.size <= 1) break;
            URL.revokeObjectURL(v.url);
            this.pixels -= v.pixels;
            this.cache.delete(k);
          }
        } else {
          this.failed.add(req.key);
        }
        this.onReady(req.item.id);
      }
    } finally {
      this.busy = false;
    }
  }
}
