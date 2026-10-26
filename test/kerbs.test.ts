import { describe, expect, it } from "vitest";
import { planRoad } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { buildKerbReturns, buildKerbs, kerbEvidence, KERB_H, planKerbs, RETURN_R } from "../src/core/kerbs";
import type { RasterSampler } from "../src/core/trace";
import type { Vec2 } from "../src/core/geo";

/**
 * An 8 m street along y = 0. North side (left, driving east): concrete
 * kerb and gutter then grass. South side: an edge line, then a sealed
 * shoulder (no kerb).
 */
function street(): RasterSampler {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return (_x, y) => {
    const n = (rnd() - 0.5) * 0.03;
    if (y >= 4 && y < 4.45) return [0.66 + n, 0.66 + n, 0.64 + n]; // gutter + kerb top
    if (y >= 4.45) return [0.3 + n, 0.42 + n, 0.18 + n]; // nature strip
    if (y > -4.0 && y < -3.88) return [0.85, 0.85, 0.83]; // edge line
    return [0.3 + n, 0.3 + n, 0.32 + n]; // asphalt, and the sealed shoulder beyond the line
  };
}

describe("kerb and gutter", () => {
  const path: Vec2[] = Array.from({ length: 16 }, (_, i) => [i * 20, 0]);
  const opts = withDefaults({ widthOverride: 8 });
  const plan = planRoad(path, opts);
  const ev = kerbEvidence(plan, street(), () => true);
  const frac = (v: number[]) => v.filter((x) => x === 1).length / v.length;

  it("sees the kerb band, not an edge line with seal beyond it", () => {
    expect(frac(ev[0])).toBeGreaterThan(0.8);
    expect(frac(ev[1])).toBeLessThan(0.05);
  });

  it("plans kerbs from the evidence, out of town too when it is clear", () => {
    const k = planKerbs(plan, ev, () => 0, () => false);
    expect(frac(k[0])).toBeGreaterThan(0.9);
    expect(frac(k[1])).toBe(0);
  });

  it("assumes kerbs in town where the road couldn't be seen, but not across a side street", () => {
    const blind: [number[], number[]] = [plan.samples.map(() => NaN), plan.samples.map(() => NaN)];
    const mouthAt = plan.samples.findIndex((s) => s.s >= 150);
    const k = planKerbs(plan, blind, () => 2, (i, side) => side === -1 && Math.abs(i - mouthAt) <= 3);
    expect(k[0].every((v) => v === 1)).toBe(true);
    expect(k[1].slice(mouthAt - 3, mouthAt + 4).every((v) => v === 0)).toBe(true);
    expect(k[1][mouthAt - 10]).toBe(1);
    // Nothing on the edge of town without evidence.
    const rural = planKerbs(plan, blind, () => 1, () => false);
    expect(rural[0].concat(rural[1]).every((v) => v === 0)).toBe(true);
  });

  it("builds a gutter, a 150 mm kerb and a nature strip with physics names", () => {
    plan.samples.forEach((s) => (s.h = 10));
    const k = planKerbs(plan, ev, () => 0, () => false);
    const m = buildKerbs(plan, opts, k, () => ({ material: "grass", photo: false }));
    expect(m.gutter[0].name).toMatch(/^1ROAD_GUTTER_/);
    expect(m.kerb[0].name).toMatch(/^1KERB_/);
    expect(m.strip[0].name).toMatch(/^1GRASS_STRIP_/);
    const zs = (node: (typeof m.kerb)[number]) => Array.from({ length: node.positions.length / 3 }, (_, i) => node.positions[i * 3 + 1]);
    // AC Y is up: the kerb top sits KERB_H above the road edge (crown drops the edge a little).
    const edge = 10 - opts.crown * 4;
    expect(Math.max(...zs(m.kerb[0]))).toBeCloseTo(edge + KERB_H, 2);
    expect(Math.min(...zs(m.gutter[0]))).toBeLessThan(edge);
    // Only the north side has one: every kerb vertex is north of the road (AC z = -north).
    const zsNorth = Array.from({ length: m.kerb[0].positions.length / 3 }, (_, i) => -m.kerb[0].positions[i * 3 + 2]);
    expect(Math.min(...zsNorth)).toBeGreaterThan(3.9);
    // Kerb face normals point back at the road (south, AC +z) or up.
    const nz = Array.from({ length: m.kerb[0].normals.length / 3 }, (_, i) => [m.kerb[0].normals[i * 3 + 1], -m.kerb[0].normals[i * 3 + 2]]);
    expect(nz.every(([up, north]) => up > 0.1 || north < -0.5)).toBe(true);
  });

  it("curves the kerb round the corners into a side street, with asphalt filling the corner", () => {
    plan.samples.forEach((s) => (s.h = 10));
    const mid = plan.samples.findIndex((s) => s.s >= 150);
    const k: [number[], number[]] = [plan.samples.map(() => 1), plan.samples.map(() => 0)];
    for (let i = mid - 4; i <= mid + 4; i++) k[0][i] = 0;
    // A 7 m street heading north off the left (north) side at x = 150.
    const { nodes, noRamp } = buildKerbReturns(plan, opts, [{ seg: mid, side: 1, width: 7, dir: [0, 1] }], k, "road");
    // Each corner replaces the road kerb's slope down toward the mouth.
    expect(noRamp.size).toBe(2);
    const names = nodes.map((n) => n.name);
    expect(names).toEqual(["1ROAD_GUTTER_RET", "1KERB_RET", "1GRASS_STRIP_RET", "1STREET_RETFILL"]);
    const kerb = nodes[1];
    const pts = Array.from({ length: kerb.positions.length / 3 }, (_, i) => [kerb.positions[i * 3], -kerb.positions[i * 3 + 2]]);
    // Both corners: west of the street and east of it, all north of the road edge and outside the street.
    const x0 = plan.samples[mid].pos[0];
    expect(pts.some(([x]) => x < x0 - 3.5)).toBe(true);
    expect(pts.some(([x]) => x > x0 + 3.5)).toBe(true);
    for (const [x, y] of pts) {
      expect(y).toBeGreaterThan(4 - 0.01);
      expect(Math.abs(x - x0)).toBeGreaterThan(3.5 - 0.01);
      expect(Math.abs(x - x0)).toBeLessThan(3.5 + 3 * RETURN_R);
    }
    // The fill faces up.
    const fill = nodes[3];
    for (let i = 1; i < fill.normals.length; i += 3) expect(fill.normals[i]).toBeGreaterThan(0.9);
    // No return where the road has no kerb (the south side).
    expect(buildKerbReturns(plan, opts, [{ seg: mid, side: -1, width: 7, dir: [0, -1] }], k, "road").nodes).toHaveLength(0);
  });
});
