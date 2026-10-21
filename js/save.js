// What can be saved, and writing it where the user picks (the browser's Save dialog, a folder
// for several pictures, or a plain download when the browser can't do either).

const exportModule = () => import('./export/index.js');

const image = (name, ext, mime, oneFile = false, label = `${name} image`) => ({
  id: ext,
  group: 'Pictures',
  name: `${label}${oneFile ? ' (all pages in one file)' : ''}`,
  short: name,
  what: `${name} image`,
  ext,
  mime,
  image: true,
  perPage: !oneFile,
  oneFile,
  into: (pages) => (oneFile || pages === 1 ? `${name} file.` : `${name} files, one per page.`),
});

// make: (export module, items, dpi, progress) -> { files: Uint8Array[], pages }
const one = (f) => async (ex, items, dpi, progress) => {
  const r = await f(ex, items, dpi, progress);
  return { files: [r.bytes], pages: r.pages };
};

const doc = (id, group, name, short, what, ext, mime, into, make, extra = {}) =>
  ({ id, group, name, short, what, ext, mime, into: () => into, make: one(make), ...extra });

export const FORMATS = [
  doc('pdf', 'Documents', 'PDF', 'PDF', 'PDF', 'pdf', 'application/pdf', 'PDF.', (ex, it, _d, p) => ex.combinePdf(it, p)),
  {
    id: 'pdf-pages', group: 'Documents', name: 'PDF, one file per page', short: 'PDF pages', what: 'PDF', ext: 'pdf', mime: 'application/pdf',
    perPage: true, into: (pages) => (pages === 1 ? 'PDF.' : 'PDFs, one per page.'), make: (ex, it, _d, p) => ex.splitPdf(it, p),
  },
  doc('docx', 'Documents', 'Word document (.docx)', 'Word', 'Word document', 'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word document.', (ex, it, d, p) => ex.toDocx(it, d, p)),
  doc('odt', 'Documents', 'OpenDocument text (.odt)', 'ODT', 'document', 'odt',
    'application/vnd.oasis.opendocument.text', 'OpenDocument text file.', (ex, it, d, p) => ex.toOdt(it, d, p)),
  doc('rtf', 'Documents', 'Rich text (.rtf)', 'RTF', 'document', 'rtf', 'application/rtf', 'rich text file.', (ex, it, d, p) => ex.toRtf(it, d, p)),
  doc('txt', 'Documents', 'Plain text (.txt)', 'Text', 'text file', 'txt', 'text/plain', 'text file.', (ex, it, _d, p) => ex.toText(it, p)),
  doc('html', 'Documents', 'Web page (.html)', 'Web page', 'web page', 'html', 'text/html', 'web page.', (ex, it, d, p) => ex.toHtml(it, d, p)),
  doc('pptx', 'Documents', 'PowerPoint (.pptx), a slide per page', 'PowerPoint', 'presentation', 'pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint, a slide per page.', (ex, it, d, p) => ex.toPptx(it, d, p)),

  doc('xlsx', 'Spreadsheets', 'Excel (.xlsx)', 'Excel', 'spreadsheet', 'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet.', (ex, it, _d, p) => ex.toExcel(it, p)),
  doc('ods', 'Spreadsheets', 'OpenDocument spreadsheet (.ods)', 'ODS', 'spreadsheet', 'ods',
    'application/vnd.oasis.opendocument.spreadsheet', 'spreadsheet.', (ex, it, _d, p) => ex.toOds(it, p)),
  doc('csv', 'Spreadsheets', 'CSV (.csv)', 'CSV', 'CSV file', 'csv', 'text/csv', 'CSV file.', (ex, it, _d, p) => ex.toCsv(it, p)),

  doc('dxf', 'Drawings', 'DXF drawing (.dxf)', 'DXF', 'DXF', 'dxf', 'application/dxf', 'DXF drawing.', (ex, it, _d, p) => ex.toDxf(it, p)),
  {
    id: 'svg', group: 'Drawings', name: 'SVG drawing (.svg)', short: 'SVG', what: 'SVG drawing', ext: 'svg', mime: 'image/svg+xml', perPage: true,
    into: (pages) => (pages === 1 ? 'SVG drawing.' : 'SVG drawings, one per page.'), make: (ex, it, d, p) => ex.toSvg(it, d, p),
  },
  {
    id: 'eps', group: 'Drawings', name: 'EPS drawing (.eps)', short: 'EPS', what: 'EPS drawing', ext: 'eps', mime: 'application/postscript', perPage: true,
    into: (pages) => (pages === 1 ? 'EPS drawing.' : 'EPS drawings, one per page.'), make: (ex, it, d, p) => ex.toEps(it, d, p),
  },

  image('PNG', 'png', 'image/png'),
  image('JPEG', 'jpg', 'image/jpeg'),
  image('WebP', 'webp', 'image/webp'),
  image('AVIF', 'avif', 'image/avif'),
  image('GIF', 'gif', 'image/gif'),
  image('BMP', 'bmp', 'image/bmp'),
  image('TIFF', 'tif', 'image/tiff', true),
  image('Photoshop', 'psd', 'image/vnd.adobe.photoshop', false, 'Photoshop (.psd)'),
  image('TGA', 'tga', 'image/x-tga'),
  image('PPM', 'ppm', 'image/x-portable-pixmap'),
  image('Icon', 'ico', 'image/x-icon', false, 'Windows icon (.ico)'),
];

/** The format with this id; old saved settings held the index in the first list of nine. */
export function formatIndex(saved) {
  const old = ['pdf', 'xlsx', 'dxf', 'png', 'jpg', 'bmp', 'gif', 'tif', 'webp'];
  const id = typeof saved === 'number' || /^\d+$/.test(String(saved)) ? old[+saved] : saved;
  return Math.max(0, FORMATS.findIndex((f) => f.id === id));
}

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
  const many = f.perPage && pages > 1;
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
      if (existing.length && !confirm(`${existing.length} of the ${names.length} files (${names[0]} … ${names[names.length - 1]}) already exist. Replace them?`)) return null;
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
  const r = f.image
    ? await ex.saveImages(items, ex.IMAGE_KINDS.find(k => k.ext === f.ext), dpi, progress)
    : await f.make(ex, items, dpi, progress);
  const files = r.files, total = r.pages;

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
  const viewable = files.length === 1 && (['pdf', 'txt', 'html', 'svg'].includes(f.ext) || (f.image && ['png', 'jpg', 'webp', 'avif', 'gif', 'bmp', 'ico'].includes(f.ext)));
  return { text, open: viewable ? opener(files[0], f.mime) : null };
}
