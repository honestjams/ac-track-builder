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
