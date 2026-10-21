// CSV and OpenDocument spreadsheets, from the same rows and columns as the Excel export.

import { zipSync } from '../../vendor/fflate.js';
import { readSheets, asNumber, sheetNames, clean, xml, NumStyle } from './excel.js';

/** Every file's table one after the other, a blank row between them. UTF-8 with a BOM for Excel. */
export async function toCsv(items, progress) {
  const { sheets, pages } = await readSheets(items, progress);
  progress('Saving…');
  const out = [];
  sheets.forEach(([, rows], i) => {
    if (i > 0) out.push('');
    for (const r of rows) out.push(r.map((v) => csvField(v == null ? '' : clean(v))).join(','));
  });
  return { bytes: new TextEncoder().encode('﻿' + out.join('\r\n') + '\r\n'), pages };
}

function csvField(s) {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** An OpenDocument spreadsheet (.ods), a sheet per file, numbers stored as numbers. */
export async function toOds(items, progress) {
  const { sheets, pages } = await readSheets(items, progress);
  progress('Saving…');
  const names = sheetNames(sheets.map((s) => s[0]));
  const body = sheets.map(([, rows], i) => {
    const cols = Math.max(1, rows.reduce((m, r) => Math.max(m, r.length), 0));
    const sb = [`<table:table table:name="${xml(clean(names[i]))}"><table:table-column table:number-columns-repeated="${cols}"/>`];
    for (const row of rows) {
      sb.push('<table:table-row>');
      if (!row.length) sb.push('<table:table-cell/>');
      for (const v of row) {
        if (v == null || v === '') { sb.push('<table:table-cell/>'); continue; }
        const text = `<text:p>${xml(clean(v))}</text:p>`;
        const num = asNumber(v);
        if (!num) sb.push(`<table:table-cell office:value-type="string">${text}</table:table-cell>`);
        else if (num[1] === NumStyle.Percent) sb.push(`<table:table-cell office:value-type="percentage" office:value="${num[0]}">${text}</table:table-cell>`);
        else if (num[1] === NumStyle.Money) sb.push(`<table:table-cell office:value-type="currency" office:currency="USD" office:value="${num[0]}">${text}</table:table-cell>`);
        else sb.push(`<table:table-cell office:value-type="float" office:value="${num[0]}">${text}</table:table-cell>`);
      }
      sb.push('</table:table-row>');
    }
    sb.push('</table:table>');
    return sb.join('');
  }).join('');
  const content = '<?xml version="1.0" encoding="UTF-8"?><office:document-content ' +
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet>' +
    body + '</office:spreadsheet></office:body></office:document-content>';
  return { bytes: odfPackage('application/vnd.oasis.opendocument.spreadsheet', content, {}), pages };
}

/** An OpenDocument zip: the mimetype first and stored, then the manifest, content and pictures. */
export function odfPackage(mime, content, pictures) {
  const enc = new TextEncoder();
  const entries = Object.keys(pictures).map((p) => `<manifest:file-entry manifest:full-path="${p}" manifest:media-type="image/png"/>`).join('');
  const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${mime}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' + entries + '</manifest:manifest>';
  const files = {
    mimetype: [enc.encode(mime), { level: 0 }],
    'META-INF/manifest.xml': enc.encode(manifest),
    'content.xml': enc.encode(content),
  };
  for (const [p, bytes] of Object.entries(pictures)) files[p] = [bytes, { level: 0 }];
  return zipSync(files, { level: 6 });
}
