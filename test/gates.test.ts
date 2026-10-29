import { describe, expect, it } from "vitest";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import type { LngLat } from "../src/core/geo";
import { encodePng } from "../src/core/png";
import type { Kn5Node } from "../src/core/kn5";

const lat0 = -27.92, lng0 = 153.19;
const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180), my = 111_320;
const route: LngLat[] = [];
for (let x = 0; x <= 1500; x += 20) route.push([lng0 + x / mx, lat0 + (Math.sin(x / 200) * 30) / my]);

const sources: DataSources = {
  dem: async (proj, bounds, z) => DemGrid.fromFunction(proj, z, bounds, () => 50).sample,
  widthAt: () => 7,
  // Every piece of art gets a cell; we only care where the faces end up.
  renderArt: async (items) => ({
    data: encodePng(new Uint8Array(4 * 4 * 4), 4, 4, { alpha: true }),
    cells: Object.fromEntries(items.map((r) => [r.key, { u0: 0, v0: 0, u1: 1, v1: 1, aspect: r.kind === "gate" ? 3.2 : 1 }])),
  }),
};

describe("timing gate signs", async () => {
  // The plain signs; with race-day dressing a gantry replaces them (raceDress.test.ts).
  const result = await buildTrack(route, { name: "Gates", imageryZoom: 0, corridor: 40, horizon: 0, trees: 0, buildings: false, raceDress: false }, sources);
  const plan = result.plan;
  const art = (() => {
    const pts: [number, number, number][] = [];
    const walk = (n: Kn5Node): void => {
      if (n.kind === "mesh") {
        if (n.name.startsWith("FURNITURE_SIGNART")) for (let i = 0; i < n.positions.length; i += 3) pts.push([n.positions[i], -n.positions[i + 2], n.positions[i + 1]]);
      } else n.children.forEach(walk);
    };
    walk(result.model.root);
    return pts;
  })();

  for (const [label, i] of [["start", () => plan.timed!.start], ["finish", () => plan.timed!.finish]] as const) {
    it(`puts a sign each side of the road at the ${label} line, clear of the road and above head height`, () => {
      const s = plan.samples[i()];
      const near = art.filter(([x, y]) => Math.hypot(x - s.pos[0], y - s.pos[1]) < 12);
      const sides = new Set(near.map(([x, y]) => Math.sign((x - s.pos[0]) * s.left[0] + (y - s.pos[1]) * s.left[1])));
      expect(sides).toEqual(new Set([1, -1]));
      for (const [x, y, z] of near) {
        expect(Math.abs((x - s.pos[0]) * s.left[0] + (y - s.pos[1]) * s.left[1])).toBeGreaterThan(s.width / 2 + 1);
        expect(z - s.h).toBeGreaterThan(1.9);
      }
    });
  }
});
