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

describe("terrain at a roundabout mouth", () => {
  // A kerbed 8 m road running straight into a kerbed ring centred on it: the ground under the
  // mouth must stay below the road, not ramp up toward kerb height (a lip at every entry).
  const path: Vec2[] = Array.from({ length: 16 }, (_, i) => [i * 20, 0.3]);
  const opts = withDefaults({ widthOverride: 8, terrainStep: 1.5, terrainUnderRoad: 0.12 });
  for (const step of [1.5, 3]) {
    it(`keeps the ground under the arm where it meets the ring (${step} m grid)`, () => {
      const o = { ...opts, terrainStep: step };
      const plan = planRoad(path, o);
      plan.samples.forEach((s) => {
        s.h = 10;
        s.kerb = [1, 1];
      });
      const c: Vec2 = [150, 0.3];
      const span = 0.5;
      plan.roundabouts.push({ c, r: 12, w: 8, hc: 10, sIn: 0, sOut: 0, crossings: [0, Math.PI], kerbed: true, openings: [[-span, span], [Math.PI - span, Math.PI + span]] });
      const terrain = makeTerrainFn(plan, new SegmentIndex(plan), () => 10 + KERB_H, o);
      const mesh = meshAt(terrain, step);
      let poke = -Infinity;
      for (let x = 150 + 15.5; x < 150 + 22; x += 0.1) {
        for (let t = -3.5; t <= 3.5; t += 0.5) poke = Math.max(poke, mesh(x, 0.3 + t) - (10 - o.crown * Math.abs(t)));
      }
      expect(poke).toBeLessThan(-0.01);
      // Nor up through the ring's gutter (0.3 m, falling 3 cm), away from the mouths;
      // and no deep ditch behind the grass strip.
      let gutter = -Infinity, ditch = 0;
      for (let a = 1; a < 2.1; a += 0.01) {
        const at = (r: number) => mesh(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r);
        const zi = 10 + 0.02 * (12 - 16);
        for (let r = 16; r <= 16.3; r += 0.02) gutter = Math.max(gutter, at(r) - (zi - 0.1 * (r - 16)));
        for (let r = 16.1 + Math.max(3, 0.35 + 2 * step); r < 30; r += 0.1) ditch = Math.max(ditch, zi + KERB_H - 0.03 - at(r));
      }
      expect(gutter).toBeLessThan(-0.01);
      expect(ditch).toBeLessThan(0.1);
    });
  }
});
