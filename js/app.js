// PDF Combiner in the browser: the window, its state and actions (a port of the desktop app).

import { convert, kindOf, extOf, ACCEPT } from './convert.js';
import { Thumbs } from './thumbs.js';
import { FORMATS, formatIndex, saveAs } from './save.js';
import { openViewer, viewerKey, closeViewer, viewerOpen, refreshViewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------- settings (this browser only)

const store = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, String(value)); } catch { /* private window */ } },
};

// ---------------------------------------------------------------- state

const state = {
  items: [],            // { id, file, name, kind, state, message, note, bytes, pages }
  selected: new Set(),  // item ids
  anchor: null,
  combined: false,
  thumb: clamp(+store.get('thumb', 190) || 190, 110, 420),
  format: formatIndex(store.get('format', 'pdf')),
  dpi: +store.get('dpi', 200) || 200,
  busy: false,
  savedText: '',
  saved: null,          // { open?: () => void } after a save
  note: null,           // one-off status line: [text, cssClass]
};
let nextId = 1;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export const app = { state, render: () => scheduleRender(), toggle, rotate, item, pagesFor };

const thumbs = new Thumbs(() => scheduleRender());
app.thumbs = thumbs;

function item(id) { return state.items.find(i => i.id === id); }
function indexOf(id) { return state.items.findIndex(i => i.id === id); }
function selectedIndexes() { return state.items.map((it, i) => (state.selected.has(it.id) ? i : -1)).filter(i => i >= 0); }
function current() { return state.items.find(i => state.selected.has(i.id)) || null; }
const ready = (it) => it.state === 'ready';
const includedCount = (it) => it.pages.filter(p => p.included).length;

function selectOnly(index) {
  state.selected.clear();
  const it = state.items[index];
  if (it) { state.selected.add(it.id); state.anchor = it.id; }
  syncPagesBox();
}

function selectIndexes(rows) {
  state.selected = new Set(rows.map(i => state.items[i]?.id).filter(Boolean));
  state.anchor = state.items[rows[0]]?.id ?? null;
  syncPagesBox();
}

// ---------------------------------------------------------------- adding files

async function addFiles(files) {
  const supported = [], unsupported = [];
  for (const f of files) (kindOf(f.name) ? supported : unsupported).push(f);
  const first = state.items.length;
  for (const file of supported) {
    const kind = kindOf(file.name);
    state.items.push({ id: nextId++, file, name: file.name, kind, state: 'waiting', message: 'Waiting…', note: null, bytes: null, pages: [] });
  }
  if (supported.length) {
    state.saved = null;
    state.note = null;
    selectOnly(first);
    pumpConversions();
  }
  scheduleRender();
  if (unsupported.length) {
    let names = unsupported.slice(0, 4).map(f => f.name).join(', ');
    if (unsupported.length > 4) names += ` and ${unsupported.length - 4} more`;
    alert(`These files can't be added because their type isn't supported:\n\n${names}\n\nSupported: PDF, pictures (JPG, PNG, TIFF, GIF, BMP, WebP, SVG), text files and DXF drawings. Word, Excel, PowerPoint, SOLIDWORKS and DWG files need the PDF Combiner desktop app.`);
  }
}

let converting = false;
async function pumpConversions() {
  if (converting) return;
  converting = true;
  try {
    for (;;) {
      const it = state.items.find(i => i.state === 'waiting');
      if (!it) break;
      it.state = 'working';
      it.message = 'Converting…';
      scheduleRender();
      try {
        const r = await convert(it.file, (m) => { it.message = m; scheduleRender(); });
        if (!item(it.id)) continue; // removed meanwhile
        Object.assign(it, { state: 'ready', bytes: r.bytes, pages: r.pages, note: r.note, message: '' });
      } catch (e) {
        Object.assign(it, { state: 'failed', message: e?.message || 'Unknown error' });
      }
      syncPagesBox();
      scheduleRender();
    }
  } finally {
    converting = false;
  }
}

function browse() {
  const input = $('file-input');
  input.accept = ACCEPT;
  input.value = '';
  input.onchange = () => addFiles([...input.files]);
  input.click();
}

/** Files from a drop, following folders (their supported files, sorted like Explorer) */
async function filesFromDrop(dt) {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length === 0) return [...dt.files];
  const out = [];
  for (const e of entries) {
    if (e.isFile) out.push(await new Promise((res, rej) => e.file(res, rej)));
    else if (e.isDirectory) {
      const reader = e.createReader();
      const all = [];
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        all.push(...batch);
      }
      const files = await Promise.all(all.filter(x => x.isFile && kindOf(x.name)).map(x => new Promise((res, rej) => x.file(res, rej))));
      files.sort((a, b) => collator.compare(a.name, b.name));
      out.push(...files);
    }
  }
  return out;
}

