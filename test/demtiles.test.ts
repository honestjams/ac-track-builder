import { describe, expect, it } from "vitest";
import { upsample } from "../src/services/tiles";

describe("state elevation tiles", () => {
  it("cuts a finer tile out of its parent without shifting it", () => {
    // Height = parent pixel column (a ramp east), so a child pixel's height says where it sampled.
    const parent = new Float32Array(256 * 256);
    for (let i = 0; i < parent.length; i++) parent[i] = i % 256;
    // The south-east quarter, one zoom finer: child column c covers parent columns 128 + c / 2.
    const child = upsample(parent, 1, 1, 1);
    for (const c of [10, 100, 200]) expect(child[50 * 256 + c]).toBeCloseTo(128 + (c + 0.5) / 2 - 0.5, 5);
  });
});
