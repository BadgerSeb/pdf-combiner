// AVIF: the page is encoded as a single AV1 key frame with the browser's video encoder
// (WebCodecs) and wrapped in the HEIF boxes an AVIF still picture needs.
//
// The pixels are turned into YUV 4:2:0 here (BT.601 matrix, full range, sRGB), so the colour
// box can say exactly what was done, as libavif does by default.

const QUANTIZER = 16; // 0 (best) - 63; about JPEG quality 92

export async function writeAvif(canvas) {
  if (typeof VideoEncoder !== 'function') throw new Error("This browser can't make AVIF pictures. Try Edge or Chrome.");
  // 4:2:0 wants an even size; the extra row or column is white
  const w = canvas.width + (canvas.width & 1), h = canvas.height + (canvas.height & 1);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(canvas, 0, 0);
  const rgba = g.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;

  const config = {
    codec: 'av01.0.31M.08', width: w, height: h, bitrateMode: 'quantizer',
    latencyMode: 'quality', hardwareAcceleration: 'prefer-software',
  };
  let support = await VideoEncoder.isConfigSupported(config).catch(() => null);
  let quantizer = true;
  if (!support?.supported) {
    delete config.bitrateMode;
    config.bitrate = Math.min(400e6, w * h * 3);
    quantizer = false;
    support = await VideoEncoder.isConfigSupported(config).catch(() => null);
  }
  if (!support?.supported) {
    throw new Error(`This page is too big for an AVIF picture at this resolution (${w} x ${h} pixels). Pick a lower resolution.`);
  }

  const chunks = [];
  let failed = null, decoderConfig = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push(b);
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
    },
    error: (e) => { failed = e; },
  });
  try {
    encoder.configure(config);
    const frame = new VideoFrame(toI420(rgba, w, h), {
      format: 'I420', codedWidth: w, codedHeight: h, timestamp: 0,
      colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'smpte170m', fullRange: true },
    });
    encoder.encode(frame, quantizer ? { keyFrame: true, av1: { quantizer: QUANTIZER } } : { keyFrame: true });
    frame.close();
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failed || !chunks.length) throw new Error(`Couldn't make the AVIF picture${failed ? ` (${failed.message})` : ''}.`);
  const data = concat(chunks);
  const description = decoderConfig?.description;
  const av1C = description && description.byteLength >= 4
    ? new Uint8Array(description instanceof ArrayBuffer ? description : description.buffer, description.byteOffset ?? 0, description.byteLength)
    : av1cFromStream(data);
  return container(data, av1C, [w, h]);
}

/** RGBA -> planar YUV 4:2:0, BT.601 full range. */
function toI420(rgba, w, h) {
  const ySize = w * h, cw = w >> 1, ch = h >> 1;
  const out = new Uint8Array(ySize + 2 * cw * ch);
  for (let i = 0, s = 0; i < ySize; i++, s += 4) {
    out[i] = clamp(0.299 * rgba[s] + 0.587 * rgba[s + 1] + 0.114 * rgba[s + 2]);
  }
  const uAt = ySize, vAt = ySize + cw * ch;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const s = ((2 * y + dy) * w + 2 * x + dx) * 4;
        r += rgba[s]; g += rgba[s + 1]; b += rgba[s + 2];
      }
      r /= 4; g /= 4; b /= 4;
      out[uAt + y * cw + x] = clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      out[vAt + y * cw + x] = clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  return out;
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** The AV1CodecConfigurationRecord, from the sequence header OBU in the stream. */
function av1cFromStream(data) {
  for (let p = 0; p < data.length; ) {
    const head = data[p];
    const type = (head >> 3) & 15, ext = (head >> 2) & 1, hasSize = (head >> 1) & 1;
    let q = p + 1 + ext;
    let size = data.length - q;
    if (hasSize) {
      size = 0;
      for (let i = 0; i < 8; i++) {
        const b = data[q++];
        size |= (b & 127) << (i * 7);
        if (!(b & 128)) break;
      }
    }
    if (type === 1) {
      const bits = new Bits(data.subarray(q, q + size));
      const profile = bits.read(3);
      bits.read(1); // still_picture
      const reduced = bits.read(1);
      let level = 0, tier = 0;
      if (reduced) {
        level = bits.read(5);
      } else {
        const timing = bits.read(1);
        if (!timing && !bits.read(1)) { // no timing info, no initial display delay: the simple case
          bits.read(5); // operating points - 1
          bits.read(12); // idc
          level = bits.read(5);
          if (level > 7) tier = bits.read(1);
        } else {
          level = 31;
        }
      }
      const record = new Uint8Array(4 + (q + size - p));
      record[0] = 0x81;
      record[1] = (profile << 5) | level;
      record[2] = (tier << 7) | (1 << 3) | (1 << 2); // 8 bit, 4:2:0
      record.set(data.subarray(p, q + size), 4);
      return record;
    }
    p = q + size;
  }
  throw new Error("Couldn't make the AVIF picture (no sequence header).");
}

class Bits {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) v = (v << 1) | ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    return v;
  }
}

// ------------------------------------------------------------ boxes

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function full(type, version, flags, ...parts) {
  return box(type, u8(version), u8(flags >> 16, flags >> 8, flags), ...parts);
}

const u8 = (...v) => Uint8Array.from(v.map((x) => x & 255));
const u16 = (v) => u8(v >> 8, v);
const u32 = (v) => u8(v >>> 24, v >> 16, v >> 8, v);
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function container(data, av1C, [w, h]) {
  const ftyp = box('ftyp', ascii('avif'), u32(0), ascii('avif'), ascii('mif1'), ascii('miaf'));
  const make = (offset) => full('meta', 0, 0,
    full('hdlr', 0, 0, u32(0), ascii('pict'), u32(0), u32(0), u32(0), u8(0)),
    full('pitm', 0, 0, u16(1)),
    full('iloc', 0, 0, u8(0x44, 0x00), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(data.length)),
    full('iinf', 0, 0, u16(1), full('infe', 2, 0, u16(1), u16(0), ascii('av01'), u8(0))),
    box('iprp',
      box('ipco',
        full('ispe', 0, 0, u32(w), u32(h)),
        box('av1C', av1C),
        box('colr', ascii('nclx'), u16(1), u16(13), u16(6), u8(0x80)), // BT.709 primaries, sRGB, BT.601, full range
        full('pixi', 0, 0, u8(3, 8, 8, 8))),
      full('ipma', 0, 0, u32(1), u16(1), u8(4), u8(0x01, 0x82, 0x03, 0x04))));
  const metaLength = make(0).length;
  const meta = make(ftyp.length + metaLength + 8);
  return concat([ftyp, meta, box('mdat', data)]);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
