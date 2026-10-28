// Minimal PNG encoder (8-bit RGBA or RGB, filter type "up"), so textures and
// UI images can be produced the same way in the browser and in Node tests.

import { unzlibSync, zlibSync } from "fflate";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encodes RGBA pixels (row-major, top row first). Pass `alpha: false` to drop the alpha channel. */
export function encodePng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: { alpha?: boolean; level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } = {},
): Uint8Array {
  const alpha = opts.alpha ?? true;
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = x * channels;
      row[d] = rgba[s];
      row[d + 1] = rgba[s + 1];
      row[d + 2] = rgba[s + 2];
      if (alpha) row[d + 3] = rgba[s + 3];
    }
    const o = y * (stride + 1);
    raw[o] = 2; // "up" filter: cheap and compresses imagery well
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - prev[i]) & 0xff;
    prev = row.slice();
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: opts.level ?? 6 })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Decodes a PNG made by encodePng (8-bit RGB or RGBA, "up" filter only)
 * back to RGBA pixels: for deriving maps from textures we generate.
 */
export function decodeOwnPng(png: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  const channels = png[25] === 6 ? 4 : 3;
  const idat: Uint8Array[] = [];
  for (let p = 8; p < png.length;) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === "IDAT") idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (joined.set(c, o), o + c.length), 0);
  const raw = unzlibSync(joined);
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    if (raw[o] !== 2 && raw[o] !== 0) throw new Error("decodeOwnPng: only the up and none filters are supported");
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) row[i] = (raw[o + 1 + i] + (raw[o] === 2 ? prev[i] : 0)) & 0xff;
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < channels; k++) rgba[(y * width + x) * 4 + k] = row[x * channels + k];
      if (channels === 3) rgba[(y * width + x) * 4 + 3] = 255;
    }
    prev = row;
  }
  return { rgba, width, height };
}