let pastedImages = 0, pastedTexts = 0;

function textFile(text) {
  return new File([new Uint8Array([0xef, 0xbb, 0xbf]), text], `Pasted text ${++pastedTexts}.txt`, { type: 'text/plain' });
}

function imageFile(blob) {
  const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return new File([blob], `Pasted image ${++pastedImages}.${ext}`, { type: blob.type });
}

/** Ctrl+V: pictures, copied files (from Explorer) or text */
function onPaste(e) {
  if (e.target === $('pages')) return;
  e.preventDefault();
  const files = [...(e.clipboardData?.files || [])].map(f => (/^image\./i.test(f.name) && f.type.startsWith('image/') ? imageFile(f) : f));
  if (files.length) return addFiles(files);
  const text = e.clipboardData?.getData('text/plain');
  if (text && text.trim()) return addFiles([textFile(text)]);
  nothingToPaste();
}

/** The Paste button: read the clipboard (the browser may ask for permission once) */
async function pasteButton() {
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const ci of items) {
      const img = ci.types.find(t => t.startsWith('image/'));
      if (img) files.push(imageFile(await ci.getType(img)));
      else if (ci.types.includes('text/plain')) {
        const text = await (await ci.getType('text/plain')).text();
        if (text.trim()) files.push(textFile(text));
      }
    }
    if (files.length) return addFiles(files);
    nothingToPaste();
  } catch {
    state.note = ['Press Ctrl+V to paste. (Copied files from File Explorer can only be pasted with Ctrl+V.)', 'muted'];
    scheduleRender();
  }
}

function nothingToPaste() {
  state.note = ["There's nothing to paste. Copy an image, some files or text first.", 'muted'];
  scheduleRender();
}

// ---------------------------------------------------------------- list editing

function removeItems(ids) {
  if (!ids.length) return;
  const first = indexOf(ids[0]);
  for (const id of ids) {
    const i = indexOf(id);
    if (i >= 0) state.items.splice(i, 1);
    state.selected.delete(id);
    thumbs.forget(id);
  }
  if (viewerOpen() && viewerKey().some(r => ids.includes(r.item))) closeViewer();
  if (state.items.length) selectOnly(Math.min(first, state.items.length - 1));
  else { state.selected.clear(); syncPagesBox(); }
  scheduleRender();
}

function removeSelected() { removeItems(selectedIndexes().map(i => state.items[i].id)); }

function clearAll() {
  if (!state.items.length) return;
  if (state.items.length > 2 && !confirm(`Remove all ${state.items.length} files from the list?`)) return;
  removeItems(state.items.map(i => i.id));
  state.saved = null;
  scheduleRender();
}

function moveSelected(delta) {
  const sel = selectedIndexes();
  if (!sel.length) return;
  if ((delta < 0 && sel[0] === 0) || (delta > 0 && sel[sel.length - 1] === state.items.length - 1)) return;
  const chosen = state.selected;
  const items = state.items;
  if (delta < 0) {
    for (let i = 1; i < items.length; i++)
      if (chosen.has(items[i].id) && !chosen.has(items[i - 1].id)) [items[i], items[i - 1]] = [items[i - 1], items[i]];
  } else {
    for (let i = items.length - 2; i >= 0; i--)
      if (chosen.has(items[i].id) && !chosen.has(items[i + 1].id)) [items[i], items[i + 1]] = [items[i + 1], items[i]];
  }
  syncPagesBox();
  scheduleRender();
}

/** Moves the dragged rows, as a group in their current order, to the insertion point */
function moveDragged(rows, insertAt) {
  rows = [...new Set(rows)].filter(i => i < state.items.length).sort((a, b) => a - b);
  if (!rows.length) return;
  const moving = rows.map(i => state.items[i]);
  let at = insertAt - rows.filter(i => i < insertAt).length;
  state.items = state.items.filter(it => !moving.includes(it));
  at = clamp(at, 0, state.items.length);
  state.items.splice(at, 0, ...moving);
  selectIndexes(moving.map((_, k) => at + k));
  scheduleRender();
}

function sortByName() {
  state.items.sort((a, b) => collator.compare(a.name, b.name));
  syncPagesBox();
  scheduleRender();
}

// ---------------------------------------------------------------- pages

