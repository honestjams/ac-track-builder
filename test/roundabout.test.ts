import { describe, expect, it } from "vitest";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import { LocalProjection, type LngLat, type Vec2 } from "../src/core/geo";
import { readKn5, type Kn5MeshNode, type Kn5Node } from "../src/core/kn5";
import { buildRingMarkings, buildRingMeshes, fitCircle, resolveRoundabouts, ringHeight } from "../src/core/roundabout";
import { withDefaults } from "../src/core/options";

const proj = new LocalProjection([153.4, -28.0]);
const ll = (p: Vec2): LngLat => proj.toLngLat(p);

/** Straight through a 15 m roundabout centred at (300, 0), clockwise over its north side. */
function throughRoundabout() {
  const route: Vec2[] = [];
  for (let x = 0; x <= 285; x += 15) route.push([x, 0]);
  const arc: Vec2[] = [];
  for (let a = 180; a >= 0; a -= 15) arc.push([300 + Math.cos((a * Math.PI) / 180) * 15, Math.sin((a * Math.PI) / 180) * 15]);
  route.push(...arc.slice(1));
  for (let x = 330; x <= 600; x += 15) route.push([x, 0]);
  return { route: route.map(ll), hint: { location: ll(arc[0]), arc: arc.map(ll) } };
}

describe("circle fitting", () => {
  it("recovers a circle from an arc", () => {
    const pts: Vec2[] = [];
    for (let a = 0; a < 120; a += 10) pts.push([5 + Math.cos((a * Math.PI) / 180) * 20, -3 + Math.sin((a * Math.PI) / 180) * 20]);
    const c = fitCircle(pts)!;
    expect(c.c[0]).toBeCloseTo(5, 3);
    expect(c.c[1]).toBeCloseTo(-3, 3);
    expect(c.r).toBeCloseTo(20, 3);
  });

  it("prefers the OSM ring, then the driven arc, then a 12 m guess to the right", () => {
    const ring: LngLat[] = [];
    for (let a = 0; a < 360; a += 30) ring.push(ll([300 + Math.cos((a * Math.PI) / 180) * 18, Math.sin((a * Math.PI) / 180) * 18]));
    const { hint } = throughRoundabout();
    expect(resolveRoundabouts([hint], [{ pts: ring }], proj)[0].r).toBeCloseTo(18, 1);
    expect(resolveRoundabouts([hint], [{ pts: ring, lanes: 2 }], proj)[0].lanes).toBe(2);
    expect(resolveRoundabouts([hint], [], proj)[0].r).toBeCloseTo(15, 1);
    // two points heading east: clockwise traffic has the centre to the south
    const guess = resolveRoundabouts([{ location: ll([0, 0]), arc: [ll([0, 0]), ll([3, 0])] }], [], proj)[0];
    expect(guess.r).toBe(12);
    expect(guess.c[1]).toBeCloseTo(-12, 1);
  });
});

function meshes(n: Kn5Node): Kn5MeshNode[] {
  return n.kind === "mesh" ? [n] : n.children.flatMap(meshes);
}

