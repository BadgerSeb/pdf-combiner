// File model: reads an ASCII DXF into group-code pairs and sorts them into header units, layers,
// blocks and entities.

import { decodeCp1252 } from './font.js';

// Whitespace as Rust's str::trim sees it (Unicode White_Space), so values are read the same way.
const WS = '[\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000]';
const TRIM = new RegExp(`^${WS}+|${WS}+$`, 'g');

/** Trims surrounding whitespace (Rust's definition: unlike String.trim, a BOM is kept). */
export const trim = (s) => s.replace(TRIM, '');

const FLOAT = /^[+-]?(?:inf|infinity|nan|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i;
const INT = /^[+-]?\d+$/;

/** Parses a DXF real the way the C# version did (invariant culture, surrounding blanks allowed). */
export function parseF64(s) {
  const t = trim(s);
  if (!FLOAT.test(t)) return undefined;
  const body = t.replace(/^[+-]/, '').toLowerCase();
  const sign = t.startsWith('-') ? -1 : 1;
  if (body === 'nan') return NaN;
  if (body === 'inf' || body === 'infinity') return sign * Infinity;
  return Number(t);
}

/** Parses a DXF integer (a 32-bit one, surrounding blanks allowed). */
export function parseI32(s) {
  const t = trim(s);
  if (!INT.test(t)) return undefined;
  const v = Number(t);
  return v >= -2147483648 && v <= 2147483647 ? v : undefined;
}

/** A number to a 32-bit integer the way Rust's `as i32` does (truncate, saturate, NaN -> 0). */
export function toI32(v) {
  if (Number.isNaN(v)) return 0;
  return Math.max(-2147483648, Math.min(2147483647, Math.trunc(v)));
}

export class Entity {
  constructor(kind) {
    this.kind = kind;
    this.codes = []; // [code, value] pairs, values untrimmed
    this.children = []; // VERTEX / ATTRIB
  }

  /** Value of the first `code`, untrimmed. */
  str(code, fallback) {
    const p = this.codes.find(([c]) => c === code);
    return p ? p[1] : fallback;
  }

  /** Value of the first `code` as a number; `fallback` if it is missing or unreadable. */
  dbl(code, fallback) {
    const p = this.codes.find(([c]) => c === code);
    if (!p) return fallback;
    const v = parseF64(p[1]);
    return v === undefined ? fallback : v;
  }

  int(code, fallback) {
    const v = this.dbl(code, NaN);
    return Number.isNaN(v) ? fallback : toI32(v);
  }

  /** Every readable value of `code`, in file order. */
  all(code) {
    const out = [];
    for (const [c, v] of this.codes) {
      if (c !== code) continue;
      const n = parseF64(v);
      if (n !== undefined) out.push(n);
    }
    return out;
  }
}

/** A parsed drawing. Layer and block names are looked up case-insensitively. */
export class Drawing {
  constructor() {
    this.layers = new Map(); // upper-case name -> { color, visible, trueColor }
    this.blocks = new Map(); // upper-case name -> { name, baseX, baseY, entities }
    this.entities = [];
    this.units = 0; // $INSUNITS
  }

  layer(name) {
    return this.layers.get(name.toUpperCase());
  }

  block(name) {
    return this.blocks.get(name.toUpperCase());
  }

  unitName() {
    return { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' }[this.units] ?? '';
  }

  static fromBytes(bytes) {
    if (bytes.length > 18 && isBinaryDxf(bytes)) {
      throw new Error(
        "This is a binary DXF, which isn't supported. Save it as an ASCII DXF and try again.",
      );
    }
    let text = decodeText(bytes);
    if (text.startsWith('﻿')) text = text.slice(1);

    const lines = text.split('\n');
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseI32(lines[i]);
      if (code === undefined) throw new Error("This file doesn't look like a valid DXF.");
      pairs.push([code, lines[i + 1].replace(/\r+$/, '')]);
    }
    const d = new Drawing();
    d.parse(pairs);
    return d;
  }

  parse(p) {
    let i = 0;
    while (i < p.length) {
      if (p[i][0] === 0 && trim(p[i][1]) === 'SECTION' && i + 1 < p.length) {
        const section = trim(p[i + 1][1]);
        i += 2;
        let end = i;
        while (end < p.length && !(p[end][0] === 0 && trim(p[end][1]) === 'ENDSEC')) end++;
        const part = p.slice(i, end);
        if (section === 'HEADER') this.parseHeader(part);
        else if (section === 'TABLES') this.parseTables(part);
        else if (section === 'BLOCKS') this.parseBlocks(part);
        else if (section === 'ENTITIES') this.entities.push(...parseEntities(part));
        i = end + 1;
      } else {
        i++;
      }
    }
  }

  parseHeader(p) {
    for (let i = 0; i + 1 < p.length; i++) {
      if (p[i][0] === 9 && trim(p[i][1]) === '$INSUNITS') {
        const u = parseI32(p[i + 1][1]);
        if (u !== undefined) this.units = u;
      }
    }
  }

  parseTables(p) {
    let i = 0;
    while (i < p.length) {
      if (p[i][0] !== 0 || trim(p[i][1]) !== 'LAYER') {
        i++;
        continue;
      }
      let name;
      let [color, flags, trueColor] = [7, 0, -1];
      let j = i + 1;
      for (; j < p.length && p[j][0] !== 0; j++) {
        const v = trim(p[j][1]);
        // unreadable numbers count as 0, like int.TryParse did
        switch (p[j][0]) {
          case 2: name = v; break;
          case 62: color = parseI32(v) ?? 0; break;
          case 70: flags = parseI32(v) ?? 0; break;
          case 420: trueColor = parseI32(v) ?? 0; break;
        }
      }
      if (name !== undefined) {
        this.layers.set(name.toUpperCase(), {
          color: Math.abs(color),
          visible: color >= 0 && (flags & 1) === 0,
          trueColor,
        });
      }
      i = j;
    }
  }

  parseBlocks(p) {
    let i = 0;
    while (i < p.length) {
      if (!(p[i][0] === 0 && trim(p[i][1]) === 'BLOCK')) {
        i++;
        continue;
      }
      const block = { name: '', baseX: 0, baseY: 0, entities: [] };
      let name;
      let j = i + 1;
      for (; j < p.length && p[j][0] !== 0; j++) {
        const v = trim(p[j][1]);
        switch (p[j][0]) {
          case 2: name = v; break;
          case 10: block.baseX = parseF64(v) ?? 0; break;
          case 20: block.baseY = parseF64(v) ?? 0; break;
        }
      }
      let end = j;
      while (end < p.length && !(p[end][0] === 0 && trim(p[end][1]) === 'ENDBLK')) end++;
      block.entities = parseEntities(p.slice(j, end));
      if (name !== undefined) {
        block.name = name;
        this.blocks.set(name.toUpperCase(), block);
      }
      i = end + 1;
    }
  }
}

function isBinaryDxf(bytes) {
  const sig = 'AutoCAD Binary DXF';
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig.charCodeAt(i)) return false;
  return true;
}

/** UTF-8, or Windows-1252 when the bytes aren't valid UTF-8. A BOM is kept for the caller. */
function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

/**
 * Splits a run of pairs into entities; VERTEX and ATTRIB records become children of the
 * POLYLINE / INSERT before them, up to the SEQEND.
 */
export function parseEntities(p) {
  const list = [];
  let owner = null; // the POLYLINE / INSERT collecting children
  let i = 0;
  while (i < p.length) {
    if (p[i][0] !== 0) {
      i++;
      continue;
    }
    const e = new Entity(trim(p[i][1]));
    for (i++; i < p.length && p[i][0] !== 0; i++) e.codes.push(p[i]);

    if (e.kind === 'SEQEND') {
      owner = null;
      continue;
    }
    if ((e.kind === 'VERTEX' || e.kind === 'ATTRIB') && owner) {
      owner.children.push(e);
      continue;
    }
    const owns = e.kind === 'POLYLINE' || (e.kind === 'INSERT' && e.int(66, 0) === 1);
    list.push(e);
    owner = owns ? e : null;
  }
  return list;
}
