// Excel: rebuilds the rows and columns of each page from where its text sits, one sheet per file.
// The workbook is written by hand (inline strings, a percent and a currency style), the same
// structure the original C# app wrote.

import { zipSync } from '../../vendor/fflate.js';
import * as layout from './layout.js';
import { forEachPage, fileStem } from './pages.js';

/** A row: cell texts, null for empty cells. */

export async function toExcel(items, progress) {
  const { sheets, pages } = await readSheets(items, progress);
  progress('Saving…');
  return { bytes: writeXlsx(sheets), pages };
}

/** The table on the included pages: a [name, rows] sheet per file. Throws when there's no text. */
export async function readSheets(items, progress) {
  const sheets = []; // [name, rows]
  let pages = 0, cells = 0;
  let last = null;
  await forEachPage(items, progress, (item, _index, page) => {
    if (last !== item) {
      last = item;
      sheets.push([fileStem(items[item].name), []]);
    } else if (sheets.at(-1)[1].length) {
      sheets.at(-1)[1].push([]); // blank row between pages
    }
    const rows = sheets.at(-1)[1];
    const pageRows = tableRows(page);
    for (const r of pageRows) cells += r.filter((c) => c != null && c !== '').length;
    rows.push(...pageRows);
    pages += 1;
  });
  if (cells === 0) {
    throw new Error(
      'No text was found on the selected pages. They look like scans or pictures, ' +
      'and a spreadsheet can only be made from pages with real text (made by a program such as Word, Excel or SOLIDWORKS).',
    );
  }
  return { sheets, pages };
}

/** Rebuilds the rows and columns of one page from where its text sits. */
export function tableRows(page) {
  const rules = [];
  for (const p of page.paths) {
    for (const s of p.subpaths) {
      let minX = Number.MAX_VALUE, maxX = -Number.MAX_VALUE, minY = Number.MAX_VALUE, maxY = -Number.MAX_VALUE;
      for (const g of s.segs) {
        minX = Math.min(minX, Math.min(g.x0, g.x3));
        maxX = Math.max(maxX, Math.max(g.x0, g.x3));
        minY = Math.min(minY, Math.min(g.y0, g.y3));
        maxY = Math.max(maxY, Math.max(g.y0, g.y3));
      }
      if (maxX - minX < 2 && maxY - minY > 4) {
        rules.push({ x: (minX + maxX) / 2, y0: minY, y1: maxY });
      } else if (!p.filled && s.segs.length >= 4 && maxY - minY > 4) {
        // the sides of stroked boxes
        for (const g of s.segs) {
          if (Math.abs(g.x0 - g.x3) < 0.5 && Math.abs(g.y0 - g.y3) > 4) {
            rules.push({ x: g.x0, y0: Math.min(g.y0, g.y3), y1: Math.max(g.y0, g.y3) });
          }
        }
      }
    }
  }

  const lines = layout.lines(page.glyphs, 0.55, rules).filter((l) => l.angle === 0);
  lines.sort((a, b) => (b.perp < a.perp ? -1 : b.perp > a.perp ? 1 : 0));
  const rows = [];
  if (!lines.length) return rows;

  // Column spans: x ranges covered by the cells of lines that have more than one cell.
  // A few cells that straddle two columns (headings) are outvoted.
  const multi = lines.filter((l) => l.chunks.length > 1);
  const bins = Math.max(1, toInt(Math.ceil(page.width)) + 2);
  const cover = new Int32Array(bins);
  for (const l of multi) {
    for (const c of l.chunks) {
      const from = Math.max(0, toInt(c.x0));
      const to = Math.min(bins - 1, toInt(Math.ceil(c.x1)));
      for (let x = from; x <= to; x++) cover[x] += 1;
    }
  }
  const spans = columnSpans(cover, toInt(0.06 * multi.length));

  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const typical = sizes[Math.floor(lines.length / 2)] * 1.25;
  let prevPerp = lines[0].perp;
  for (const l of lines) {
    if (prevPerp - l.perp > 2.2 * typical && rows.length) rows.push([]);
    prevPerp = l.perp;
    const row = new Array(spans.length).fill(null);
    for (const c of l.chunks) {
      const col = spanAt(spans, c.x0);
      row[col] = row[col] === null ? c.text : `${row[col]} ${c.text}`;
    }
    rows.push(row);
  }
  // drop columns that ended up empty on this page
  const used = [];
  for (let i = 0; i < spans.length; i++) {
    if (rows.some((r) => r[i] != null && r[i] !== '')) used.push(i);
  }
  return rows.map((r) => used.map((i) => r[i] ?? null));
}

/** Rust's `as i64` on a float: truncated, NaN as 0. */
function toInt(v) {
  return Number.isNaN(v) ? 0 : Math.trunc(v);
}

/** Runs of bins covered by more than `threshold` cells, as [start, end) ranges. */
export function columnSpans(cover, threshold) {
  const bins = cover.length;
  const spans = [];
  for (let x = 0; x < bins; x++) {
    if (cover[x] > threshold) {
      const st = x;
      while (x + 1 < bins && cover[x + 1] > threshold) x++;
      spans.push([st, x + 1]);
    }
  }
  if (!spans.length) spans.push([0, bins]);
  return spans;
}

