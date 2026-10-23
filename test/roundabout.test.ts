import { describe, expect, it } from "vitest";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import { LocalProjection, type LngLat, type Vec2 } from "../src/core/geo";
import { readKn5, type Kn5MeshNode, type Kn5Node } from "../src/core/kn5";
import { buildRingMeshes, fitCircle, resolveRoundabouts, ringHeight } from "../src/core/roundabout";
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
    expect(resolveRoundabouts([hint], [ring], proj)[0].r).toBeCloseTo(18, 1);
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

  it("stops the straight road ribbon at the ring", () => {
    const ribbon = all.filter((m) => /^1ROAD_\d/.test(m.name));
    for (const m of ribbon) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const [cx, cz] = [0, 2].map((k) => (m.positions[m.indices[t] * 3 + k] + m.positions[m.indices[t + 1] * 3 + k] + m.positions[m.indices[t + 2] * 3 + k]) / 3);
        expect(Math.hypot(cx - rb.c[0], -cz - rb.c[1])).toBeGreaterThan(rb.r + rb.w / 2 - 1);
      }
    }
  });
});
