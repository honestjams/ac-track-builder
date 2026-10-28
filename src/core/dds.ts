// DXT1 (BC1) and DXT5 (BC3, with an alpha channel) DDS encoders with a full mip chain. DDS is the texture format
// Assetto Corsa itself ships, so aerial textures stay small on disk and in
// VRAM: a 1024 px chunk is ~680 KB instead of several MB of PNG.
//
// Block compression uses the inset bounding-box method (J.M.P. van Waveren,
// "Real-Time DXT Compression", 2006): fast, and plenty for aerial photos.

import { BinaryWriter } from "./binary";

function to565(r: number, g: number, b: number): number {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function from565(c: number): [number, number, number] {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function encodeBlock(px: Uint8Array | Uint8ClampedArray, w: number, h: number, bx: number, by: number, out: BinaryWriter): void {
  const block = new Uint8Array(48);
  const min = [255, 255, 255], max = [0, 0, 0];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const sx = Math.min(w - 1, bx + x), sy = Math.min(h - 1, by + y);
      const s = (sy * w + sx) * 4, d = (y * 4 + x) * 3;
      for (let k = 0; k < 3; k++) {
        const v = px[s + k];
        block[d + k] = v;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    const inset = (max[k] - min[k]) >> 4;
    min[k] = Math.min(255, min[k] + inset);
    max[k] = Math.max(0, max[k] - inset);
  }
  let c0 = to565(max[0], max[1], max[2]);
  let c1 = to565(min[0], min[1], min[2]);
  if (c0 < c1) [c0, c1] = [c1, c0];
  let indices = 0;
  if (c0 !== c1) {
    const a = from565(c0), b = from565(c1);
    const palette = [a, b, a.map((v, k) => (2 * v + b[k]) / 3), a.map((v, k) => (v + 2 * b[k]) / 3)];
    for (let i = 15; i >= 0; i--) {
      let best = 0, bestD = Infinity;
      for (let p = 0; p < 4; p++) {
        const dr = block[i * 3] - palette[p][0], dg = block[i * 3 + 1] - palette[p][1], db = block[i * 3 + 2] - palette[p][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      indices = (indices << 2) | best;
    }
  }
  out.u16(c0).u16(c1).u32(indices >>> 0);
}

function downsample(px: Uint8Array | Uint8ClampedArray, w: number, h: number): { px: Uint8Array; w: number; h: number } {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      for (let k = 0; k < 4; k++) {
        let sum = 0, n = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy);
            sum += px[(sy * w + sx) * 4 + k];
            n++;
          }
        }
        out[(y * nw + x) * 4 + k] = Math.round(sum / n);
      }
    }
  }
  return { px: out, w: nw, h: nh };
}

/** RGBA pixels (top row first) -> DXT1 .dds bytes with mipmaps. */
export function encodeDdsDxt1(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  let levels = 1;
  for (let s = Math.max(width, height); s > 1; s >>= 1) levels++;
  const w = new BinaryWriter(Math.ceil((width * height) / 2) * 2 + 256);
  w.magic("DDS ");
  w.u32(124);
  w.u32(0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000); // caps|height|width|pixelformat|mipmapcount|linearsize
  w.u32(height).u32(width);
  w.u32(Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * 8);
  w.u32(0).u32(levels);
  for (let i = 0; i < 11; i++) w.u32(0);
  w.u32(32).u32(0x4).magic("DXT1").u32(0).u32(0).u32(0).u32(0).u32(0); // pixel format
  w.u32(0x1000 | 0x400000 | 0x8).u32(0).u32(0).u32(0).u32(0); // caps: texture|mipmap|complex
  let level = { px: rgba as Uint8Array, w: width, h: height };
  for (let l = 0; l < levels; l++) {
    for (let by = 0; by < level.h; by += 4) {
      for (let bx = 0; bx < level.w; bx += 4) encodeBlock(level.px, level.w, level.h, bx, by, w);
    }
    if (l < levels - 1) level = downsample(level.px, level.w, level.h);
  }
  return w.finish();
}

/** An 8-byte BC3 alpha block: two endpoints and a 3-bit index per pixel (8-value mode). */
function encodeAlphaBlock(px: Uint8Array | Uint8ClampedArray, w: number, h: number, bx: number, by: number, out: BinaryWriter): void {
  const a = new Uint8Array(16);
  let lo = 255, hi = 0;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const sx = Math.min(w - 1, bx + x), sy = Math.min(h - 1, by + y);
      const v = px[(sy * w + sx) * 4 + 3];
      a[y * 4 + x] = v;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  out.u8(hi).u8(lo);
  // Palette for a0 > a1: a0, a1, then six steps between.
  const pal = [hi, lo, ...[1, 2, 3, 4, 5, 6].map((k) => ((7 - k) * hi + k * lo) / 7)];
  // 16 three-bit indices, pixel 0 in the lowest bits: two 24-bit halves of 8 pixels each.
  const idx = new Array<number>(16).fill(0);
  if (hi !== lo) {
    for (let i = 0; i < 16; i++) {
      let best = 0, bd = Infinity;
      for (let p = 0; p < 8; p++) {
        const d = Math.abs(a[i] - pal[p]);
        if (d < bd) [bd, best] = [d, p];
      }
      idx[i] = best;
    }
  }
  for (const half of [0, 8]) {
    let bits = 0;
    for (let i = 7; i >= 0; i--) bits = bits * 8 + idx[half + i];
    out.u8(bits & 255).u8((bits >> 8) & 255).u8((bits >> 16) & 255);
  }
}

/** RGBA pixels (top row first) -> DXT5 .dds bytes with mipmaps: colour like DXT1, plus a smooth alpha channel. */
export function encodeDdsDxt5(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  let levels = 1;
  for (let s = Math.max(width, height); s > 1; s >>= 1) levels++;
  const w = new BinaryWriter(width * height * 2 + 256);
  w.magic("DDS ");
  w.u32(124);
  w.u32(0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | 0x80000);
  w.u32(height).u32(width);
  w.u32(Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * 16);
  w.u32(0).u32(levels);
  for (let i = 0; i < 11; i++) w.u32(0);
  w.u32(32).u32(0x4).magic("DXT5").u32(0).u32(0).u32(0).u32(0).u32(0);
  w.u32(0x1000 | 0x400000 | 0x8).u32(0).u32(0).u32(0).u32(0);
  let level = { px: rgba as Uint8Array, w: width, h: height };
  for (let l = 0; l < levels; l++) {
    for (let by = 0; by < level.h; by += 4) {
      for (let bx = 0; bx < level.w; bx += 4) {
        encodeAlphaBlock(level.px, level.w, level.h, bx, by, w);
        encodeBlock(level.px, level.w, level.h, bx, by, w);
      }
    }
    if (l < levels - 1) level = downsample(level.px, level.w, level.h);
  }
  return w.finish();
}
