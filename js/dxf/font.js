// Windows-1252 (WinAnsi) text handling and Helvetica glyph widths, so text can be written with
// the standard PDF fonts and measured for alignment without embedding anything.

/** Unicode for bytes 0x80..=0x9F in Windows-1252 (0 = unassigned). */
const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0, 0x017e, 0x0178,
];

/**
 * Decodes Windows-1252 bytes (used when a DXF isn't valid UTF-8, like Encoding.Default did).
 * The WHATWG decoder maps the five unassigned bytes to U+0081 etc., as the Rust version does.
 */
export function decodeCp1252(bytes) {
  return new TextDecoder('windows-1252').decode(bytes);
}

/** Encodes text as WinAnsi bytes; characters outside it become '?', control characters spaces. */
export function encodeWinAnsi(s) {
  const out = [];
  for (const ch of s) {
    const u = ch.codePointAt(0);
    if (u <= 0x1f || u === 0x7f) out.push(0x20);
    else if ((u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff)) out.push(u);
    else {
      const i = CP1252_HIGH.findIndex((h) => h !== 0 && h === u);
      out.push(i < 0 ? 0x3f : 0x80 + i);
    }
  }
  return Uint8Array.from(out);
}

/** Helvetica widths (1/1000 em) for WinAnsi 0x20..=0x7E. */
const HELVETICA_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space .. /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 .. ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ .. O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P .. _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` .. o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p .. ~
];

/** Helvetica-Bold widths (1/1000 em) for WinAnsi 0x20..=0x7E. */
const HELVETICA_BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, // space .. /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, // 0 .. ?
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, // @ .. O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, // P .. _
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, // ` .. o
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, // p .. ~
];

/** Helvetica widths for WinAnsi 0x80..=0xFF (bold uses these too; it only differs slightly there). */
const HELVETICA_HIGH = [
  556, 556, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 556, 611, 556, // 0x80
  556, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 556, 500, 667, // 0x90
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, // 0xA0
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, // 0xB0
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, // 0xC0
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, // 0xD0
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, // 0xE0
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500, // 0xF0
];

/** Width in points of WinAnsi `bytes` set in Helvetica (or Helvetica-Bold) at `size`. */
export function textWidth(bytes, size, bold = false) {
  const ascii = bold ? HELVETICA_BOLD_ASCII : HELVETICA_ASCII;
  let units = 0;
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) units += ascii[b - 0x20];
    else if (b >= 0x80) units += HELVETICA_HIGH[b - 0x80];
    else units += 278;
  }
  return (units * size) / 1000;
}
