import { describe, expect, it } from "vitest";
import { planRoad, SegmentIndex } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { placeUtilities } from "../src/core/utilities";
import type { Vec2 } from "../src/core/geo";
import type { Piece } from "../src/core/furniture";

// An 8 m street heading east along y = 0, 600 m long.
const path: Vec2[] = Array.from({ length: 31 }, (_, i) => [i * 20, 0]);
const opts = withDefaults({ widthOverride: 8 });
const plan = planRoad(path, opts);
plan.samples.forEach((s) => (s.h = 10));
const index = new SegmentIndex(plan);
const boxes = (pieces: Piece[], material: string) => pieces.filter((p): p is Extract<Piece, { kind: "box" }> => p.kind === "box" && p.material === material);

describe("power poles, wires and street lights", () => {
  it("lights a built-up street at a steady spacing, and not the country", () => {
    const town = placeUtilities({ poles: [], lamps: [], lines: [] }, plan, index, opts, () => 2);
    expect(town.lights.length).toBeGreaterThanOrEqual(10);
    expect(town.poles).toBe(0); // power poles are never invented
    expect(town.wires).toHaveLength(0);
    const xs = town.lights.map((l) => l[0]).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThan(35);
    // Lantern over the road edge, up high.
    for (const l of town.lights) {
      expect(Math.abs(l[1])).toBeLessThan(4);
      expect(l[2]).toBeGreaterThan(17);
    }
    const country = placeUtilities({ poles: [], lamps: [], lines: [] }, plan, index, opts, () => 0);
    expect(country.lights).toHaveLength(0);
  });

  it("keeps lights off side streets and other blocked spots", () => {
    const u = placeUtilities({ poles: [], lamps: [], lines: [] }, plan, index, opts, () => 2, (x) => x > 200 && x < 400);
    for (const l of u.lights) expect(l[0] < 195 || l[0] > 405).toBe(true);
  });

  it("puts poles seen on the road onto the nature strip, crossarm across the street, wires between them", () => {
    // A row of poles on the north side every 40 m; one sighting lands on the road.
    const poles: Vec2[] = [[50, 5.5], [90, 5.2], [130, 1.5], [170, 5.4]];
    const u = placeUtilities({ poles, lamps: [], lines: [] }, plan, index, opts, () => 0);
    expect(u.poles).toBe(4);
    const posts = boxes(u.pieces, "timber").filter((b) => b.length < 0.5);
    for (const p of posts) expect(p.at[1]).toBeGreaterThan(4.5); // behind the kerb, not on the road
    const arms = boxes(u.pieces, "timber").filter((b) => b.length > 2);
    for (const a of arms) expect(Math.abs(a.along[1])).toBeGreaterThan(0.99); // across the street (north-south)
    // Three spans, each with conductors sagging between the poles.
    expect(u.wires.length).toBeGreaterThan(0);
    const p = u.wires[0].positions;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (Math.abs(p[i] - 70) < 1) lo = Math.min(lo, p[i + 1]); // mid-span, AC y is up
      if (Math.abs(p[i] - 50) < 0.3) hi = Math.max(hi, p[i + 1]);
    }
    expect(hi - lo).toBeGreaterThan(0.3);
    expect(lo).toBeGreaterThan(10 + 7); // sags, but well clear of a truck
  });

  it("mounts a nearby street light on the power pole instead of a pole of its own", () => {
    const u = placeUtilities({ poles: [[100, 5.5]], lamps: [[101, 5]], lines: [] }, plan, index, opts, () => 0);
    expect(u.lights).toHaveLength(1);
    expect(boxes(u.pieces, "steel").filter((b) => b.length < 0.5 && b.depth < 0.5 && b.z1 - b.z0 > 5)).toHaveLength(0);
    expect(boxes(u.pieces, "lamp")).toHaveLength(1);
  });

  it("strings wires along a mapped power line through its poles", () => {
    const line: Vec2[] = [[300, -5.5], [340, -5.5], [380, -5.5]];
    const u = placeUtilities({ poles: [], lamps: [], lines: [line] }, plan, index, opts, () => 0);
    expect(u.poles).toBe(3);
    expect(u.wires.length).toBeGreaterThan(0);
  });
});
