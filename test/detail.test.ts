import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { detailTexture, groundClasses, groundDetail, groundMask } from "../src/core/textures";

/** Mean brightness of an RGB PNG (8-bit, no filtering tricks needed: decode with zlib and undo filters roughly). */
function pngMean(png: Uint8Array): number {
  // IHDR width/height, then concatenated IDAT.
  const dv = new DataView(png.buffer, png.byteOffset);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  const idat: number[] = [];
  for (let p = 8; p < png.length;) {
    const len = dv.getUint32(p), type = String.fromCharCode(...png.slice(p + 4, p + 8));
    if (type === "IDAT") idat.push(...png.slice(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = unzlibSync(Uint8Array.from(idat));
  const bpp = (raw.length / h - 1) / w;
  // Undo filters (0 none, 1 sub, 2 up, 3 average, 4 paeth).
  const out = new Uint8Array(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + x] = (v + pred) & 255;
    }
  }
  let s = 0;
  for (let i = 0; i < out.length; i++) if (i % bpp < 3) s += out[i];
  return s / (w * h * 3) / 255;
}

describe("detail-mapped materials", () => {
  it("keeps detail textures near white, so they add grain without darkening the surface", () => {
    for (const k of ["asphalt", "chipseal"] as const) {
      const m = pngMean(detailTexture(k));
      expect(m).toBeGreaterThan(0.82);
      expect(m).toBeLessThan(0.99);
    }
  });

  it("tells grass, bare earth and everything else apart in the photo", () => {
    const colours: [number, number, number][] = [
      [70, 110, 50], // lawn
      [170, 150, 100], // dry grass
      [150, 105, 70], // bare red-brown earth
      [90, 90, 95], // asphalt
      [200, 200, 205], // pale roof
      [40, 90, 140], // pool
    ];
    const w = colours.length * 4, h = 4;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...colours[Math.floor(x / 4)], 255], (y * w + x) * 4);
    const { grass, dirt } = groundClasses(rgba, w, h);
    const at = (k: number) => 1 * w + k * 4 + 2; // away from the blurred borders
    expect(grass[at(0)]).toBeGreaterThan(0.95);
    expect(grass[at(1)]).toBeGreaterThan(0.95);
    expect(dirt[at(2)]).toBeGreaterThan(0.95);
    for (const k of [3, 4, 5]) expect(grass[at(k)] + dirt[at(k)]).toBeLessThan(0.05);
  });
});

describe("ground detail and its mask", () => {
  it("weights grass in R, dirt in G and the rest in B, at most 256 texels a side", () => {
    const w = 1024, h = 512;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      rgba.set(x < w / 3 ? [70, 110, 50, 255] : x < (2 * w) / 3 ? [150, 105, 70, 255] : [200, 200, 205, 255], i * 4);
    }
    const m = groundMask(rgba, w, h);
    expect([m.width, m.height]).toEqual([256, 256]);
    const px = (x: number, y: number) => Array.from(m.rgba.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
    expect(px(40, 100)).toEqual([255, 0, 0, 255]); // lawn
    expect(px(128, 100)).toEqual([0, 255, 0, 255]); // bare earth
    expect(px(220, 100)).toEqual([0, 0, 255, 255]); // roof
    for (let i = 0; i < 256 * 256; i++) expect(m.rgba[i * 4] + m.rgba[i * 4 + 1] + m.rgba[i * 4 + 2]).toBe(255);
  });

  it("makes each detail mid grey on average with strong contrast, so doubled it keeps the photo's brightness", () => {
    for (const k of ["grass", "dirt", "plain"] as const) {
      const px = groundDetail(k);
      let sum = 0, sq = 0;
      const n = px.length / 4;
      for (let i = 0; i < n; i++) {
        const l = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3 / 255;
        sum += l;
        sq += l * l;
      }
      const mean = sum / n, sd = Math.sqrt(sq / n - mean * mean);
      expect(mean).toBeGreaterThan(0.47);
      expect(mean).toBeLessThan(0.53);
      if (k === "plain") expect(sd).toBeLessThan(0.05);
      else expect(sd).toBeGreaterThan(0.1);
    }
  });
});

describe("normal maps from height", async () => {
  const { normalFromHeight } = await import("../src/core/textures");
  it("is flat where the texture is even, and tilts away from a dark groove", () => {
    const w = 8, h = 8;
    const rgba = new Uint8Array(w * h * 4).fill(200);
    for (let y = 0; y < h; y++) for (const c of [0, 1, 2]) rgba[(y * w + 4) * 4 + c] = 60; // a dark crack down column 4
    const n = normalFromHeight(rgba, w, h, 2);
    const px = (x: number, y: number) => [n[(y * w + x) * 4], n[(y * w + x) * 4 + 1], n[(y * w + x) * 4 + 2]];
    expect(px(1, 2)).toEqual([128, 128, 255]); // flat: straight up
    expect(px(3, 2)[0]).toBeGreaterThan(140); // left wall of the groove faces +x (toward the crack)...
    expect(px(5, 2)[0]).toBeLessThan(116); // ...and the right wall faces -x
  });
});
