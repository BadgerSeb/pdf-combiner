// Puts characters back together into lines and runs of text.
//
//   TextChunk { text, x0, x1 (along the baseline), perp (across it; y for horizontal text),
//               size, angle, pageX, pageY (start point on the page), color }
//   TextLine  { perp, size, angle (whole degrees), chunks: TextChunk[] }
//   VRule     { x, y0, y1 }  a vertical ruling line, for splitting table cells

/** Like Rust's partial_cmp(..).unwrap_or(Equal). */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rust's f64::round (halves away from zero) then `as i32` (NaN as 0). */
export function roundI32(v) {
  if (Number.isNaN(v)) return 0;
  const r = Math.sign(v) * Math.round(Math.abs(v));
  return Math.max(-2147483648, Math.min(2147483647, r)) | 0;
}

// Unicode White_Space, which Rust's str::trim removes (JS's trim differs slightly).
const WS = '\t\n\v\f\r \u0085                 　';
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');

/** Rust's str::trim. */
export function rustTrim(s) {
  return s.replace(TRIM, '');
}

/**
 * Groups characters into lines (top to bottom) and each line into chunks. A gap wider than
 * `splitGap` ems, or a vertical ruling line, starts a new chunk; smaller gaps become spaces.
 */
export function lines(glyphs, splitGap, rules) {
  // group by baseline angle, keeping the order in which angles first appear
  const groups = [];
  for (const g of glyphs) {
    const key = norm(roundI32(g.angle));
    const found = groups.find((x) => x[0] === key);
    if (found) found[1].push(g);
    else groups.push([key, [g]]);
  }

  const result = [];
  for (const [key, members] of groups) {
    const a = key * (Math.PI / 180);
    const cos = Math.cos(a), sin = Math.sin(a);
    const items = members.map((g) => ({ g, along: g.x * cos + g.y * sin, perp: -g.x * sin + g.y * cos }));
    items.sort((p, q) => cmp(q.perp, p.perp) || cmp(p.along, q.along));

    const lineGroups = [];
    let linePerp = 0, lineSize = 0;
    for (const t of items) {
      if (!lineGroups.length || linePerp - t.perp > 0.35 * Math.max(t.g.size, lineSize)) {
        lineGroups.push([]);
        linePerp = t.perp;
        lineSize = t.g.size;
      }
      lineGroups.at(-1).push(t);
      lineSize = Math.max(lineSize, t.g.size);
    }

    for (const group of lineGroups) {
      const ms = group.slice().sort((p, q) => cmp(p.along, q.along));
      const line = {
        angle: key,
        perp: ms.reduce((m, x) => Math.max(m, x.perp), -Number.MAX_VALUE),
        size: ms.reduce((m, x) => Math.max(m, x.g.size), -Number.MAX_VALUE),
        chunks: [],
      };
      let chunk = null;
      let sb = '';
      let end = 0, lastAlong = -Number.MAX_VALUE;
      let lastText = null;
      for (const m of ms) {
        const g = m.g;
        // the same character drawn twice (fake bold) is kept once
        if (lastText === g.text && Math.abs(m.along - lastAlong) < 0.15 * g.size) continue;
        lastText = g.text;
        lastAlong = m.along;
        const space = rustTrim(g.text) === '';
        const gap = chunk === null ? 0 : m.along - end;
        const split = chunk !== null && (gap > splitGap * g.size || (key === 0 && !!rules &&
          rules.some((r) => r.x > end - 0.5 && r.x < m.along + 0.5 &&
            r.y0 <= m.perp + 0.3 * g.size && r.y1 >= m.perp + 0.3 * g.size)));
        if (split) {
          finish(chunk, sb, end, line);
          chunk = null;
        }
        if (chunk === null) {
          if (space) continue;
          chunk = {
            text: '', x0: m.along, x1: 0, perp: m.perp, size: g.size, angle: g.angle,
            pageX: g.x, pageY: g.y, color: g.color,
          };
          sb = '';
          end = m.along;
        } else if (gap > 0.15 * g.size && sb !== '' && !sb.endsWith(' ')) {
          sb += ' ';
        }
        if (space) {
          if (sb !== '' && !sb.endsWith(' ')) sb += ' ';
        } else {
          sb += g.text;
        }
        chunk.size = Math.max(chunk.size, g.size);
        end = Math.max(end, m.along + g.advance);
      }
      if (chunk !== null) finish(chunk, sb, end, line);
      if (line.chunks.length) result.push(line);
    }
  }
  return result;
}

function finish(c, sb, end, line) {
  c.text = rustTrim(sb);
  c.x1 = end;
  if (c.text !== '') line.chunks.push(c);
}

function norm(deg) {
  deg %= 360;
  if (deg <= -180) deg += 360;
  if (deg > 180) deg -= 360;
  return deg;
}
