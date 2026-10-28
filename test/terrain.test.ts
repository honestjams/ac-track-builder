import { describe, expect, it } from "vitest";
import { planRoad, SegmentIndex } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { makeTerrainFn } from "../src/core/terrain";
import { KERB_H } from "../src/core/kerbs";
import type { Vec2 } from "../src/core/geo";

/**
 * The ground as the terrain mesh draws it: heights at grid nodes, linear in
 * between. A narrow ditch or a bump at the road edge lives between nodes.
 */
function meshAt(f: (x: number, y: number) => { h: number }, step: number) {
  return (x: number, y: number) => {
    const i = Math.floor(x / step), j = Math.floor(y / step);
    const u = x / step - i, v = y / step - j;
    const h = (a: number, b: number) => f((i + a) * step, (j + b) * step).h;
    return h(0, 0) * (1 - u) * (1 - v) + h(1, 0) * u * (1 - v) + h(0, 1) * (1 - u) * v + h(1, 1) * u * v;
  };
}

describe("terrain beside the road", () => {
  // A flat 8 m road at 10 m, at an angle to the grid, on flat ground at the same level.
  const dir: Vec2 = [Math.cos(0.5), Math.sin(0.5)];
  const path: Vec2[] = Array.from({ length: 16 }, (_, i) => [i * 20 * dir[0] + 0.7, i * 20 * dir[1] + 0.3]);
  const opts = withDefaults({ widthOverride: 8 });
  const half = 4;
  const edge = 10 - opts.crown * half;
  const across = (t: number): Vec2 => {
    const c: Vec2 = [path[8][0], path[8][1]];
    return [c[0] - dir[1] * t, c[1] + dir[0] * t];
  };

  for (const [kerbed, grade] of [[false, 0], [true, 0], [false, 0.1], [true, 0.1]] as const) {
    it(`leaves no ditch along the edge and never pokes through (${kerbed ? "kerb" : "gravel verge"}, ${grade * 100}% grade)`, () => {
      const plan = planRoad(path, opts);
      // Height gained up the road at a point.
      const rise = (x: number, y: number) => grade * ((x - path[0][0]) * dir[0] + (y - path[0][1]) * dir[1]);
      plan.samples.forEach((s) => {
        s.h = 10 + rise(...s.pos);
        if (kerbed) s.kerb = [1, 1];
      });
      const terrain = makeTerrainFn(plan, new SegmentIndex(plan), (x, y) => (kerbed ? 10 + KERB_H : 10 - 0.25) + rise(x, y), opts);
      // Many cross-sections, sliding along the road, so the grid falls every which way.
      let ditch = 0, poke = -Infinity;
      for (let k = 0; k < 40; k++) {
        // Shift the grid against the road a little each time.
        const o: Vec2 = [dir[0] * k * 0.37, dir[1] * k * 0.37];
        const mesh = meshAt((x, y) => terrain(x - o[0], y - o[1]), opts.terrainStep);
        const outer = half + opts.vergeWidth + (kerbed ? 1.5 : 0);
        for (const side of [1, -1]) {
          for (let t = 0; t <= 14; t += 0.1) {
            const p = across(side * t);
            const g = mesh(p[0] + o[0], p[1] + o[1]) - rise(...p);
            // What's on top here: road, then verge (or gutter, kerb and nature strip).
            const top = t <= half ? 10 - opts.crown * t
              : t > outer ? NaN
              : kerbed ? (t <= half + 0.3 ? edge - 0.02 : edge + KERB_H)
              : edge - (0.2 * (t - half)) / opts.vergeWidth;
            if (Number.isFinite(top)) poke = Math.max(poke, g - top);
            // Beyond the made surface the ground should be at the level it is meant to be.
            if (t > outer + 0.2 && t < outer + 6) ditch = Math.max(ditch, (kerbed ? edge + KERB_H - 0.03 : edge - 0.25) - g);
          }
        }
      }
      expect(poke).toBeLessThan(-0.01);
      expect(ditch).toBeLessThan(0.08);
    });
  }
});
