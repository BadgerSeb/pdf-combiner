// Tests for js/export: unit checks of the pieces, then every export on the sample PDFs.
// Outputs are saved through the test server (PUT /__out/<name>); the summary goes to "done".

import { openPdf, pageSizes, renderPage } from '../js/pdfjs.js';
import { PDFDocument, PDFName } from '../vendor/pdf-lib.esm.min.js';
import { combinePdf, toExcel, toDxf, IMAGE_KINDS, RESOLUTIONS, targetNames, saveImages } from '../js/export/index.js';
import { Lexer, Mat } from '../js/export/content.js';
import { parseCmap, glyphText, FontInfo } from '../js/export/font.js';
import { lines } from '../js/export/layout.js';
import { asNumber, columnSpans, spanAt, sheetNames, columnName } from '../js/export/excel.js';
import { arc, DxfWriter, num, escape, aci } from '../js/export/dxf.js';
import { lzw } from '../js/export/images.js';
import { md5 } from '../js/export/decrypt.js';
import '../vendor/UTIF.js';
import { encryptPdf } from './export-encrypt.js';

const log = [];
let failures = 0;
const out = (name, body) => fetch('/__out/' + encodeURIComponent(name), { method: 'PUT', body });
function check(what, ok, detail = '') {
  if (!ok) failures++;
  log.push(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = (s) => new TextEncoder().encode(s);
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b) => new TextDecoder('latin1').decode(b);

async function sample(name) {
  return new Uint8Array(await (await fetch('samples/' + encodeURIComponent(name))).arrayBuffer());
}

/** An item as the UI makes it: page sizes from pdf.js, all included, no extra rotation. */
async function item(name, bytes) {
  const doc = await openPdf(bytes);
  const sizes = await pageSizes(doc);
  await (doc.destroy ? doc.destroy() : doc.loadingTask.destroy());
  return { name, bytes, pages: sizes.map((s) => ({ ...s, included: true, rotation: 0 })) };
}

async function expectError(what, promise, message) {
  try {
    await promise;
    check(what, false, 'no error');
  } catch (e) {
    check(what, e.message === message || (message instanceof RegExp && message.test(e.message)), e.message);
  }
}

// ------------------------------------------------------------ unit checks

function units() {
  // lexer
  const all = (s) => {
    const l = new Lexer(bytesOf(s));
    const t = [];
    for (let x; (x = l.next()) !== null; ) t.push(x);
    return t;
  };
  const norm = (t) => JSON.stringify(t, (k, v) => (v instanceof Uint8Array ? [...v] : v));
  let t = all('q 1 0 0 -1.5 .5 +3 cm /F#201 12 Tf (a\\(b\\)\\101\\n) Tj <48 65 6> Tj [(x) -250 (y)] TJ % note\nQ');
  check('lexer: tokens', t[0].v === 'q' && t[4].v === -1.5 && t[5].v === 0.5 && t[6].v === 3 && t[8].t === 'name' && t[8].v === 'F 1' &&
    eq([...t[11].v], [...bytesOf('a(b)A\n')]) && eq([...t[13].v], [0x48, 0x65, 0x60]) &&
    norm(t[15]) === norm({ t: 'arr', v: [{ t: 'str', v: bytesOf('x') }, { t: 'num', v: -250 }, { t: 'str', v: bytesOf('y') }] }) &&
    t.at(-1).v === 'Q', norm(t));
  t = all('/P <</MCID 3>> BDC BI /W 2 /H 1 /BPC 8 ID \x01EI\x02 EI Q');
  check('lexer: inline images and dicts skipped', norm(t) === norm([{ t: 'name', v: 'P' }, { t: 'name', v: '<<dict>>' }, { t: 'op', v: 'BDC' }, { t: 'op', v: 'Q' }]), norm(t));
  t = all('1.2.3 -inf 5. --1');
  check('lexer: odd words are operators', norm(t) === norm([{ t: 'op', v: '1.2.3' }, { t: 'op', v: '-inf' }, { t: 'num', v: 5 }, { t: 'op', v: '--1' }]), norm(t));
  const m = new Mat(2, 0, 0, 2, 10, 0).then(new Mat(0, 1, -1, 0, 0, 0));
  check('matrices', eq(m.apply(1, 0), [0, 12]));

  // CMaps and fonts
  const cmap = bytesOf('/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
    '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
    '2 beginbfchar <0003> <0020> <0011> <00660069> endbfchar\n' +
    '2 beginbfrange <0024> <0026> <0041> <0030> <0031> [<0078> <D83DDE00>] endbfrange\n' +
    '1 beginbfchar <0040> <D800> endbfchar\nendcmap');
  const map = new Map(parseCmap(cmap));
  check('CMap: bfchar and bfrange', map.get(3) === ' ' && map.get(0x11) === 'fi' && map.get(0x24) === 'A' && map.get(0x26) === 'C' &&
    map.get(0x30) === 'x' && map.get(0x31) === '😀' && map.get(0x40) === '\uFFFD', JSON.stringify([...map]));
  check('glyph names', glyphText('degree') === '°' && glyphText('A.sc') === 'A' && glyphText('uni2300') === '⌀' &&
    glyphText('u1F600') === '😀' && glyphText('g123') === null && glyphText('uniD800') === null);
  const f = new FontInfo(null, null);
  const codes = f.decode(bytesOf('A \x80'));
  check('fallback font', codes.map((c) => c.text).join('') === 'A €' && codes[1].isSpace && codes[0].width === 0.5);

  // layout
  const glyph = (s, x, y) => ({ text: s, x, y, advance: 6, size: 10, angle: 0, visible: true, color: { r: 0, g: 0, b: 0 } });
  const word = (s, x, y) => [...s].map((c, i) => glyph(c, x + 6 * i, y));
  const g = [...word('Qty', 300, 700), ...word('Part', 50, 700), ...word('no', 79, 700), ...word('Bolt', 50, 680), glyph('B', 50.2, 680)];
  const ls = lines(g, 0.55, null);
  check('layout: words, lines and chunks', ls.length === 2 && eq(ls[0].chunks.map((c) => c.text), ['Part no', 'Qty']) && ls[1].chunks[0].text === 'Bolt',
    JSON.stringify(ls.map((l) => l.chunks.map((c) => c.text))));
  check('layout: rules split cells', lines(word('ab', 50, 700), 0.55, [{ x: 56.2, y0: 690, y1: 720 }])[0].chunks.length === 2);

  // number detection
  const nums = [['25', [25, 'plain']], ['$1,240.00', [1240, 'money']], ['6.625%', [0.06625, 'percent']], ['(12.50)', [-12.5, 'plain']],
    ['−3', [-3, 'plain']], ['-$4.5', [-4.5, 'money']], ['0.5', [0.5, 'plain']], ['.5', [0.5, 'plain']], ['0', [0, 'plain']],
    ['00412', null], ['07-115', null], ['1,23', null], ['1234,567', null], ['(5', null], ['$', null], ['1234567890123456', null],
    ['BMF-2210', null], ['12.', null]];
  const bad = nums.filter(([s, want]) => !eq(asNumber(s), want));
  check('number detection (18 cases)', !bad.length, JSON.stringify(bad.map(([s]) => [s, asNumber(s)])));

  // column spans
  const cover = new Int32Array(20);
  for (let x = 2; x < 6; x++) cover[x] = 3;
  for (let x = 10; x < 15; x++) cover[x] = 2;
  cover[8] = 1;
  const sp = columnSpans(cover, 1);
  check('column spans', eq(sp, [[2, 6], [10, 15]]) && spanAt(sp, 1.5) === 0 && spanAt(sp, 8) === 0 && spanAt(sp, 9.2) === 1 &&
    spanAt(sp, 30) === 1 && eq(columnSpans(new Int32Array(2), 0), [[0, 2]]), JSON.stringify(sp));
  check('sheet names', eq(sheetNames(['a/b', 'A B', '', 'x'.repeat(40), "'quoted'"]), ['a b', 'A B 2', 'Sheet', 'x'.repeat(28), 'quoted']));
  check('column names', columnName(0) === 'A' && columnName(25) === 'Z' && columnName(26) === 'AA' && columnName(701) === 'ZZ' && columnName(702) === 'AAA');

  // arc fitting
  const quarter = (cx, cy, r) => {
    const k = 0.55228475 * r;
    return { curve: true, x0: cx + r, y0: cy, x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x3: cx, y3: cy + r };
  };
  const a = arc(quarter(100, 50, 20));
  check('arc fitting: quarter circle', a && Math.abs(a[0] - 100) < 0.01 && Math.abs(a[1] - 50) < 0.01 && Math.abs(a[2] - 20) < 0.01 &&
    Math.abs(a[3] - Math.PI / 2) < 1e-3, JSON.stringify(a));
  check('arc fitting: S-curve is not an arc', arc({ curve: true, x0: 0, y0: 0, x1: 30, y1: 30, x2: 0, y2: 30, x3: 30, y3: 0 }) === null);
  const r = 36, k = 0.55228475 * r;
  const segs = [
    { curve: true, x0: r, y0: 0, x1: r, y1: k, x2: k, y2: r, x3: 0, y3: r },
    { curve: true, x0: 0, y0: r, x1: -k, y1: r, x2: -r, y2: k, x3: -r, y3: 0 },
    { curve: true, x0: -r, y0: 0, x1: -r, y1: -k, x2: -k, y2: -r, x3: 0, y3: -r },
    { curve: true, x0: 0, y0: -r, x1: k, y1: -r, x2: r, y2: -k, x3: r, y3: 0 },
  ];
  const w = new DxfWriter();
  w.shape({ segs, closed: true }, 'Lines', 7);
  check('circle from four arcs', w.entities[0].startsWith('0\r\nCIRCLE\r\n') && w.entities[0].includes('40\r\n0.5\r\n'));
  check('DXF numbers, text and colors', num(1) === '1' && num(-0.0000001) === '0' && num(2.3181264) === '2.318126' &&
    num(-0.41448712) === '-0.414487' && escape('Ø1.5 ±0.01 90° é') === '%%c1.5 %%p0.01 90%%d \\U+00E9' &&
    aci({ r: 255, g: 255, b: 255 }) === 9 && aci({ r: 220, g: 30, b: 30 }) === 1 && aci({ r: 0, g: 0, b: 0 }) === 7);

  // picture names
  const png = IMAGE_KINDS[0], tif = IMAGE_KINDS[4];
  check('targetNames', eq(targetNames('Quote.png', 1, png), ['Quote.png']) && targetNames('Quote.png', 3, png)[2] === 'Quote - 03.png' &&
    targetNames('Quote.png', 120, png)[0] === 'Quote - 001.png' && eq(targetNames('All.tif', 5, tif), ['All.tif']) &&
    targetNames('C:\\out\\Combined.png', 2, png)[1] === 'C:\\out\\Combined - 02.png');
  check('kinds and resolutions', eq(IMAGE_KINDS.map((k) => k.ext), ['png', 'jpg', 'bmp', 'gif', 'tif', 'webp']) && eq(RESOLUTIONS, [100, 150, 200, 300, 600]));

  // MD5 for decryption
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  check('md5', hex(md5(new Uint8Array(0))) === 'd41d8cd98f00b204e9800998ecf8427e' && hex(md5(enc('abc'))) === '900150983cd24fb0d6963f7d28e17f72' &&
    hex(md5(enc('a'.repeat(1000)))) === 'cabe45dcc9ae5b66ba86600cca6b8ba8');
}

/** Decodes an LZW strip the TIFF way, to check the encoder against UTIF's decoder. */
function lzwRoundTrip() {
  const data = new Uint8Array(200000);
  let seed = 7;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = i % 3000 < 1500 ? (seed >> 16) & 255 : (i >> 6) & 7; // noise, then long runs
  }
  const packed = lzw(data);
  const back = new Uint8Array(data.length);
  self.UTIF.decode._decodeLZW(packed, 0, packed.length, back, 0, 8);
  check('LZW encoder vs UTIF decoder', back.every((v, i) => v === data[i]), `${data.length} -> ${packed.length} bytes`);
}