/** Pages shown in the grid: the current file's, or every ready file's in "Whole document" */
function pagesFor() {
  if (state.combined) return state.items.filter(ready).flatMap(it => it.pages.map((_, i) => ({ item: it.id, index: i })));
  const it = current();
  return it && ready(it) ? it.pages.map((_, i) => ({ item: it.id, index: i })) : [];
}

function emptyText() {
  if (state.combined) {
    if (!state.items.length) return '';
    const waiting = state.items.filter(x => x.state === 'waiting' || x.state === 'working').length;
    return waiting ? 'Getting your files ready…' : 'There are no pages to show.';
  }
  const it = current();
  if (!it) return state.items.length ? 'Select a file on the left to see its pages.' : '';
  if (it.state === 'failed') return "This file can't be added:\n" + it.message;
  if (!ready(it)) return it.message;
  return '';
}

function page(r) { return item(r.item)?.pages[r.index]; }

function changed() {
  state.saved = null;
  syncPagesBox();
  scheduleRender();
  if (viewerOpen()) refreshViewer();
}

function toggle(r) { const p = page(r); if (p) p.included = !p.included; changed(); }
function rotate(r, deg) { const p = page(r); if (p) p.rotation = (((p.rotation + deg) % 360) + 360) % 360; changed(); }
function keepOnly(r) { item(r.item)?.pages.forEach((p, k) => (p.included = k === r.index)); changed(); }
function includeEvery(id) { item(id)?.pages.forEach(p => (p.included = true)); changed(); }

function setAllIncluded(include) {
  const cur = current();
  for (const it of state.items) if (ready(it) && (state.combined || it === cur)) it.pages.forEach(p => (p.included = include));
  changed();
}

function pagesUsable() { const c = current(); return !state.combined && !!c && ready(c); }

function rangeText(it) {
  if (it.pages.every(p => p.included)) return '';
  const parts = [];
  for (let i = 0; i < it.pages.length;) {
    if (!it.pages[i].included) { i++; continue; }
    let j = i;
    while (j + 1 < it.pages.length && it.pages[j + 1].included) j++;
    parts.push(i === j ? `${i + 1}` : `${i + 1}-${j + 1}`);
    i = j + 1;
  }
  return parts.length ? parts.join(', ') : 'none';
}

/** "1-3, 5, 8-" → 0-based page indexes, or null when it isn't a valid range */
export function parseRange(text, count) {
  const t = text.trim();
  if (!t || t.toLowerCase() === 'all') return [...Array(count).keys()];
  const keep = new Array(count).fill(false);
  for (const part of t.split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; }
    else if (/^\d+$/.test(p)) a = b = +p;
    else return null;
    if (a < 1 || b < a || b > count) return null;
    for (let k = a; k <= b; k++) keep[k - 1] = true;
  }
  return keep.map((k, i) => (k ? i : -1)).filter(i => i >= 0);
}

function syncPagesBox() {
  const box = $('pages');
  if (document.activeElement === box) return;
  box.value = pagesUsable() ? rangeText(current()) : '';
}

function pagesBad() {
  const c = current();
  const v = $('pages').value;
  return pagesUsable() && v.trim() !== 'none' && parseRange(v, c.pages.length) === null;
}

function applyPagesBox() {
  if (!pagesUsable()) return;
  const it = current();
  const text = $('pages').value.trim();
  if (text === 'none') return;
  const keep = parseRange(text, it.pages.length);
  if (!keep) return;
  const set = new Set(keep);
  it.pages.forEach((p, i) => (p.included = set.has(i)));
  $('pages').value = rangeText(it);
  changed();
}

function zoom(delta) {
  state.thumb = clamp(state.thumb + delta, 110, 420);
  store.set('thumb', state.thumb);
  scheduleRender();
}

// ---------------------------------------------------------------- saving

function canSave() {
  const working = state.items.some(x => x.state === 'waiting' || x.state === 'working');
  const pages = state.items.filter(ready).reduce((n, x) => n + includedCount(x), 0);
  return !state.busy && !working && pages > 0;
}

