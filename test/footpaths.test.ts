import { describe, expect, it } from "vitest";
import { planRoad } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { buildVergeConcrete, readVerge } from "../src/core/footpaths";
import type { RasterSampler } from "../src/core/trace";
import type { Vec2 } from "../src/core/geo";

/**
 * An 8 m street along y = 0 with kerbs. North side: grass, a 1.2 m concrete
 * footpath 2.0-3.2 m behind the road edge, and driveways (concrete from the
 * kerb to 4.5 m) at x 100-106 and 200-205. South side: grass only.
 */
function suburb(): RasterSampler {
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return (x, y) => {
    const n = (rnd() - 0.5) * 0.04;
    if (Math.abs(y) < 4) return [0.33 + n, 0.33 + n, 0.35 + n]; // asphalt
    if (y > 4 && y < 4.5) return [0.7 + n, 0.7 + n, 0.68 + n]; // kerb
    const drive = (x > 100 && x < 106) || (x > 200 && x < 205);
    if (y > 4 && y < 8.5 && drive) return [0.66 + n, 0.65 + n, 0.62 + n];
    if (y > 6 && y < 7.2) return [0.68 + n, 0.67 + n, 0.64 + n]; // footpath
    return [0.32 + n, 0.46 + n, 0.2 + n]; // lawn
  };
}

describe("footpaths and crossovers", () => {
  const path: Vec2[] = Array.from({ length: 21 }, (_, i) => [i * 20, 0]);
  const opts = withDefaults({ widthOverride: 8 });
  const plan = planRoad(path, opts);
  plan.samples.forEach((s) => (s.h = 10));
  const kerbs: [number[], number[]] = [plan.samples.map(() => 1), plan.samples.map(() => 1)];
  const vc = readVerge(plan, suburb(), kerbs, 3);

  it("finds the footpath on the side that has one, at its offset and width", () => {
    const at = (x: number) => plan.samples.findIndex((s) => s.pos[0] >= x);
    for (const x of [50, 150, 300]) {
      const b = vc.paths[0][at(x)];
      expect(b).not.toBeNull();
      expect(b!.d0).toBeCloseTo(2.0, 0);
      expect(b!.d1 - b!.d0).toBeGreaterThan(1);
      expect(b!.d1 - b!.d0).toBeLessThan(1.5);
    }
    // Carried across the driveway gap.
    expect(vc.paths[0][at(103)]).not.toBeNull();
    expect(vc.paths[1].every((b) => b === null)).toBe(true);
  });

  it("finds the two driveway crossovers", () => {
    expect(vc.drives).toHaveLength(2);
    const xs = vc.drives.map((d) => plan.samples[d.i0].pos[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeGreaterThan(98);
    expect(xs[0]).toBeLessThan(106);
    expect(xs[1]).toBeGreaterThan(198);
    expect(vc.drives.every((d) => d.side === 1)).toBe(true);
  });

  it("leaves unkerbed edges alone (no footpath without a kerb)", () => {
    const none = readVerge(plan, suburb(), [plan.samples.map(() => 0), plan.samples.map(() => 0)], 3);
    expect(none.paths[0].every((b) => b === null)).toBe(true);
    expect(none.drives).toHaveLength(0);
  });

  it("builds concrete slabs proud of the ground, facing up, off the road", () => {
    const nodes = buildVergeConcrete(plan, vc, () => 10.15);
    expect(nodes.some((n) => /^1STREET_PATH_/.test(n.name))).toBe(true);
    expect(nodes.some((n) => n.name === "1STREET_DRIVE_000")).toBe(true);
    for (const n of nodes) {
      expect(n.material).toBe("concrete");
      for (let i = 0; i < n.positions.length; i += 3) {
        const north = -n.positions[i + 2];
        expect(north).toBeGreaterThan(4.4); // never on the road
        expect(n.positions[i + 1]).toBeLessThan(10.2);
      }
      // The top faces up: most normals point up, none down.
      let up = 0;
      for (let i = 1; i < n.normals.length; i += 3) {
        expect(n.normals[i]).toBeGreaterThan(-0.01);
        if (n.normals[i] > 0.9) up++;
      }
      expect(up).toBeGreaterThan(0);
    }
  });
});

describe("letterboxes", async () => {
  const { letterboxes, readVerge: read } = await import("../src/core/footpaths");
  it("stands one at the property line beside each driveway", () => {
    const path: Vec2[] = Array.from({ length: 21 }, (_, i) => [i * 20, 0]);
    const plan = planRoad(path, withDefaults({ widthOverride: 8 }));
    plan.samples.forEach((s) => (s.h = 10));
    const vc = read(plan, suburb(), [plan.samples.map(() => 1), plan.samples.map(() => 1)], 3);
    const boxes = letterboxes(plan, vc, () => 10.15).filter((p) => p.kind === "box" && p.material === "letterbox");
    expect(boxes).toHaveLength(vc.drives.length);
    for (const b of boxes) {
      if (b.kind !== "box") continue;
      expect(b.at[1]).toBeGreaterThan(4 + 3); // behind the crossover, at the property line
      expect(b.z0).toBeGreaterThan(10.9);
    }
  });
});
