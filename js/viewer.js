// Full-size view of one page with previous/next, skip and rotate, over the whole window.

import { app } from './app.js';

let pages = null;   // [{ item, index }]
let index = 0;
const el = () => document.getElementById('viewer');

export function viewerOpen() { return pages !== null; }
export function viewerKey() { return pages || []; }

export function openViewer(r) {
  const list = app.pagesFor();
  const i = list.findIndex(p => p.item === r.item && p.index === r.index);
  if (i < 0) return;
  pages = list;
  index = i;
  build();
  refreshViewer();
  addEventListener('keydown', onKey, true);
  addEventListener('resize', refreshViewer);
}

export function closeViewer() {
  pages = null;
  el().hidden = true;
  removeEventListener('keydown', onKey, true);
  removeEventListener('resize', refreshViewer);
}

function go(i) {
  if (i < 0 || i >= pages.length) return;
  index = i;
  refreshViewer();
}

function onKey(e) {
  const k = e.key;
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) go(index - 1);
  else if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(k)) go(index + 1);
  else if (k === 'Home') go(0);
  else if (k === 'End') go(pages.length - 1);
  else if (k === ' ') app.toggle(pages[index]);
  else if (k === 'Escape') closeViewer();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function build() {
  const v = el();
  v.innerHTML = `<div class="bar">
      <button class="btn" data-a="prev">◀&nbsp; Previous</button>
      <button class="btn" data-a="next">Next &nbsp;▶</button>
      <label><input type="checkbox" data-a="include"> Include this page</label>
      <button class="btn" data-a="left">↺ Rotate left</button>
      <button class="btn" data-a="right">↻ Rotate right</button>
      <span class="title"></span><span class="spacer"></span>
      <button class="btn" data-a="close" title="Back to all pages (Esc)">✕&nbsp; Close</button>
    </div><div class="canvas"><img alt=""></div>`;
  v.hidden = false;
  v.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'prev') go(index - 1);
    else if (a === 'next') go(index + 1);
    else if (a === 'left') app.rotate(pages[index], -90);
    else if (a === 'right') app.rotate(pages[index], 90);
    else if (a === 'close') closeViewer();
    else if (e.target.closest('.canvas')) {
      // click the left or right third to go back or forward
      const r = e.currentTarget.querySelector('.canvas').getBoundingClientRect();
      if (e.clientX < r.left + r.width / 3) go(index - 1);
      else if (e.clientX > r.left + r.width * 2 / 3) go(index + 1);
    }
  };
  v.querySelector('[data-a=include]').onchange = () => app.toggle(pages[index]);
}

export function refreshViewer() {
  if (!pages) return;
  const r = pages[index];
  const it = app.item(r.item);
  if (!it) return closeViewer();
  const info = it.pages[r.index];
  const v = el();
  v.querySelector('[data-a=prev]').disabled = index === 0;
  v.querySelector('[data-a=next]').disabled = index === pages.length - 1;
  v.querySelector('[data-a=include]').checked = info.included;
  v.querySelector('.title').textContent = `${it.name} — page ${r.index + 1} of ${it.pages.length}`;

  const canvas = v.querySelector('.canvas');
  const box = canvas.getBoundingClientRect();
  const side = info.rotation % 180 !== 0;
  const [pw, ph] = side ? [info.height, info.width] : [info.width, info.height];
  const s = Math.min((box.width - 48) / pw, (box.height - 48) / ph);
  const [w, h] = [info.width * s, info.height * s]; // unrotated size on screen
  const img = canvas.querySelector('img');
  const url = app.thumbs.get(it, r.index, Math.max(400, w * devicePixelRatio));
  if (url && img.getAttribute('src') !== url) img.src = url;
  img.style.width = w + 'px';
  img.style.height = h + 'px';
  img.style.transform = `translate(-50%, -50%) rotate(${info.rotation}deg)`;
  img.style.opacity = info.included ? '1' : '.4';
}