async function save() {
  if (!canSave()) return;
  const items = state.items.filter(x => ready(x) && includedCount(x) > 0)
    .map(x => ({ name: x.name, bytes: x.bytes, pages: x.pages.map(p => ({ ...p })) }));
  const single = state.items.length === 1;
  const stem = single ? state.items[0].name.replace(/\.[^.]+$/, '') : 'Combined';
  state.busy = true;
  state.saved = null;
  state.savedText = 'Saving…';
  scheduleRender();
  try {
    const result = await saveAs(items, state.format, state.dpi, stem, (m) => { state.savedText = m; scheduleRender(); });
    if (result) {
      state.savedText = result.text;
      state.saved = result;
    } else {
      state.savedText = '';
    }
  } catch (e) {
    state.savedText = '';
    alert(`Couldn't save the ${FORMATS[state.format].what}.\n\n${e?.message || e}`);
  } finally {
    state.busy = false;
    scheduleRender();
  }
}

// ---------------------------------------------------------------- theme

// Always dark. The light mode button keeps asking until the answer is no (Cancel).

const lightQuestions = [
  'Switch to light mode?',
  'Are you really sure? Light mode is a lot brighter.',
  'Really really sure? Click Cancel to stay in dark mode.',
  'Light mode is not available. Click Cancel to stay in dark mode.',
];

function applyTheme() {
  document.documentElement.dataset.theme = 'dark';
  $('theme').textContent = '☀  Light mode';
  document.querySelector('meta[name=theme-color]').content = '#1b1d20';
}

function toggleTheme() {
  // OK only asks again; the last question repeats until they say no
  for (let i = 0; confirm(lightQuestions[Math.min(i, lightQuestions.length - 1)]); i++);
}

// ---------------------------------------------------------------- rendering

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const empty = state.items.length === 0;
  $('main').classList.toggle('empty-list', empty);
  renderToolbar();
  if (!empty) {
    renderList();
    renderPreviewBar();
    renderGrid();
  }
  renderFooter();
  if (viewerOpen()) refreshViewer();
}

function renderToolbar() {
  const sel = selectedIndexes(), n = state.items.length, busy = state.busy;
  $('add').disabled = busy;
  $('paste').disabled = busy;
  $('remove').disabled = !sel.length || busy;
  $('up').disabled = !sel.length || sel[0] === 0 || busy;
  $('down').disabled = !sel.length || sel[sel.length - 1] === n - 1 || busy;
  $('sort').disabled = n < 2 || busy;
  $('clear').disabled = !n || busy;
}

// file cards, updated in place (keyed by item id)
const rowEls = new Map();

function renderList() {
  const list = $('list');
  $('files-caption').textContent = state.items.length ? `Files (${state.items.length})` : 'Files';
  const keep = new Set(state.items.map(i => i.id));
  for (const [id, el] of rowEls) if (!keep.has(id)) { el.remove(); rowEls.delete(id); }
  state.items.forEach((it, i) => {
    let el = rowEls.get(it.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'row';
      el.innerHTML = '<span class="num"></span><span class="thumb"></span><span class="text"><div class="name"></div><div class="line l1"></div><div class="line l2"></div></span><button class="x" title="Remove">✕</button>';
      el.dataset.id = it.id;
      rowEls.set(it.id, el);
    }
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    el.classList.toggle('selected', state.selected.has(it.id));
    el.querySelector('.num').textContent = i + 1;
    const name = el.querySelector('.name');
    if (name.textContent !== it.name) { name.textContent = it.name; name.title = it.name; }

    // thumbnail or type badge
    const thumb = el.querySelector('.thumb');
    const first = ready(it) ? Math.max(0, it.pages.findIndex(p => p.included)) : -1;
    const url = first >= 0 ? thumbs.get(it, first, 47 * 2 * devicePixelRatio) : null;
    if (url) {
      let img = thumb.querySelector('img');
      if (!img) { thumb.textContent = ''; img = document.createElement('img'); thumb.appendChild(img); }
      if (img.getAttribute('src') !== url) img.src = url;
      const pi = it.pages[first];
      img.style.transform = pi.rotation ? `rotate(${pi.rotation}deg)` : '';
      // turned sideways, the picture's width becomes its height on screen
      const side = pi.rotation % 180 !== 0;
      img.style.maxWidth = side ? '60px' : '';
      img.style.maxHeight = side ? '47px' : '';
    } else if (!thumb.querySelector('.badge')) {
      thumb.innerHTML = `<span class="badge"><i style="background:${it.kind.color}">${extOf(it.name).toUpperCase().slice(0, 4)}</i></span>`;
    }

    const l1 = el.querySelector('.l1'), l2 = el.querySelector('.l2');
    let line1, line2 = '', c1 = '', c2 = '';
    if (it.state === 'ready') {
      const n = it.pages.length, inc = includedCount(it);
      const what = it.kind.via === 'pdf' ? 'PDF' : `${it.kind.label} → PDF`;
      line1 = inc === 0 ? 'All pages skipped' : `${what}  ·  ${inc === n ? `${n} ${n === 1 ? 'page' : 'pages'}` : `${inc} of ${n} pages`}`;
      if (inc === 0) c1 = 'danger';
      line2 = it.note || '';
    } else if (it.state === 'failed') {
      line1 = "Can't add this file"; line2 = it.message; c1 = c2 = 'danger';
    } else {
      line1 = it.kind.label; line2 = it.message; c2 = 'accent';
    }
    l1.textContent = line1; l1.className = 'line l1 ' + c1;
    l2.textContent = line2; l2.className = 'line l2 ' + c2; l2.title = line2;
  });
}