// ------------------------------------------------------------ the exports

async function run() {
  units();
  lzwRoundTrip();

  const quoteBytes = await sample('Quote 1042 table.pdf');
  const lineBytes = await sample('Line Card.pdf');
  const shapesBytes = await sample('shapes.pdf');
  const quote = await item('Quote 1042 table.pdf', quoteBytes);
  const line = await item('Line Card.pdf', lineBytes);
  const shapes = await item('shapes.pdf', shapesBytes);
  const progress = [];
  const p = (s) => progress.push(s);

  // combine: Line Card page 1 skipped, page 2 turned 90 degrees, then the quote and shapes
  const lineSkip = structuredClone(line);
  lineSkip.pages[0].included = false;
  lineSkip.pages[1].rotation = 90;
  let t = performance.now();
  const comb = await combinePdf([lineSkip, quote, shapes], p);
  log.push(`combine ms ${Math.round(performance.now() - t)}, ${comb.bytes.length} bytes`);
  await out('combined.pdf', comb.bytes);
  const back = await PDFDocument.load(comb.bytes, { updateMetadata: false });
  const rots = back.getPages().map((pg) => pg.getRotation().angle);
  const info = back.getInfoDict();
  check('combine: 3 pages, rotations', comb.pages === 3 && back.getPageCount() === 3 && eq(rots, [90, 0, 0]), JSON.stringify(rots));
  check('combine: Creator/Producer', back.getCreator() === 'PDF Combiner' && back.getProducer() === 'PDF Combiner', `${back.getCreator()} / ${back.getProducer()}`);
  const cdoc = await openPdf(comb.bytes);
  for (let i = 0; i < 3; i++) {
    const c = await renderPage(cdoc, i, 500, 0);
    await out(`combined-${i + 1}.png`, await new Promise((r) => c.toBlob(r, 'image/png')));
  }
  await (cdoc.destroy ? cdoc.destroy() : cdoc.loadingTask.destroy());
  const none = structuredClone(quote);
  none.pages.forEach((pg) => (pg.included = false));
  await expectError('combine: nothing selected', combinePdf([none], p), 'No pages are selected.');
  await expectError('combine: not a PDF', combinePdf([{ name: 'junk.pdf', bytes: enc('hello'), pages: [{ width: 1, height: 1, included: true, rotation: 0 }] }], p),
    /^junk\.pdf couldn't be read as a PDF \(/);

  // Excel
  t = performance.now();
  const xq = await toExcel([quote], p);
  log.push(`excel ms ${Math.round(performance.now() - t)}`);
  await out('quote.xlsx', xq.bytes);
  await out('linecard.xlsx', (await toExcel([line], p)).bytes);
  const xm = await toExcel([quote, line, shapes], p);
  await out('multi.xlsx', xm.bytes);
  check('excel: page counts', xq.pages === 1 && xm.pages === 4);
  const q90 = structuredClone(quote);
  q90.pages[0].rotation = 90;
  await expectError('excel: no horizontal text', toExcel([q90], p),
    'No text was found on the selected pages. They look like scans or pictures, and a spreadsheet can only be made from pages with real text (made by a program such as Word, Excel or SOLIDWORKS).');

  // DXF
  const rot = (it, deg) => {
    const c = structuredClone(it);
    c.pages.forEach((pg) => (pg.rotation = deg));
    return c;
  };
  t = performance.now();
  await out('shapes.dxf', (await toDxf([shapes], p)).bytes);
  log.push(`dxf shapes ms ${Math.round(performance.now() - t)}`);
  await out('quote.dxf', (await toDxf([quote], p)).bytes);
  t = performance.now();
  await out('linecard.dxf', (await toDxf([line], p)).bytes);
  log.push(`dxf line card ms ${Math.round(performance.now() - t)}`);
  await out('multi.dxf', (await toDxf([shapes, quote, line], p)).bytes);
  await out('shapes_rot90.dxf', (await toDxf([rot(shapes, 90)], p)).bytes);
  await out('shapes_rot270.dxf', (await toDxf([rot(shapes, 270)], p)).bytes);

  // pictures: every kind of the Line Card at 150 dpi (page 2 turned 90 degrees)
  for (const kind of IMAGE_KINDS) {
    const it = structuredClone(line);
    it.pages[1].rotation = 90;
    const dpi = kind.oneFile ? 100 : 150;
    const items = kind.oneFile ? [rot(line, 90), shapes] : [it];
    t = performance.now();
    try {
      const res = await saveImages(items, kind, dpi, p);
      const names = targetNames(`lc.${kind.ext}`, res.pages, kind);
      check(`${kind.name}: ${res.files.length} file(s)`, res.files.length === names.length);
      for (let i = 0; i < res.files.length; i++) await out(names[i], res.files[i]);
      log.push(`  ${kind.name} ms ${Math.round(performance.now() - t)}, sizes ${res.files.map((f) => f.length).join(', ')}`);
      if (kind.ext === 'webp') check('WebP header', text(res.files[0].subarray(0, 4)) === 'RIFF' && text(res.files[0].subarray(8, 12)) === 'WEBP');
      if (kind.ext === 'tif') {
        const ifds = self.UTIF.decode(res.files[0].buffer);
        self.UTIF.decodeImage(res.files[0].buffer, ifds[0]);
        const rgba = self.UTIF.toRGBA8(ifds[0]);
        // compare a few pixels with a fresh render of the same page
        const doc = await openPdf(lineBytes);
        const c = await renderPage(doc, 0, ifds[0].width, 90);
        await (doc.destroy ? doc.destroy() : doc.loadingTask.destroy());
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let diff = 0;
        for (let k = 0; k < px.length; k += 4) diff = Math.max(diff, Math.abs(px[k] - rgba[k]), Math.abs(px[k + 1] - rgba[k + 1]), Math.abs(px[k + 2] - rgba[k + 2]));
        check('TIFF: decodes (UTIF) to the rendered pixels', ifds.length === 3 && c.width === ifds[0].width && c.height === ifds[0].height && diff === 0,
          `${ifds.length} pages, ${ifds.map((d) => d.t256[0] + 'x' + d.t257[0]).join(' ')}, max diff ${diff}`);
      }
    } catch (e) {
      check(`${kind.name}`, false, e.stack);
    }
  }
  await expectError('pictures: nothing selected', saveImages([none], IMAGE_KINDS[0], 150, p), 'No pages are selected.');

  // encrypted PDFs that open without a password: made here (pdf.js reading them shows they're
  // proper), and the lopdf-made one the desktop app's tests use (Line Card, RC4 128 bit)
  const plainDxf = text((await toDxf([quote], p)).bytes);
  for (const [label, method, os] of [['RC4', 'RC4', false], ['RC4 in object streams', 'RC4', true], ['AES-128', 'AESV2', false], ['AES-256', 'AESV3', false]]) {
    try {
      const bytes = await encryptPdf(quoteBytes, method, os);
      await out(`enc-${method}${os ? '-objstm' : ''}.pdf`, bytes);
      const d = await openPdf(bytes);
      const tc = await (await d.getPage(1)).getTextContent();
      await (d.destroy ? d.destroy() : d.loadingTask.destroy());
      const pdfjsOk = tc.items.some((i) => i.str.includes('Quote 1042'));
      const it = { ...quote, name: 'enc.pdf', bytes };
      const dxf = text((await toDxf([it], p)).bytes);
      const comb = await combinePdf([it], p);
      const again = text((await toDxf([{ ...quote, name: 'c.pdf', bytes: comb.bytes }], p)).bytes);
      check(`encrypted (${label}): pdf.js reads it; DXF and combined copy match the plain file`, pdfjsOk && dxf === plainDxf && again === plainDxf,
        `pdf.js ${pdfjsOk}, dxf ${dxf === plainDxf}, combined ${again === plainDxf}`);
    } catch (e) {
      check(`encrypted (${label})`, false, e.stack);
    }
  }
  const ownerBytes = new Uint8Array(await (await fetch('out/export/enc-owner.pdf')).arrayBuffer());
  const userBytes = new Uint8Array(await (await fetch('out/export/enc-user.pdf')).arrayBuffer());
  if (ownerBytes.length > 1000) {
    const lineDxf = text((await toDxf([line], p)).bytes);
    const ownerDxf = text((await toDxf([{ ...line, name: 'enc-owner.pdf', bytes: ownerBytes }], p)).bytes);
    check('encrypted by lopdf (owner password only): DXF matches the plain file', ownerDxf === lineDxf);
    await expectError('encrypted by lopdf with a user password: refused', toDxf([{ ...line, name: 'enc-user.pdf', bytes: userBytes }], p),
      "enc-user.pdf is password-protected, so its pages can't be read.");
  } else {
    log.push('(lopdf-encrypted samples not present; skipped)');
  }

  log.push('progress: ' + [...new Set(progress)].slice(0, 12).join(' | '));
}

try {
  await run();
} catch (e) {
  failures++;
  log.push('ERROR ' + e.stack);
}
log.unshift(failures ? `${failures} FAILED` : 'all passed');
await out('done', log.join('\n'));
