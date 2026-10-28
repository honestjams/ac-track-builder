import { describe, expect, it } from "vitest";


describe("DXT5", async () => {
  const { encodeDdsDxt5 } = await import("../src/core/dds");
  it("keeps the alpha channel: decoded alpha within a step of the source", () => {
    const W = 8, H = 8;
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      px[i * 4] = 120; px[i * 4 + 1] = 140; px[i * 4 + 2] = 90;
      px[i * 4 + 3] = (i % W) < 4 ? 0 : 255; // left half fully transparent, right half opaque
    }
    const dds = encodeDdsDxt5(px, W, H);
    expect(new TextDecoder().decode(dds.slice(84, 88))).toBe("DXT5");
    // First block (top-left 4x4): alpha endpoints, then 48 bits of 3-bit indices.
    const a0 = dds[128], a1 = dds[129];
    expect(a0).toBe(0);
    expect(a1).toBe(0);
    // Second block (x 4..7): all opaque.
    expect(dds[128 + 16]).toBe(255);
    // Size: 4 blocks of 16 bytes at level 0, then 1 block each for 4x4, 2x2, 1x1.
    expect(dds.length).toBe(128 + 16 * 4 + 16 * 3);
  });
});

describe("DXT5 alpha indices", async () => {
  const { encodeDdsDxt5 } = await import("../src/core/dds");
  it("decodes back to the source alpha across a gradient", () => {
    const W = 4, H = 4;
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < 16; i++) px[i * 4 + 3] = Math.round((i / 15) * 255);
    const dds = encodeDdsDxt5(px, W, H);
    const a0 = dds[128], a1 = dds[129];
    const pal = [a0, a1, ...[1, 2, 3, 4, 5, 6].map((k) => ((7 - k) * a0 + k * a1) / 7)];
    const lo = dds[130] | (dds[131] << 8) | (dds[132] << 16), hi = dds[133] | (dds[134] << 8) | (dds[135] << 16);
    for (let i = 0; i < 16; i++) {
      const bits = i < 8 ? (lo >> (3 * i)) & 7 : (hi >> (3 * (i - 8))) & 7;
      expect(Math.abs(pal[bits] - px[i * 4 + 3])).toBeLessThanOrEqual(19);
    }
  });
});