function renderPreviewBar() {
  $('mode-file').classList.toggle('on', !state.combined);
  $('mode-all').classList.toggle('on', state.combined);
  const tools = state.combined ? state.items.some(ready) : !!current() && ready(current());
  $('include-all').disabled = $('skip-all').disabled = !tools;
  const box = $('pages');
  box.disabled = !pagesUsable();
  box.classList.toggle('bad', pagesBad());
}

// page tiles, updated in place (keyed by item|page)
const tileEls = new Map();
const visible = new Set();
const observer = new IntersectionObserver((entries) => {
  let any = false;
  for (const e of entries) {
    const k = e.target.dataset.key;
    if (e.isIntersecting) { if (!visible.has(k)) { visible.add(k); any = true; } } else visible.delete(k);
  }
  if (any) scheduleRender();
}, { root: document.getElementById('grid-scroll'), rootMargin: '400px 0px' });

function fitBox(boxW, boxH, w, h, rot) {
  const side = rot % 180 !== 0;
  const [pw, ph] = side ? [h, w] : [w, h];
  const s = Math.min(boxW / pw, boxH / ph);
  return { w: pw * s, h: ph * s, imgW: (side ? ph : pw) * s, imgH: (side ? pw : ph) * s };
}

function renderGrid() {
  const grid = $('grid');
  grid.style.setProperty('--thumb', state.thumb + 'px');
  const pages = pagesFor();
  $('empty').textContent = pages.length ? '' : emptyText();
  const keys = pages.map(r => `${r.item}|${r.index}`);
  const keep = new Set(keys);
  for (const [k, el] of tileEls) if (!keep.has(k)) { observer.unobserve(el); el.remove(); tileEls.delete(k); visible.delete(k); }

  const boxW = state.thumb, boxH = Math.floor(state.thumb * 1.294);
  let out = 0;
  pages.forEach((r, i) => {
    const key = keys[i];
    const it = item(r.item), info = it.pages[r.index];
    let el = tileEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.dataset.key = key;
      el.innerHTML = `<div class="box"><div class="page"><span class="loading">Loading…</span></div>
        <div class="tools"><button data-act="left" title="Rotate left">↺</button><button data-act="right" title="Rotate right">↻</button><button data-act="view" title="View larger">🔍&#xFE0E;</button></div></div>
        <div class="label"><span class="check"><svg viewBox="0 0 12 12"><path d="M2.3 6.4 4.9 8.9 9.8 3.4" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="caption"><div></div><small></small></span></div>`;
      tileEls.set(key, el);
      observer.observe(el);
    }
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    el.classList.toggle('skipped', !info.included);
    el.classList.toggle('combined', state.combined);
    if (info.included) out++;

    const fit = fitBox(boxW, boxH, info.width, info.height, info.rotation);
    const pageEl = el.querySelector('.page');
    pageEl.style.width = fit.w + 'px';
    pageEl.style.height = fit.h + 'px';
    if (visible.has(key)) {
      const url = thumbs.get(it, r.index, (info.rotation % 180 ? fit.h : fit.w) * devicePixelRatio);
      let img = pageEl.querySelector('img');
      if (url) {
        if (!img) { pageEl.textContent = ''; img = document.createElement('img'); img.draggable = false; pageEl.appendChild(img); }
        if (img.getAttribute('src') !== url) img.src = url;
        img.style.width = fit.imgW + 'px';
        img.style.height = fit.imgH + 'px';
        img.style.transform = `translate(-50%, -50%) rotate(${info.rotation}deg)`;
      } else if (!img) {
        pageEl.innerHTML = `<span class="loading">${thumbs.isFailed(it, r.index, fit.w * devicePixelRatio) ? 'No preview' : 'Loading…'}</span>`;
      }
    }
    let veil = pageEl.querySelector('.veil');
    if (!info.included && !veil) { veil = document.createElement('div'); veil.className = 'veil'; veil.innerHTML = '<b>Skipped</b>'; pageEl.appendChild(veil); }
    if (info.included && veil) veil.remove();

    const top = el.querySelector('.caption div'), small = el.querySelector('.caption small');
    if (state.combined) {
      top.textContent = info.included ? `Page ${out}` : 'Skipped';
      small.textContent = `${it.name} · p${r.index + 1}`;
    } else {
      top.textContent = `Page ${r.index + 1}`;
      small.textContent = '';
    }
  });
}

