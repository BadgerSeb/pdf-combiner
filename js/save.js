// What can be saved, and writing it where the user picks (the browser's Save dialog, a folder
// for several pictures, or a plain download when the browser can't do either).

const exportModule = () => import('./export/index.js');

const image = (name, ext, mime, oneFile = false) => ({
  name: `${name} image${oneFile ? ' (all pages in one file)' : ''}`,
  short: name,
  what: `${name} image`,
  ext,
  mime,
  image: true,
  oneFile,
  into: (pages) => (oneFile || pages === 1 ? `${name} file.` : `${name} files, one per page.`),
});

export const FORMATS = [
  { name: 'PDF', short: 'PDF', what: 'PDF', ext: 'pdf', mime: 'application/pdf', into: () => 'PDF.' },
  { name: 'Excel (.xlsx)', short: 'Excel', what: 'spreadsheet', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', into: () => 'spreadsheet.' },
  { name: 'DXF drawing (.dxf)', short: 'DXF', what: 'DXF', ext: 'dxf', mime: 'application/dxf', into: () => 'DXF drawing.' },
  image('PNG', 'png', 'image/png'),
  image('JPEG', 'jpg', 'image/jpeg'),
  image('BMP', 'bmp', 'image/bmp'),
  image('GIF', 'gif', 'image/gif'),
  image('TIFF', 'tif', 'image/tiff', true),
  image('WebP', 'webp', 'image/webp'),
];
export const FIRST_IMAGE = 3;

/** One file per page: "Name - 01.png", "Name - 02.png", … */
export function numberedNames(stem, ext, pages) {
  const digits = Math.max(2, String(pages).length);
  return Array.from({ length: pages }, (_, i) => `${stem} - ${String(i + 1).padStart(digits, '0')}.${ext}`);
}

const canPickFile = () => typeof window.showSaveFilePicker === 'function';
const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

function download(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function write(handle, bytes) {
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

function opener(bytes, mime) {
  return () => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  };
}

/**
 * Asks where to save (first, while the click still counts as the user's), makes the file(s) and
 * writes them. Returns { text, open? } for the status line, or null when the user cancelled.
 */
export async function saveAs(items, formatIndex, dpi, stem, progress) {
  const f = FORMATS[formatIndex];
  const pages = items.reduce((n, it) => n + it.pages.filter(p => p.included).length, 0);
  const many = f.image && !f.oneFile && pages > 1;
  const names = many ? numberedNames(stem, f.ext, pages) : [`${stem}.${f.ext}`];

  // 1. where
  let fileHandle = null, folder = null;
  try {
    if (many && canPickFolder()) {
      folder = await window.showDirectoryPicker({ id: 'pdf-combiner-save', mode: 'readwrite' });
      const existing = [];
      for (const n of names) {
        try { await folder.getFileHandle(n); existing.push(n); } catch { /* not there */ }
      }
      if (existing.length && !confirm(`${existing.length} of the ${names.length} picture files (${names[0]} … ${names[names.length - 1]}) already exist. Replace them?`)) return null;
    } else if (!many && canPickFile()) {
      fileHandle = await window.showSaveFilePicker({
        id: 'pdf-combiner-save',
        suggestedName: names[0],
        types: [{ description: f.name, accept: { [f.mime]: ['.' + f.ext] } }],
      });
      names[0] = fileHandle.name;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }

  // 2. make it
  const ex = await exportModule();
  let files, total;
  if (f.image) {
    const kind = ex.IMAGE_KINDS.find(k => k.ext === f.ext);
    const r = await ex.saveImages(items, kind, dpi, progress);
    files = r.files;
    total = r.pages;
  } else {
    const r = formatIndex === 0 ? await ex.combinePdf(items, progress) : formatIndex === 1 ? await ex.toExcel(items, progress) : await ex.toDxf(items, progress);
    files = [r.bytes];
    total = r.pages;
  }

  // 3. write it
  progress('Saving…');
  if (folder) {
    for (let i = 0; i < files.length; i++) await write(await folder.getFileHandle(names[i], { create: true }), files[i]);
  } else if (fileHandle) {
    await write(fileHandle, files[0]);
  } else {
    files.forEach((b, i) => download(b, names[i], f.mime));
  }

  const plural = total === 1 ? 'page' : 'pages';
  const where = folder ? ` in ${folder.name}` : '';
  const text = files.length === 1
    ? `✓  Saved ${total} ${plural} to ${names[0]}`
    : `✓  Saved ${total} pages as ${names[0]} … ${names[files.length - 1]}${where}`;
  const viewable = files.length === 1 && (f.ext === 'pdf' || (f.image && f.ext !== 'tif'));
  return { text, open: viewable ? opener(files[0], f.mime) : null };
}
