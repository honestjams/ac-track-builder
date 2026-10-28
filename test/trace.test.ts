import { describe, expect, it } from "vitest";
import { planRoad } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { applyTrace, traceRoad, type RasterSampler } from "../src/core/trace";
import type { Vec2 } from "../src/core/geo";
import type { SideStreet } from "../src/core/sideStreets";

/** OSM line along y = 0; the real 9 m road is centred 1.5 m north of it. */
function photo(): RasterSampler {
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return (x, y) => {
    const n = (rnd() - 0.5) * 0.04;
    if (x > 50 && x < 150) return [0.12 + n, 0.3 + n, 0.1 + n]; // tree canopy over the road
    const t = y - 1.5;
    if (Math.abs(t) < 4.5) {
      if (x > -102 && x < -98 && t > 0.5 && t < 2.3) return [0.75, 0.1, 0.1]; // a red car
      if (Math.abs(t) < 0.06 && ((x % 12) + 12) % 12 < 3) return [0.85, 0.85, 0.83]; // dashed centre line
      const shade = x > -200 && x < -170 ? 0.6 : 1; // a tree shadow across the road
      return [(0.38 + n) * shade, (0.38 + n) * shade, (0.4 + n) * shade];
    }
    return [0.33 + n, 0.45 + n, 0.2 + n]; // grass
  };
}

describe("road tracing", () => {
  const path: Vec2[] = Array.from({ length: 31 }, (_, i) => [i * 20 - 300, 0]);
  const plan = planRoad(path, withDefaults({ widthOverride: 6 }));
  const tr = traceRoad(plan, photo());
  const at = (x: number) => plan.samples.findIndex((s) => s.pos[0] >= x);

  it("finds the real centre and width where the road is visible", () => {
    expect(tr.coverage).toBeGreaterThan(0.6);
    for (const x of [-250, -100, -185, 0, 250]) {
      const i = at(x);
      expect(tr.offset[i]).toBeCloseTo(1.5, 0);
      expect(tr.width[i]).toBeGreaterThan(8.3);
      expect(tr.width[i]).toBeLessThan(9.7);
    }
  });

  it("falls back to OSM under tree canopy", () => {
    const i = at(100);
    expect(tr.conf[i]).toBeLessThan(0.2);
    expect(Math.abs(tr.offset[i])).toBeLessThan(0.4);
  });

  it("moves the centreline and width onto the traced road", () => {
    const copy = planRoad(path, withDefaults({ widthOverride: 6 }));
    applyTrace(copy, tr, () => false);
    const i = at(-250);
    expect(copy.samples[i].pos[1]).toBeCloseTo(1.5, 0);
    expect(copy.samples[i].width).toBeCloseTo(9, 0);
    expect(copy.samples[at(100)].width).toBeLessThan(6.6);
  });
});

describe("photo road surface", async () => {
  const { photoRoadTexture, PHOTO_W } = await import("../src/core/photoSurface");
  const path: Vec2[] = Array.from({ length: 31 }, (_, i) => [i * 20 - 300, 0]);
  const plan = planRoad(path, withDefaults({ widthOverride: 9 }));
  plan.samples.forEach((s) => (s.pos = [s.pos[0], s.pos[1] + 1.5]));
  const tex = photoRoadTexture(plan, photo(), 0, 120, () => true);

  it("covers the chunk and paints out cars and line paint", () => {
    expect(tex.width).toBe(PHOTO_W);
    let red = 0, white = 0;
    for (let i = 0; i < tex.rgba.length; i += 4) {
      const [r, g, b] = [tex.rgba[i], tex.rgba[i + 1], tex.rgba[i + 2]];
      if (r > 150 && g < 80) red++;
      if (r > 170 && g > 170 && b > 170) white++;
    }
    expect(red).toBe(0);
    expect(white).toBe(0);
  });

  it("evens out the tree shadow", () => {
    // rows over x = -185 (in the shadow) vs x = -250, centre column brightness
    const row = (x: number) => Math.floor(((x + 300) / 240) * tex.height);
    const lum = (r: number) => {
      let sum = 0;
      for (let c = 20; c < 60; c++) sum += tex.rgba[(r * tex.width + c) * 4];
      return sum / 40;
    };
    expect(lum(row(-185)) / lum(row(-250))).toBeGreaterThan(0.85);
  });
});

describe("side street tracing", async () => {
  const { traceSideStreets } = await import("../src/core/sideStreets");
  // A street running north from a junction at y = 4; the real 7 m road is centred at x = 1.2.
  const raster: RasterSampler = (x, y) => {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 0.015;
    return Math.abs(x - 1.2) < 3.5 && y > 0 ? [0.37 + n, 0.37 + n, 0.39 + n] : [0.32 + n, 0.44 + n, 0.2 + n];
  };
  const st: SideStreet = { pts: Array.from({ length: 50 }, (_, i) => [0, 4 + i * 4] as Vec2), width: 5, cls: "minor", joins: [0] };

  it("moves the street onto its real line but keeps the junction end in place", () => {
    expect(traceSideStreets([st], raster, withDefaults({}))).toBe(1);
    expect(st.pts[0][0]).toBeCloseTo(0, 1);
    expect(st.pts[st.pts.length - 30][0]).toBeCloseTo(1.2, 0);
    expect(st.widths![st.pts.length - 30]).toBeCloseTo(7, 0);
  });
});

describe("road tracing beside grey roofs and parking", () => {
  /**
   * A main street: an 8 m road on the OSM line (y = 0), angled parking the
   * same colour as the road along the north side, then grey shop awnings
   * right up to it, all much like asphalt from above.
   */
  function mainStreet(): RasterSampler {
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return (_x, y) => {
      const n = (rnd() - 0.5) * 0.04;
      if (y > -4 && y < 9.5) return [0.38 + n, 0.38 + n, 0.4 + n]; // road, then parking bays
      if (y >= 9.5 && y < 40) return [0.4 + n, 0.4 + n, 0.42 + n]; // awnings
      return [0.33 + n, 0.45 + n, 0.2 + n]; // grass
    };
  }
  const path: Vec2[] = Array.from({ length: 31 }, (_, i) => [i * 20 - 300, 0]);
  const plan = planRoad(path, withDefaults({ widthOverride: 8 }));
  const tr = traceRoad(plan, mainStreet());

  it("doesn't walk off onto the roofs", () => {
    for (const i of plan.samples.keys()) expect(Math.abs(tr.offset[i])).toBeLessThan(1);
  });
});