function renderFooter() {
  const ready_ = state.items.filter(ready).length;
  const single = state.items.length === 1 && ready_ === 1;
  const f = FORMATS[state.format];
  $('format').textContent = `${f.short}   ▾`;
  $('format').disabled = state.busy;
  const save = $('save');
  save.textContent = f.id === 'pdf' && !single ? 'Combine & Save PDF' : `Save as ${f.short}`;
  save.disabled = !canSave();
  const working = state.items.filter(x => x.state === 'waiting' || x.state === 'working').length;
  const pages = state.items.filter(ready).reduce((n, x) => n + includedCount(x), 0);
  save.title = working ? 'Waiting for files to finish converting' : pages === 0 ? 'No pages are selected' : 'Save the selected pages, in order (Ctrl+S)';

  const status = $('status');
  const open = $('open-saved');
  open.hidden = !(state.saved?.open && !state.busy);
  let text, cls = '';
  if (state.busy) text = state.savedText;
  else if (state.saved) { text = state.savedText; cls = 'success'; }
  else if (state.note) [text, cls] = state.note;
  else if (!state.items.length) { text = 'Add some files to get started.'; cls = 'muted'; }
  else {
    const failed = state.items.filter(x => x.state === 'failed').length;
    if (working) text = `Getting ${working} ${working === 1 ? 'file' : 'files'} ready…`;
    else {
      const files = state.items.filter(x => ready(x) && includedCount(x) > 0).length;
      text = `${pages} ${pages === 1 ? 'page' : 'pages'} from ${files} ${files === 1 ? 'file' : 'files'} will go into the ${f.into(pages)}`;
    }
    if (failed) text += `   (${failed} ${failed === 1 ? 'file' : 'files'} couldn't be added, shown in red, and will be left out.)`;
    if (failed && pages === 0) cls = 'danger';
  }
  status.textContent = text;
  status.title = text;
  status.className = 'status ' + cls;
}

// ---------------------------------------------------------------- menus

function showMenu(menu, x, y, build, alignBottom = false) {
  menu.innerHTML = '';
  build(menu);
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  const left = clamp(x, 4, innerWidth - r.width - 4);
  const top = alignBottom ? y - r.height : clamp(y, 4, innerHeight - r.height - 4);
  menu.style.left = left + 'px';
  menu.style.top = Math.max(4, top) + 'px';
  setTimeout(() => {
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && menu.contains(e.target)) return;
      menu.hidden = true;
      removeEventListener('pointerdown', close, true);
      removeEventListener('keydown', close, true);
      removeEventListener('blur', close);
    };
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', close, true);
    addEventListener('blur', close);
  });
}

function menuItem(menu, text, action, ticked) {
  const b = document.createElement('button');
  b.innerHTML = `<span class="tick">${ticked ? '✓' : ''}</span><span></span>`;
  b.lastChild.textContent = text;
  b.onclick = () => { b.closest('.menu').hidden = true; action(); };
  menu.appendChild(b);
}

function heading(menu, text) {
  const h = document.createElement('div');
  h.className = 'heading';
  h.textContent = text;
  menu.appendChild(h);
}

function formatMenu() {
  const btn = $('format').getBoundingClientRect();
  showMenu($('format-menu'), btn.left, btn.top - 6, (m) => {
    // three columns: documents | spreadsheets and drawings | pictures and their resolution
    const columns = [['Documents'], ['Spreadsheets', 'Drawings'], ['Pictures']].map(() => {
      const c = document.createElement('div');
      c.className = 'column';
      m.appendChild(c);
      return c;
    });
    const columnOf = { Documents: 0, Spreadsheets: 1, Drawings: 1, Pictures: 2 };
    let group = null;
    FORMATS.forEach((f, i) => {
      const col = columns[columnOf[f.group]];
      if (f.group !== group) {
        group = f.group;
        if (col.childElementCount) col.appendChild(document.createElement('hr'));
        heading(col, f.group);
      }
      menuItem(col, f.name, () => { state.format = i; store.set('format', f.id); scheduleRender(); }, i === state.format);
    });
    const pics = columns[2];
    pics.appendChild(document.createElement('hr'));
    heading(pics, 'Picture resolution');
    for (const dpi of [100, 150, 200, 300, 600]) {
      const extra = { 150: '  (screen, email)', 300: '  (print)', 600: '  (fine print, large files)' }[dpi] || '';
      menuItem(pics, `${dpi} dpi${extra}`, () => { state.dpi = dpi; store.set('dpi', dpi); }, dpi === state.dpi);
    }
  }, true);
}