export function spanAt(spans, x) {
  let best = 0, bestDist = Number.MAX_VALUE;
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (x >= s[0] - 1 && x < s[1]) return i;
    const d = Math.min(Math.abs(x - s[0]), Math.abs(x - s[1]));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** How a number cell is shown. */
export const NumStyle = Object.freeze({ Plain: 'plain', Percent: 'percent', Money: 'money' });

// ^\(?[-−]?\$?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\)?%?$
const NUMBER_SHAPE = /^\(?[-−]?\$?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?\)?%?$/u;

/**
 * A cell that reads as a number is stored as one, so it can be added up in Excel.
 * Part numbers with leading zeros stay text. Returns [value, style] or null.
 */
export function asNumber(s) {
  if (!s || s.length > 18 || !NUMBER_SHAPE.test(s) || !/[0-9]/.test(s)) return null;
  const neg = s.startsWith('(') && s.endsWith(')');
  if (s.startsWith('(') !== s.endsWith(')')) return null;
  let t = s.replace(/^[()]+|[()]+$/g, '');
  const pct = t.endsWith('%'), money = t.includes('$');
  t = t.replace(/[%$,]/g, '').replaceAll('−', '-');
  const digits = t.replace(/^-+/, '');
  if (digits.length > 1 && digits[0] === '0' && digits[1] !== '.') return null;
  if (digits.replaceAll('.', '').length > 15) return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  let value = Number(t);
  if (neg) value = -value;
  if (pct) return [value / 100, NumStyle.Percent];
  if (money) return [value, NumStyle.Money];
  return [value, NumStyle.Plain];
}

/** Sheet names: no []:*?/\, at most 28 characters (room for " 2"), unique ignoring case. */
export function sheetNames(raw) {
  const names = [];
  for (const s of raw) {
    const cleaned = [...s].map((c) => ('[]:*?/\\'.includes(c) ? ' ' : c)).join('');
    // Excel also refuses a name that starts or ends with an apostrophe
    let n = layout.rustTrim(layout.rustTrim(cleaned).replace(/^'+|'+$/g, ''));
    if (!n) n = 'Sheet';
    if ([...n].length > 28) n = layout.rustTrim([...n].slice(0, 28).join(''));
    let unique = n;
    for (let k = 2; names.some((x) => x.toLowerCase() === unique.toLowerCase()); k++) unique = `${n} ${k}`;
    names.push(unique);
  }
  return names;
}

/** Characters below space (other than tab) aren't allowed in the file; at most 32767 of them. */
export function clean(s) {
  return [...s].filter((c) => c >= ' ' || c === '\t').slice(0, 32767).join('');
}

export function xml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** A1-style column letters. */
export function columnName(c) {
  let s = '';
  for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

/** Up to two decimals, like .NET's "0.##". */
function width2(v) {
  return String(Math.round(v * 100) / 100);
}

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function sheetXml(rows) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const widths = new Array(cols).fill(0);
  for (const r of rows) {
    r.forEach((v, c) => {
      if (v != null) widths[c] = Math.max(widths[c], Math.min(60, v.length * 1.1 + 2));
    });
  }
  const sb = [HEAD, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  if (cols > 0) {
    sb.push('<cols>');
    for (let c = 0; c < cols; c++) {
      sb.push(`<col min="${c + 1}" max="${c + 1}" width="${width2(Math.max(8, widths[c]))}" customWidth="1"/>`);
    }
    sb.push('</cols>');
  }
  sb.push('<sheetData>');
  rows.forEach((row, r) => {
    sb.push(`<row r="${r + 1}">`);
    row.forEach((v, c) => {
      if (v == null || v === '') return;
      const cell = columnName(c) + (r + 1);
      const num = asNumber(v);
      if (num) {
        const style = num[1] === NumStyle.Percent ? ' s="1"' : num[1] === NumStyle.Money ? ' s="2"' : '';
        sb.push(`<c r="${cell}"${style}><v>${String(num[0])}</v></c>`);
      } else {
        sb.push(`<c r="${cell}" t="inlineStr"><is><t xml:space="preserve">${xml(clean(v))}</t></is></c>`);
      }
    });
    sb.push('</row>');
  });
  sb.push('</sheetData></worksheet>');
  return sb.join('');
}

/** The .xlsx file for [name, rows] sheets. */
export function writeXlsx(sheets) {
  const enc = new TextEncoder();
  const names = sheetNames(sheets.map((s) => s[0]))
    // a name Excel reserves for itself
    .map((n, i) => (n.toLowerCase() === 'history' ? `Sheet${i + 1}` : n));
  const files = {};
  let sheetEntries = '', rels = '', types = '';
  sheets.forEach(([, rows], i) => {
    sheetEntries += `<sheet name="${xml(clean(names[i]))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
    rels += `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`;
    types += `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(rows);
  });
  rels += `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;

  files['[Content_Types].xml'] = HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + types + '</Types>';
  files['_rels/.rels'] = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  files['xl/workbook.xml'] = HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheetEntries + '</sheets></workbook>';
  files['xl/_rels/workbook.xml.rels'] = HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>';
  files['xl/styles.xml'] = HEAD + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  // [Content_Types].xml first, as Excel likes it
  const order = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml'];
  const zipped = {};
  for (const k of [...order, ...Object.keys(files).filter((k) => !order.includes(k))]) zipped[k] = enc.encode(files[k]);
  return zipSync(zipped, { level: 6 });
}
