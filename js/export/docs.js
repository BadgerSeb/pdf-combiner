// Documents: plain text, Word, OpenDocument text, RTF and a web page from the text on the pages,
// and PowerPoint with a picture of each page on its own slide.
//
// A page with text becomes editable paragraphs (one per line, at about its size). A page with no
// text (a scan) or one that is mostly drawing (lines far outnumber text) goes in as a picture.

import { zipSync } from '../../vendor/fflate.js';
import * as layout from './layout.js';
import { forEachPage, fileStem } from './pages.js';
import { renderEach, pngOf } from './images.js';
import { clean, xml } from './excel.js';
import { odfPackage } from './tables.js';

const enc = new TextEncoder();
const NO_TEXT = 'No text was found on the selected pages. They look like scans or pictures, and a text file can only be made from pages with real text.';

/** The text lines of a page, top to bottom: [{ text, size, gap (a blank line before it) }]. */
export function textLines(page) {
  const ls = layout.lines(page.glyphs, 0.55, null);
  const flat = ls.filter((l) => l.angle === 0).sort((a, b) => b.perp - a.perp);
  const others = ls.filter((l) => l.angle !== 0);
  const out = [];
  let last = null;
  for (const l of [...flat, ...others]) {
    const text = clean(l.chunks.map((c) => c.text).join('    '));
    if (!text) continue;
    const gap = last !== null && l.angle === 0 && last.angle === 0 && last.perp - l.perp > 1.9 * Math.max(l.size, last.size);
    out.push({ text, size: l.size, gap });
    last = l;
  }
  return out;
}

/**
 * The included pages as [{ width, height (points), lines, picture: { png, w, h } | null }].
 * With `pictures`, scans and drawings are rendered at `dpi`.
 */
async function readDocument(items, dpi, progress, pictures) {
  const pages = [];
  const want = new Set();
  await forEachPage(items, progress, (k, i, page) => {
    const lines = textLines(page);
    const picture = pictures && (!lines.length || page.paths.length > 4 * lines.length + 40);
    if (picture) want.add(`${k}/${i}`);
    pages.push({ k, i, width: page.width, height: page.height, lines: picture ? [] : lines, picture: null });
  });
  if (want.size) {
    await renderEach(items, dpi, progress, async (canvas, scale, k, i) => {
      const p = pages.find((x) => x.k === k && x.i === i);
      p.picture = { png: await pngOf(canvas, scale), w: canvas.width, h: canvas.height };
    }, (k, i) => want.has(`${k}/${i}`));
  }
  return pages;
}

/** The size to show a picture page at, in points, within `maxW` x `maxH`. */
function fit(p, maxW, maxH) {
  const k = Math.min(1, maxW / p.width, maxH / p.height);
  return [p.width * k, p.height * k];
}

const half = (size) => Math.round(Math.min(72, Math.max(6, size)) * 2); // half-points

// ------------------------------------------------------------ plain text

export async function toText(items, progress) {
  const pages = await readDocument(items, 0, progress, false);
  if (!pages.some((p) => p.lines.length)) throw new Error(NO_TEXT);
  progress('Saving…');
  const out = [];
  pages.forEach((p, n) => {
    if (n > 0) out.push('', '');
    for (const l of p.lines) {
      if (l.gap) out.push('');
      out.push(l.text);
    }
  });
  return { bytes: enc.encode(out.join('\r\n') + '\r\n'), pages: pages.length };
}

// ------------------------------------------------------------ Word