function pageMenu(r, x, y) {
  const info = page(r);
  showMenu($('page-menu'), x, y, (m) => {
    menuItem(m, info.included ? 'Skip this page' : 'Include this page', () => toggle(r));
    menuItem(m, 'View larger', () => openViewer(r));
    m.appendChild(document.createElement('hr'));
    menuItem(m, 'Rotate left', () => rotate(r, -90));
    menuItem(m, 'Rotate right', () => rotate(r, 90));
    m.appendChild(document.createElement('hr'));
    menuItem(m, 'Keep only this page from this file', () => keepOnly(r));
    menuItem(m, 'Include every page of this file', () => includeEvery(r.item));
  });
}

// ---------------------------------------------------------------- wiring

function tileRef(el) {
  const [id, index] = el.dataset.key.split('|').map(Number);
  return { item: id, index };
}

function wire() {
  $('add').onclick = browse;
  $('choose').onclick = (e) => { e.stopPropagation(); browse(); };
  $('welcome').onclick = browse;
  $('paste').onclick = pasteButton;
  $('remove').onclick = removeSelected;
  $('up').onclick = () => moveSelected(-1);
  $('down').onclick = () => moveSelected(1);
  $('sort').onclick = sortByName;
  $('clear').onclick = clearAll;
  $('theme').onclick = toggleTheme;
  $('mode-file').onclick = () => { state.combined = false; syncPagesBox(); scheduleRender(); };
  $('mode-all').onclick = () => { state.combined = true; syncPagesBox(); scheduleRender(); };
  $('include-all').onclick = () => setAllIncluded(true);
  $('skip-all').onclick = () => setAllIncluded(false);
  $('zoom-out').onclick = () => zoom(-30);
  $('zoom-in').onclick = () => zoom(30);
  $('format').onclick = formatMenu;
  $('save').onclick = save;
  $('open-saved').onclick = () => state.saved?.open?.();

  const pages = $('pages');
  pages.addEventListener('keydown', (e) => { if (e.key === 'Enter') { applyPagesBox(); pages.blur(); } });
  pages.addEventListener('blur', applyPagesBox);
  pages.addEventListener('input', () => pages.classList.toggle('bad', pagesBad()));

  // page grid
  const grid = $('grid');
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const r = tileRef(tile);
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'left') rotate(r, -90);
    else if (act === 'right') rotate(r, 90);
    else if (act === 'view') openViewer(r);
    else if (e.detail === 2) { toggle(r); openViewer(r); } // undo the first click's toggle
    else if (e.detail === 1) toggle(r);
  });
  grid.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    e.preventDefault();
    pageMenu(tileRef(tile), e.clientX, e.clientY);
  });
  $('grid-scroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 20 : -20);
  }, { passive: false });

  wireList();
  wireSplitter();

  // drop anywhere
  let depth = 0;
  addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; $('drop-hint').hidden = false; } });
  addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop-hint').hidden = true; } });
  addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  addEventListener('drop', async (e) => {
    depth = 0;
    $('drop-hint').hidden = true;
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    addFiles(await filesFromDrop(e.dataTransfer));
  });
  addEventListener('paste', onPaste);
  addEventListener('keydown', onKey);
}

function onKey(e) {
  if (viewerOpen()) return;
  const typing = e.target === $('pages');
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); if (!state.busy) browse(); return; }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (typing || state.busy) return;
  if (e.key === 'Delete') { e.preventDefault(); removeSelected(); }
  else if (ctrl && e.key === 'ArrowUp') { e.preventDefault(); moveSelected(-1); }
  else if (ctrl && e.key === 'ArrowDown') { e.preventDefault(); moveSelected(1); }
  else if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); state.selected = new Set(state.items.map(i => i.id)); syncPagesBox(); scheduleRender(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!state.items.length) return;
    e.preventDefault();
    const cur = selectedIndexes()[0];
    const target = cur === undefined ? 0 : clamp(cur + (e.key === 'ArrowUp' ? -1 : 1), 0, state.items.length - 1);
    selectOnly(target);
    scheduleRender();
    requestAnimationFrame(() => rowEls.get(state.items[target].id)?.scrollIntoView({ block: 'nearest' }));
  }
}

