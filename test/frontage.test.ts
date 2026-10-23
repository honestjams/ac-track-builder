import { describe, expect, it } from "vitest";
import { frontageHouses, roofLike, type PhotoSampler } from "../src/core/frontage";
import { centroid, ringArea } from "../src/core/buildings";

/**
 * A 7 m street along y = 0. North side: houses 6 m behind the kerb, 15 m
 * deep: a grey one, a terracotta one, then a dark one and a pale one with
 * no gap between them. Lawn everywhere else; the south side is all lawn.
 */
const ROOFS: { x0: number; x1: number; rgb: [number, number, number] }[] = [
  { x0: 10, x1: 22, rgb: [0.55, 0.56, 0.57] },
  { x0: 26, x1: 39, rgb: [0.72, 0.38, 0.25] },
  { x0: 44, x1: 56, rgb: [0.22, 0.23, 0.25] },
  { x0: 56, x1: 69, rgb: [0.8, 0.8, 0.79] },
];
const scene: PhotoSampler = (x, y) => {
  if (Math.abs(y) < 3.5) return [0.3, 0.3, 0.31];
  for (const r of ROOFS) if (x >= r.x0 && x < r.x1 && y > 9.5 && y < 24.5) return r.rgb;
  return [0.3, 0.42, 0.2];
};

describe("houses along street frontages", () => {
  const houses = frontageHouses(
    [{ pts: [[0, 0], [80, 0]], half: [3.5, 3.5] }],
    scene,
    (_x, y) => Math.abs(y) < 3.5,
    () => true,
    [],
  );

  it("finds one house per roof, including the dark one, split from its pale neighbour", () => {
    expect(houses).toHaveLength(4);
    const xs = houses.map((h) => centroid(h.ring)[0]).sort((a, b) => a - b);
    ROOFS.forEach((r, i) => expect(Math.abs(xs[i] - (r.x0 + r.x1) / 2)).toBeLessThan(1.5));
  });

  it("puts them square to the street, at the photo's setback and depth", () => {
    for (const h of houses) {
      const ys = h.ring.map((p) => p[1]);
      expect(Math.min(...ys)).toBeGreaterThan(8.5);
      expect(Math.min(...ys)).toBeLessThan(11);
      expect(Math.max(...ys)).toBeGreaterThan(22);
      expect(Math.max(...ys)).toBeLessThan(26);
      expect(Math.abs(ringArea(h.ring))).toBeGreaterThan(120);
      expect(h.source).toBe("frontage");
    }
  });

  it("leaves lawn, pools and bare earth alone", () => {
    expect(houses.every((h) => centroid(h.ring)[1] > 0)).toBe(true);
    expect(roofLike([0.3, 0.42, 0.2])).toBe(false);
    expect(roofLike([0.2, 0.55, 0.65])).toBe(false);
    expect(roofLike([0.62, 0.55, 0.42])).toBe(false);
    expect(roofLike([0.72, 0.38, 0.25])).toBe(true);
  });

  it("only where it's built up, and not on top of known buildings", () => {
    const none = frontageHouses([{ pts: [[0, 0], [80, 0]], half: [3.5, 3.5] }], scene, (_x, y) => Math.abs(y) < 3.5, () => false, []);
    expect(none).toHaveLength(0);
    const fewer = frontageHouses([{ pts: [[0, 0], [80, 0]], half: [3.5, 3.5] }], scene, (_x, y) => Math.abs(y) < 3.5, () => true, [houses[0]]);
    expect(fewer).toHaveLength(3);
  });
});
