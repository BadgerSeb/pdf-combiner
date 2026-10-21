// Unit-style checks for js/dxf, mirroring the Rust crate's tests (crates/dxf/src/tests.rs).

import { Drawing, Entity, parseEntities } from '../js/dxf/model.js';
import { Scene, Xf, pt, lwVertices, polylinePoints, stripMtext, decode } from '../js/dxf/scene.js';
import { dxfToPdf, dxfContent, formatDecimals } from '../js/dxf/index.js';
import { PDFDocument, PDFName } from '../vendor/pdf-lib.esm.min.js';
import { unzlibSync } from '../vendor/fflate.js';

/** Builds DXF text from [code, value] pairs. */
const dxf = (pairs) => pairs.map(([c, v]) => `${String(c).padStart(3)}\r\n${v}\r\n`).join('');
const utf8 = (s) => new TextEncoder().encode(s);
const close = (a, x, y) => Math.abs(a.x - x) < 1e-9 && Math.abs(a.y - y) < 1e-9;

function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new Error(msg);
}
const eq = (a, b) => assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
function throwsWith(fn, check) {
  try {
    fn();
  } catch (e) {
    return check(e.message);
  }
  throw new Error('did not throw');
}

const tests = {
  group_codes_and_lookups() {
    const d = Drawing.fromBytes(utf8(dxf([
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, 'Cut'], [10, ' 1.5'], [20, '-2e1'],
      [10, '9'], [11, 'oops'], [0, 'ENDSEC'], [0, 'EOF'],
    ])));
    eq(d.entities.length, 1);
    const e = d.entities[0];
    eq(e.kind, 'LINE');
    eq(e.str(8, '0'), 'Cut');
    eq(e.dbl(10, 0), 1.5); // first occurrence wins
    eq(e.dbl(20, 0), -20);
    eq(e.dbl(11, 7), 7); // unreadable -> fallback
    eq(e.dbl(21, 3), 3); // missing -> fallback
    eq(e.all(10), [1.5, 9]);
    eq(e.int(10, 0), 1);
  },

  rejects_bad_files() {
    throwsWith(() => Drawing.fromBytes(utf8('hello\nworld\n')),
      (m) => eq(m, "This file doesn't look like a valid DXF."));
    const bin = Uint8Array.from([...utf8('AutoCAD Binary DXF\r\n'), 0x1a, 0, ...utf8('junk')]);
    throwsWith(() => Drawing.fromBytes(bin), (m) => assert(m.startsWith('This is a binary DXF'), m));
  },

  bom_and_cp1252() {
    const withBom = utf8('\uFEFF' + dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [1, 'x'], [0, 'ENDSEC']]));
    eq(Drawing.fromBytes(withBom).entities.length, 1);
    // not UTF-8: read as Windows-1252
    let head = utf8(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [1, '']]));
    head = head.slice(0, head.length - 2);
    const bytes = Uint8Array.from([...head, 0xd8, ...utf8(' 2\r\n  0\r\nENDSEC\r\n')]);
    eq(Drawing.fromBytes(bytes).entities[0].str(1, ''), 'Ø 2');
  },

  units_header() {
    const d = Drawing.fromBytes(utf8(dxf([
      [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [9, '$INSUNITS'],
      [70, '     4'], [0, 'ENDSEC'],
    ])));
    eq(d.units, 4);
    eq(d.unitName(), 'mm');
    eq(new Drawing().unitName(), '');
  },

  layers_are_case_insensitive_and_can_be_hidden() {
    const line = (layer) => [[0, 'LINE'], [8, layer], [10, '0'], [20, '0'], [11, '1'], [21, '1']];
    const d = Drawing.fromBytes(utf8(dxf([
      [0, 'SECTION'], [2, 'TABLES'], [0, 'TABLE'], [2, 'LAYER'],
      [0, 'LAYER'], [2, 'Hidden'], [70, '0'], [62, '-3'],
      [0, 'LAYER'], [2, 'Frozen'], [70, '1'], [62, '5'],
      [0, 'LAYER'], [2, 'Red'], [70, '0'], [62, '1'],
      [0, 'ENDTAB'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'],
      ...line('hidden'), ...line('FROZEN'), ...line('red'), [0, 'ENDSEC'],
    ])));
    assert(!d.layer('HIDDEN').visible);
    eq(d.layer('hidden').color, 3);
    const s = new Scene(d);
    s.build();
    eq(s.strokes.length, 1);
    eq(s.strokes[0].color, [220, 0, 0]);
  },

  polyline_children_and_seqend() {
    const text = dxf([
      [0, 'POLYLINE'], [66, '1'], [70, '1'], [0, 'VERTEX'], [10, '0'], [20, '0'],
      [0, 'VERTEX'], [10, '1'], [20, '0'], [0, 'VERTEX'], [10, '1'], [20, '1'], [0, 'SEQEND'],
      [0, 'VERTEX'], [10, '5'], [20, '5'], // stray vertex: an entity of its own
    ]);
    const parts = text.split('\r\n');
    const pairs = [];
    for (let i = 0; i + 1 < parts.length; i += 2) pairs.push([Number(parts[i].trim()), parts[i + 1]]);
    const list = parseEntities(pairs);
    eq(list.length, 2);
    eq(list[0].children.length, 3);
    eq(list[1].kind, 'VERTEX');
  },

  bulge_semicircle() {
    // bulge 1 = half circle, counter-clockwise from (0,0) to (2,0): passes below through (1,-1)
    let pts = polylinePoints([[pt(0, 0), 1], [pt(2, 0), 0]], false);
    assert(close(pts[0], 0, 0));
    assert(close(pts.at(-1), 2, 0));
    const mid = pts[Math.floor(pts.length / 2)];
    assert(close(mid, 1, -1), JSON.stringify(mid));
    for (const p of pts) assert(Math.abs(Math.hypot(p.x - 1, p.y) - 1) < 1e-9);
    // negative bulge goes the other way
    pts = polylinePoints([[pt(0, 0), -1], [pt(2, 0), 0]], false);
    assert(close(pts[Math.floor(pts.length / 2)], 1, 1));
  },

  lw_polyline_bulges_attach_to_previous_vertex() {
    const e = new Entity('LWPOLYLINE');
    for (const [c, v] of [[90, '3'], [70, '1'], [10, '0'], [20, '0'], [42, '0.5'], [10, '4'], [20, '0'], [10, '4'], [20, '3']]) {
      e.codes.push([c, v]);
    }
    const v = lwVertices(e);
    eq(v.length, 3);
    eq(v[0][1], 0.5);
    eq(v[1][1], 0);
    // a closed polyline returns to its start point
    assert(close(polylinePoints(v, true).at(-1), 0, 0));
  },

  insert_transform() {
    // block based at (1,1) with a unit line, inserted at (10,10), rotated 90°, scaled 2
    const d = Drawing.fromBytes(utf8(dxf([
      [0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [2, 'Part'], [70, '0'], [10, '1'], [20, '1'],
      [0, 'LINE'], [8, '0'], [10, '1'], [20, '1'], [11, '2'], [21, '1'], [0, 'ENDBLK'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'INSERT'], [2, 'PART'], [10, '10'], [20, '10'], [41, '2'], [42, '2'], [50, '90'],
      [0, 'INSERT'], [2, 'part'], [10, '0'], [20, '0'], [70, '2'], [71, '3'], [44, '5'], [45, '7'],
      [0, 'ENDSEC'],
    ])));
    const s = new Scene(d);
    s.build();
    eq(s.strokes.length, 1 + 6);
    const p = s.strokes[0].points;
    assert(close(p[0], 10, 10) && close(p[1], 10, 12), JSON.stringify(p));
    // array: column 1, row 2 is offset by (5, 14)
    const last = s.strokes[6].points;
    assert(close(last[0], 5, 14) && close(last[1], 6, 14), JSON.stringify(last));
  },

  xf_composition_and_mirroring() {
    const xf = Xf.translate(3, 4).then(Xf.scale(-1, 1));
    assert(close(xf.apply(1, 1), 2, 5));
    assert(xf.det() < 0);
    assert(Math.abs(Xf.rotate(30).angle() - 30) < 1e-9);
  },

  mtext_codes() {
    eq(stripMtext('{\\fArial|b1;Hello}\\PWorld \\S1/2; \\\\x \\{y\\}'), 'Hello\nWorld 1/2 \\x {y}');
    eq(decode('%%c10 %%d %%p0.1 \\U+00B5 100%%%'), 'Ø10 ° ±0.1 µ 100%');
  },

  number_format() {
    eq(formatDecimals(3.8333333, 3), '3.833');
    eq(formatDecimals(6, 3), '6');
    eq(formatDecimals(19.30549, 3), '19.305');
    eq(formatDecimals(250.04, 1), '250');
    eq(formatDecimals(-0.0001, 3), '0');
  },

  async empty_drawing_is_an_error() {
    const bytes = utf8(dxf([[0, 'SECTION'], [2, 'ENTITIES'], [0, 'ENDSEC'], [0, 'EOF']]));
    try {
      await dxfToPdf(bytes, 'empty.dxf');
    } catch (e) {
      return eq(e.message, "This DXF doesn't contain anything that can be drawn.");
    }
    throw new Error('did not throw');
  },

  async writes_a_readable_pdf() {
    const bytes = utf8(dxf([
      [0, 'SECTION'], [2, 'ENTITIES'], [0, 'CIRCLE'], [10, '0'], [20, '0'], [40, '2'],
      [0, 'TEXT'], [10, '0'], [20, '0'], [40, '0.5'], [1, 'Hi (there)'], [72, '1'], [11, '0'], [21, '-3'],
      [0, 'ENDSEC'],
    ]));
    const doc = await PDFDocument.load(await dxfToPdf(bytes, 'small.dxf'));
    eq(doc.getPageCount(), 1);
    const content = await pageContent(doc);
    assert(content.includes('(Hi \\(there\\)) Tj'));
    assert(content.includes('(small.dxf) Tj'));
    assert(content.includes('(Size 4 \\327 4   \\267   not to scale \\(fitted to page\\)) Tj'), content);
  },
};

/** The decompressed content stream of a document's first page (single stream). */
export async function pageContent(doc) {
  const page = doc.getPage(0);
  const stream = doc.context.lookup(page.node.get(PDFName.of('Contents')));
  const filter = stream.dict.get(PDFName.of('Filter'));
  const raw = stream.contents;
  const bytes = filter ? unzlibSync(raw) : raw;
  return new TextDecoder('latin1').decode(bytes);
}

/** Runs every check; returns lines "PASS name" / "FAIL name: message". */
export async function runUnitTests() {
  const lines = [];
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      lines.push(`PASS ${name}`);
    } catch (e) {
      lines.push(`FAIL ${name}: ${e.message}`);
    }
  }
  return lines;
}

export { dxfContent };
