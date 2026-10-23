import { describe, expect, it } from "vitest";
import { applyColours, matchColours } from "../src/core/colour";

describe("colour matching", () => {
  it("takes a blue cast off to match the reference", () => {
    const n = 64 * 64;
    const ref = new Uint8ClampedArray(n * 4), src = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const v = (i * 37) % 50;
      ref.set([40 + v, 60 + v, 30 + v * 0.6, 255], i * 4); // green bush
      src.set([55 + v * 0.7, 66 + v * 0.7, 85 + v * 0.7, 255], i * 4); // the same, hazy and blue
    }
    const t = matchColours(src, ref)!;
    applyColours(src, t);
    for (const i of [0, 100, 2000]) {
      for (let k = 0; k < 3; k++) expect(Math.abs(src[i * 4 + k] - ref[i * 4 + k])).toBeLessThan(3);
    }
  });
});