export async function toDocx(items, dpi, progress) {
  const pages = await readDocument(items, dpi, progress, true);
  progress('Saving…');
  const media = {};
  let rels = '', pics = 0;
  const body = [];
  pages.forEach((p, n) => {
    if (n > 0) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    if (p.picture) {
      pics++;
      const [w, h] = fit(p, 468, 648); // 6.5 x 9 in
      const cx = Math.round(w * 12700), cy = Math.round(h * 12700);
      media[`word/media/page${pics}.png`] = p.picture.png;
      rels += `<Relationship Id="rIdP${pics}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page${pics}.png"/>`;
      body.push(`<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
        `<wp:docPr id="${pics}" name="Page ${n + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${pics}" name="page${pics}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="rIdP${pics}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>');
    }
    for (const l of p.lines) {
      if (l.gap) body.push('<w:p/>');
      body.push(`<w:p><w:r><w:rPr><w:sz w:val="${half(l.size)}"/></w:rPr><w:t xml:space="preserve">${xml(l.text)}</w:t></w:r></w:p>`);
    }
  });
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const document = HEAD + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<w:body>' + body.join('') +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';
  const styles = HEAD + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>';
  const files = {
    '[Content_Types].xml': HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': document,
    'word/styles.xml': styles,
    'word/_rels/document.xml.rels': HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + rels + '</Relationships>',
  };
  const zipped = {};
  for (const [k, v] of Object.entries(files)) zipped[k] = enc.encode(v);
  for (const [k, v] of Object.entries(media)) zipped[k] = [v, { level: 0 }];
  return { bytes: zipSync(zipped, { level: 6 }), pages: pages.length };
}

// ------------------------------------------------------------ OpenDocument text

export async function toOdt(items, dpi, progress) {
  const pages = await readDocument(items, dpi, progress, true);
  progress('Saving…');
  const sizes = new Set();
  const pictures = {};
  const body = [];
  pages.forEach((p, n) => {
    if (n > 0) body.push('<text:p text:style-name="Break"/>');
    if (p.picture) {
      const name = `Pictures/page${n + 1}.png`;
      pictures[name] = p.picture.png;
      const [w, h] = fit(p, 468, 648);
      body.push(`<text:p><draw:frame draw:name="Page ${n + 1}" text:anchor-type="as-char" svg:width="${(w / 72).toFixed(3)}in" svg:height="${(h / 72).toFixed(3)}in">` +
        `<draw:image xlink:href="${name}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`);
    }
    for (const l of p.lines) {
      const s = half(l.size);
      sizes.add(s);
      if (l.gap) body.push(`<text:p text:style-name="S${s}"/>`);
      body.push(`<text:p text:style-name="S${s}">${odfText(l.text)}</text:p>`);
    }
  });
  const styles = [...sizes].map((s) => `<style:style style:name="S${s}" style:family="paragraph"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0in"/>` +
    `<style:text-properties style:font-name="Calibri" fo:font-family="Calibri" fo:font-size="${s / 2}pt"/></style:style>`).join('');
  const content = '<?xml version="1.0" encoding="UTF-8"?><office:document-content ' +
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
    'xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">' +
    '<office:automatic-styles><style:style style:name="Break" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>' +
    styles + '</office:automatic-styles><office:body><office:text>' + body.join('') + '</office:text></office:body></office:document-content>';
  return { bytes: odfPackage('application/vnd.oasis.opendocument.text', content, pictures), pages: pages.length };
}

/** Text for an ODF paragraph: runs of spaces and tabs kept. */
function odfText(s) {
  return xml(s).replace(/\t/g, '<text:tab/>').replace(/ {2,}/g, (m) => ` <text:s text:c="${m.length - 1}"/>`);
}

// ------------------------------------------------------------ RTF

export async function toRtf(items, dpi, progress) {
  const pages = await readDocument(items, dpi, progress, true);
  progress('Saving…');
  const out = ['{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Calibri;}}\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440\\f0\\fs22\n'];
  pages.forEach((p, n) => {
    if (n > 0) out.push('\\page\n');
    if (p.picture) {
      const [w, h] = fit(p, 468, 648);
      out.push(`{\\pict\\pngblip\\picw${p.picture.w}\\pich${p.picture.h}\\picwgoal${Math.round(w * 20)}\\pichgoal${Math.round(h * 20)}\n`);
      out.push(hexLines(p.picture.png), '}\\par\n');
    }
    for (const l of p.lines) {
      if (l.gap) out.push('\\pard\\par\n');
      out.push(`\\pard{\\fs${half(l.size)} ${rtfText(l.text)}}\\par\n`);
    }
  });
  out.push('}');
  return { bytes: enc.encode(out.join('')), pages: pages.length };
}

function rtfText(s) {
  let r = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') r += '\\' + ch;
    else if (ch === '\t') r += '\\tab ';
    else if (c < 128) r += ch;
    else {
      for (let i = 0; i < ch.length; i++) {
        const u = ch.charCodeAt(i);
        r += `\\u${u > 32767 ? u - 65536 : u}?`;
      }
    }
  }
  return r;
}

function hexLines(bytes) {
  const HEX = '0123456789abcdef';
  const parts = [];
  for (let i = 0; i < bytes.length; i += 64) {
    let line = '';
    for (const b of bytes.subarray(i, i + 64)) line += HEX[b >> 4] + HEX[b & 15];
    parts.push(line);
  }
  return parts.join('\n') + '\n';
}

// ------------------------------------------------------------ web page