/** File list: selection (click, Ctrl, Shift) and dragging one or several files to reorder */
function wireList() {
  const list = $('list');
  let drag = null; // { rows, narrowTo, startY, active, line }

  const insertIndex = (y) => {
    const rows = [...list.querySelectorAll('.row')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.busy) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const id = +row.dataset.id, i = indexOf(id);
    if (e.target.closest('.x')) return;
    list.focus();
    if (e.ctrlKey || e.metaKey) {
      if (!state.selected.delete(id)) state.selected.add(id);
      state.anchor = id;
      syncPagesBox();
      drag = null;
    } else if (e.shiftKey) {
      const a = state.anchor != null && indexOf(state.anchor) >= 0 ? indexOf(state.anchor) : i;
      const [lo, hi] = [Math.min(a, i), Math.max(a, i)];
      state.selected = new Set(state.items.slice(lo, hi + 1).map(x => x.id));
      syncPagesBox();
      drag = null;
    } else if (state.selected.has(id) && state.selected.size > 1) {
      // keep the whole selection so it can be dragged as a group
      drag = { rows: selectedIndexes(), narrowTo: i, startY: e.clientY, active: false };
    } else {
      selectOnly(i);
      drag = { rows: [i], narrowTo: null, startY: e.clientY, active: false };
    }
    if (drag) list.setPointerCapture(e.pointerId);
    scheduleRender();
  });

  list.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.active && Math.abs(e.clientY - drag.startY) > 4) {
      drag.active = true;
      drag.narrowTo = null;
      drag.line = document.createElement('div');
      drag.line.className = 'insert-line';
      list.appendChild(drag.line);
    }
    if (!drag.active) return;
    const at = insertIndex(e.clientY);
    drag.at = at;
    const rows = list.querySelectorAll('.row');
    const listTop = list.getBoundingClientRect().top - list.scrollTop;
    const y = at < rows.length ? rows[at].getBoundingClientRect().top : rows[rows.length - 1].getBoundingClientRect().bottom - 2;
    drag.line.style.top = (y - listTop) + 'px';
    // auto-scroll near the edges
    const lr = list.getBoundingClientRect();
    if (e.clientY < lr.top + 37) list.scrollTop -= 8;
    else if (e.clientY > lr.bottom - 37) list.scrollTop += 8;
  });

  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.line?.remove();
    if (d.active && d.at !== undefined) moveDragged(d.rows, d.at);
    else if (d.narrowTo !== null) { selectOnly(d.narrowTo); scheduleRender(); }
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', () => { drag?.line?.remove(); drag = null; });

  list.addEventListener('click', (e) => {
    const x = e.target.closest('.x');
    if (x) removeItems([+x.closest('.row').dataset.id]);
  });
}

function wireSplitter() {
  const main = $('main');
  const set = (w) => { main.style.setProperty('--split', clamp(w, 260, Math.max(260, innerWidth - 420)) + 'px'); };
  set(+store.get('split', 360) || 360);
  const s = $('splitter');
  s.addEventListener('pointerdown', (e) => {
    s.setPointerCapture(e.pointerId);
    const move = (ev) => set(ev.clientX - main.getBoundingClientRect().left);
    const up = () => {
      s.removeEventListener('pointermove', move);
      s.removeEventListener('pointerup', up);
      store.set('split', parseInt(getComputedStyle(main).getPropertyValue('--split')));
    };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  });
}

// ---------------------------------------------------------------- install, offline, updates

function setUpdates() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ready = (worker) => {
      // a new version has been downloaded: switch now if nothing is open, otherwise offer it
      if (!state.items.length) worker.postMessage('activate');
      else {
        $('update').hidden = false;
        $('update-now').onclick = () => worker.postMessage('activate');
      }
    };
    if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(w); });
    });
    // look for a new version every half hour while open
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading) { reloading = true; location.reload(); } });
}

/** Files opened with the installed app ("Open with", double-click on a PDF) */
function setFileHandling() {
  if (!('launchQueue' in window)) return;
  launchQueue.setConsumer(async (params) => {
    const files = await Promise.all((params.files || []).map(h => h.getFile()));
    if (files.length) addFiles(files);
  });
}

applyTheme();
wire();
render();
setUpdates();
setFileHandling();