describe("buildTrack through a roundabout", async () => {
  const { route, hint } = throughRoundabout();
  const sources: DataSources = {
    dem: async (p, bounds, z) => DemGrid.fromFunction(p, z, bounds, (x) => 50 + x * 0.02).sample,
    roundabouts: [hint],
  };
  const result = await buildTrack(route, { name: "RB", corridor: 50, horizon: 0, imageryZoom: 0 }, sources);
  const plan = result.plan;
  const kn5 = readKn5(result.files["rb/rb.kn5"]);
  const all = meshes(kn5.root);
  // the route's local frame is centred on the route, not on `proj`; find the ring there
  const rb = plan.roundabouts[0];

  it("keeps the route on a 15 m circle instead of a hairpin", () => {
    expect(plan.roundabouts).toHaveLength(1);
    expect(rb.r).toBeCloseTo(15, 0);
    const onRing = plan.samples.filter((s) => s.s > rb.sIn && s.s < rb.sOut);
    expect(onRing.length).toBeGreaterThan(15);
    for (const s of onRing) {
      expect(Math.abs(Math.hypot(s.pos[0] - rb.c[0], s.pos[1] - rb.c[1]) - 15)).toBeLessThan(0.3);
      expect(Math.abs(s.curvature)).toBeLessThan(1 / 10);
    }
  });

  it("builds the full ring, island, outer verge and a wall with openings", () => {
    const names = all.map((m) => m.name);
    for (const n of ["1ROAD_RB0", "1GRASS_RBISLAND0", "1GRASS_RBVERGE0", "1WALL_RB0"]) expect(names).toContain(n);
    const ring = all.find((m) => m.name === "1ROAD_RB0")!;
    // all round: vertices on the far (south) side too; AC z = -north
    expect(Array.from(ring.positions).some((v, i) => i % 3 === 2 && -v < rb.c[1] - 10)).toBe(true);
    // the surface faces up and is level within the 2% fall
    for (let i = 0; i < ring.normals.length; i += 3) expect(ring.normals[i + 1]).toBeGreaterThan(0.99);
    expect(names.filter((n) => n.startsWith("1ROAD_RBC0_"))).toHaveLength(2);
  });

  it("kerbs the ring in town, sloping the kerb away at each road joining", () => {
    const m = buildRingMeshes({ ...rb, kerbed: true }, 0, withDefaults({}), "road");
    expect(m.kerb.map((n) => n.name)).toEqual(["1ROAD_RBGUTTER0", "1KERB_RB0"]);
    const kerb = m.kerb[1];
    const top = Math.max(...Array.from({ length: kerb.positions.length / 3 }, (_, i) => kerb.positions[i * 3 + 1]));
    const Ro = rb.r + rb.w / 2, edge = ringHeight(rb, Ro);
    expect(top - edge).toBeCloseTo(0.15, 3);
    // Low where the route crosses the edge.
    for (const a of rb.crossings) {
      const x = rb.c[0] + Math.cos(a) * (Ro + 0.4), y = rb.c[1] + Math.sin(a) * (Ro + 0.4);
      for (let i = 0; i < kerb.positions.length; i += 3) {
        if (Math.hypot(kerb.positions[i] - x, -kerb.positions[i + 2] - y) < 1) expect(kerb.positions[i + 1] - edge).toBeLessThan(0.02);
      }
    }
  });

  it("keeps the ring's kerb out of the whole width of a wide, angled entry", () => {
    const a = rb.crossings[0];
    // An entry spanning 50 degrees of the ring, much wider than the ring itself.
    const span = (50 * Math.PI) / 180;
    const m = buildRingMeshes({ ...rb, kerbed: true, openings: [[a - span / 2, a + span / 2]] }, 0, withDefaults({}), "road");
    const kerb = m.kerb.find((n) => n.name.startsWith("1KERB_"))!;
    for (let i = 0; i < kerb.positions.length; i += 3) {
      const ang = Math.atan2(-kerb.positions[i + 2] - rb.c[1], kerb.positions[i] - rb.c[0]);
      let d = Math.abs(ang - a) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < span / 2 - 0.01) expect(kerb.positions[i + 1] - ringHeight(rb, rb.r + rb.w / 2)).toBeLessThan(0.02);
    }
  });

  it("stops the straight road ribbon at the ring", () => {
    const ribbon = all.filter((m) => /^1ROAD_\d/.test(m.name));
    for (const m of ribbon) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const [cx, cz] = [0, 2].map((k) => (m.positions[m.indices[t] * 3 + k] + m.positions[m.indices[t + 1] * 3 + k] + m.positions[m.indices[t + 2] * 3 + k]) / 3);
        expect(Math.hypot(cx - rb.c[0], -cz - rb.c[1])).toBeGreaterThan(rb.r + rb.w / 2 - 1);
      }
    }
  });
  it("paints a give-way line across the entering half of each road joining, and no lane line on one lane", () => {
    expect(rb.lanes).toBe(1);
    const paint = all.find((m) => m.name === "MARKINGS_RB0");
    expect(paint).toBeDefined();
    // One opening on the east side, centred on angle 0: traffic comes in heading west and keeps left, the south half.
    const m = buildRingMarkings({ ...rb, openings: [[-0.6, 0.6]] }, 0)!;
    const Ro = rb.r + rb.w / 2;
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i] - rb.c[0], y = -m.positions[i + 2] - rb.c[1];
      expect(y).toBeLessThan(0.01);
      expect(Math.hypot(x, y)).toBeGreaterThan(Ro - 0.45);
      expect(m.positions[i + 1] - ringHeight(rb, Math.hypot(x, y))).toBeCloseTo(0.015, 3);
      expect(m.normals[i + 1]).toBeGreaterThan(0.99); // faces up
    }
    // Dashes: 0.6 m on, 0.6 m off, from 2.5 m in (the opening's pad) to the middle of the road.
    const dashes = m.indices.length / 6;
    expect(dashes).toBeGreaterThan(Math.floor(((0.6 * Ro) - 2.5) / 1.2) - 1);
  });

  it("puts a broken lane line round a two-lane ring", () => {
    const wide = { ...rb, w: 9.2, lanes: 2, openings: [] as [number, number][], crossings: [] };
    const m = buildRingMarkings(wide, 0)!;
    const mid = rb.r; // between the lanes of a ring centred on its circulating radius
    let near = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const d = Math.hypot(m.positions[i] - rb.c[0], -m.positions[i + 2] - rb.c[1]);
      expect(Math.abs(d - mid)).toBeLessThan(0.06);
      near++;
    }
    expect(near).toBeGreaterThan(0);
    // About a third of the way round is paint (3 m on, 6 m off).
    let painted = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => m.indices[t + k] * 3);
      const ux = m.positions[b] - m.positions[a], uz = m.positions[b + 2] - m.positions[a + 2];
      const vx = m.positions[c] - m.positions[a], vz = m.positions[c + 2] - m.positions[a + 2];
      painted += Math.abs(ux * vz - uz * vx) / 2;
    }
    expect(painted / (2 * Math.PI * mid * 0.1)).toBeGreaterThan(0.28);
    expect(painted / (2 * Math.PI * mid * 0.1)).toBeLessThan(0.36);
  });
});