export async function toHtml(items, dpi, progress) {
  const pages = await readDocument(items, dpi, progress, true);
  progress('Saving…');
  const title = xml(fileStem(items.find((it) => it.pages.some((p) => p.included))?.name || 'PDF Combiner'));
  const body = pages.map((p, n) => {
    const parts = [`<section id="page-${n + 1}">`];
    if (p.picture) parts.push(`<img src="data:image/png;base64,${base64(p.picture.png)}" width="${Math.round(fit(p, 612, 1e6)[0])}" alt="Page ${n + 1}">`);
    for (const l of p.lines) parts.push(`<p${l.gap ? ' class="gap"' : ''} style="font-size:${(half(l.size) / 2)}pt">${xml(l.text)}</p>`);
    parts.push('</section>');
    return parts.join('\n');
  });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { margin: 0; background: #e9eaec; font-family: Calibri, Arial, sans-serif; color: #111; }
  section { max-width: 8.5in; box-sizing: border-box; margin: 24px auto; padding: 0.75in; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  section:has(img:only-child) { padding: 0; }
  p { margin: 0; white-space: pre-wrap; }
  p.gap { margin-top: 1em; }
  img { display: block; max-width: 100%; height: auto; }
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`;
  return { bytes: enc.encode(html), pages: pages.length };
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------ PowerPoint

export async function toPptx(items, dpi, progress) {
  const slides = [];
  await renderEach(items, dpi, progress, async (canvas, scale) => {
    slides.push({ png: await pngOf(canvas, scale), w: canvas.width / scale * 72, h: canvas.height / scale * 72 });
  });
  progress('Saving…');
  // slide size from the first page, within PowerPoint's 1 - 56 in
  const EMU = 12700;
  const clampE = (v) => Math.min(51206400, Math.max(914400, Math.round(v)));
  const sx = clampE(slides[0].w * EMU), sy = clampE(slides[0].h * EMU);
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (list) => HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('') + '</Relationships>';
  const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const files = {};
  const media = {};
  let types = '';
  slides.forEach((s, i) => {
    const n = i + 1;
    const k = Math.min(sx / (s.w * EMU), sy / (s.h * EMU));
    const cx = Math.round(s.w * EMU * k), cy = Math.round(s.h * EMU * k);
    const x = Math.round((sx - cx) / 2), y = Math.round((sy - cy) / 2);
    media[`ppt/media/page${n}.png`] = s.png;
    files[`ppt/slides/slide${n}.xml`] = HEAD + `<p:sld ${NS}><p:cSld><p:spTree>${group}` +
      `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      '<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', `../media/page${n}.png`]]);
    types += `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  });
  files['[Content_Types].xml'] = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + types + '</Types>';
  files['_rels/.rels'] = rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]);
  files['ppt/presentation.xml'] = HEAD + `<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>' +
    slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 3}"/>`).join('') + '</p:sldIdLst>' +
    `<p:sldSz cx="${sx}" cy="${sy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] = rels([
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'theme', 'theme/theme1.xml'],
    ...slides.map((_, i) => [`rId${i + 3}`, 'slide', `slides/slide${i + 1}.xml`]),
  ]);
  files['ppt/slideMasters/slideMaster1.xml'] = HEAD + `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>';
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]);
  files['ppt/slideLayouts/slideLayout1.xml'] = HEAD + `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  files['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] = rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]);
  files['ppt/theme/theme1.xml'] = HEAD + theme();
  const zipped = {};
  for (const k of ['[Content_Types].xml', ...Object.keys(files).filter((k) => k !== '[Content_Types].xml')]) zipped[k] = enc.encode(files[k]);
  for (const [k, v] of Object.entries(media)) zipped[k] = [v, { level: 0 }];
  return { bytes: zipSync(zipped, { level: 6 }), pages: slides.length };
}

/** The plain Office theme, which every presentation needs. */
function theme() {
  const clr = (name, v) => `<a:${name}><a:srgbClr val="${v}"/></a:${name}>`;
  const three = (x) => x + x + x;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements>' +
    '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    clr('dk2', '44546A') + clr('lt2', 'E7E6E6') + clr('accent1', '4472C4') + clr('accent2', 'ED7D31') + clr('accent3', 'A5A5A5') +
    clr('accent4', 'FFC000') + clr('accent5', '5B9BD5') + clr('accent6', '70AD47') + clr('hlink', '0563C1') + clr('folHlink', '954F72') + '</a:clrScheme>' +
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Office"><a:fillStyleLst>' + three(solid) + '</a:fillStyleLst>' +
    '<a:lnStyleLst>' + three(`<a:ln w="6350">${solid}</a:ln>`) + '</a:lnStyleLst>' +
    '<a:effectStyleLst>' + three('<a:effectStyle><a:effectLst/></a:effectStyle>') + '</a:effectStyleLst>' +
    '<a:bgFillStyleLst>' + three(solid) + '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
}
