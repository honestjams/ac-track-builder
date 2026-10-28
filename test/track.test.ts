import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import { readKn5, type Kn5Node } from "../src/core/kn5";
import { clearOfRoute, KEEP_OFF, onRoute } from "../src/core/clearance";
import { SegmentIndex } from "../src/core/road";
import { readFastLaneAi } from "../src/core/aiSpline";
import { zipTrack } from "../src/core/zip";
import type { LngLat } from "../src/core/geo";

// A winding 2.5 km road with a hairpin, in the hills behind the Gold Coast.
function windingRoute(): LngLat[] {
  const out: LngLat[] = [];
  const lat0 = -27.92, lng0 = 153.19;
  const mPerDegLat = 111_320, mPerDegLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  // S-bends heading east, then a hairpin back west 60 m further north.
  for (let x = 0; x <= 1200; x += 20) out.push([lng0 + x / mPerDegLng, lat0 + (Math.sin(x / 90) * 25) / mPerDegLat]);
  for (let a = -90; a <= 90; a += 10) {
    const r = 30;
    const x = 1200 + Math.cos((a * Math.PI) / 180) * r, y = Math.sin(25 / 90 * 0) + 30 + Math.sin((a * Math.PI) / 180) * r;
    out.push([lng0 + x / mPerDegLng, lat0 + y / mPerDegLat]);
  }
  for (let x = 1200; x >= 200; x -= 20) out.push([lng0 + x / mPerDegLng, lat0 + 60 / mPerDegLat + (Math.cos(x / 120) * 10) / mPerDegLat]);
  return out;
}

const hills = (x: number, y: number) => 300 + Math.sin(x / 300) * 40 + Math.cos(y / 250) * 25 + y * 0.05;

const sources: DataSources = {
  dem: async (proj, bounds, z) => DemGrid.fromFunction(proj, z, bounds, hills).sample,
  widthAt: () => 6,
};

function allNodes(n: Kn5Node): Kn5Node[] {
  return n.kind === "mesh" ? [n] : [n, ...n.children.flatMap(allNodes)];
}

describe("buildTrack (synthetic terrain)", async () => {
  const result = await buildTrack(windingRoute(), { name: "Test Hairpin", imageryZoom: 0, corridor: 60 }, sources);

  it("gives the road a detail-mapped material with its textures bound to the right registers", () => {
    const kn5 = readKn5(result.files["test_hairpin/test_hairpin.kn5"]);
    const roads = kn5.materials.filter((m) => /^road_(asphalt|chipseal)_/.test(m.name));
    expect(roads.length).toBeGreaterThan(0);
    for (const m of roads) {
      expect(m.shader).toBe("ksPerPixelMultiMap");
      expect(m.registers).toEqual({ txDiffuse: 0, txNormal: 1, txMaps: 2, txDetail: 3 });
      expect(m.properties.find((p) => p.name === "useDetail")?.a).toBe(1);
      expect(m.properties.find((p) => p.name === "detailUVMultiplier")?.a).toBeGreaterThan(1);
    }
  });

  it("produces a complete track folder", () => {
    const names = Object.keys(result.files).sort();
    expect(names).toEqual([
      "test_hairpin/README.txt",
      "test_hairpin/ai/fast_lane.ai",
      "test_hairpin/data/cameras_1.ini",
      "test_hairpin/data/map.ini",
      "test_hairpin/data/surfaces.ini",
      "test_hairpin/extension/ext_config.ini",
      "test_hairpin/map.png",
      "test_hairpin/test_hairpin.kn5",
      "test_hairpin/ui/outline.png",
      "test_hairpin/ui/preview.png",
      "test_hairpin/ui/ui_track.json",
    ]);
    const ui = JSON.parse(new TextDecoder().decode(result.files["test_hairpin/ui/ui_track.json"]));
    expect(ui.name).toBe("Test Hairpin");
    expect(Number(ui.length)).toBeGreaterThan(2000);
    expect(ui.geotags[0]).toMatch(/ S$/);
  });

  it("writes a kn5 that parses back with physics meshes and spawn points", () => {
    const kn5 = readKn5(result.files["test_hairpin/test_hairpin.kn5"]);
    const nodes = allNodes(kn5.root);
    const meshes = nodes.filter((n) => n.kind === "mesh");
    const names = nodes.map((n) => n.name);
    for (const m of meshes) {
      // physical surfaces, or non-collidable horizon and scenery
      expect(m.name).toMatch(/^(1(ROAD|STREET|GRASS|WALL|KERB)_|BACKDROP_|TREES_|GUIDEPOSTS_|RAILPOSTS_|ROOF_|MARKINGS_|RRPM_|FURNITURE_)/);
      if (m.kind !== "mesh") continue;
      expect(m.positions.every(Number.isFinite)).toBe(true);
      expect(m.normals.every(Number.isFinite)).toBe(true);
    }
    expect(meshes.some((m) => m.name.startsWith("1ROAD_"))).toBe(true);
    expect(meshes.some((m) => m.name.startsWith("1GRASS_t"))).toBe(true);
    for (const required of ["AC_START_0", "AC_PIT_0", "AC_HOTLAP_START_0", "AC_AB_START_L", "AC_AB_START_R", "AC_AB_FINISH_L", "AC_AB_FINISH_R"]) {
      expect(names).toContain(required);
    }
    expect(names.filter((n) => n.startsWith("AC_PIT_"))).toHaveLength(8);
    expect(meshes.some((m) => m.name.startsWith("BACKDROP_"))).toBe(true);
  });

  it("times exactly the road between the pins, with a grid behind the start and room to stop after the finish", () => {
    const kn5 = readKn5(result.files["test_hairpin/test_hairpin.kn5"]);
    const nodes = allNodes(kn5.root);
    const at = (name: string) => {
      const n = nodes.find((m) => m.name === name)!;
      return n.kind === "node" ? n.transform : [];
    };
    const plan = result.plan;
    const pin = (i: number) => plan.samples[i].pos;
    const ac = (t: number[]): [number, number] => [t[12], -t[14]]; // AC x, -z = local east, north
    const mid = (a: number[], b: number[]) => [(ac(a)[0] + ac(b)[0]) / 2, (ac(a)[1] + ac(b)[1]) / 2];
    const near = (p: number[], q: number[], d: number) => expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeLessThan(d);
    expect(plan.timed).toBeDefined();
    // The start and finish gates sit on the route's first and last points (the pins).
    near(mid(at("AC_AB_START_L"), at("AC_AB_START_R")), pin(plan.timed!.start), 1);
    near(mid(at("AC_AB_FINISH_L"), at("AC_AB_FINISH_R")), pin(plan.timed!.finish), 1);
    const startS = plan.samples[plan.timed!.start].s, finishS = plan.samples[plan.timed!.finish].s;
    expect(startS).toBeGreaterThan(14 + 4 * 8);
    expect(plan.length - finishS).toBeGreaterThan(140);
    expect(result.stats.timedLength).toBeCloseTo(finishS - startS, 0);
    // Every spawn is behind the start line and faces up the road: the game takes -Z as forward.
    for (const name of ["AC_START_0", "AC_START_7", "AC_PIT_0", "AC_HOTLAP_START_0"]) {
      const t = at(name);
      const [x, y] = ac(t);
      const n = plan.samples.reduce((a, s, i) => (Math.hypot(s.pos[0] - x, s.pos[1] - y) < Math.hypot(plan.samples[a].pos[0] - x, plan.samples[a].pos[1] - y) ? i : a), 0);
      expect(plan.samples[n].s).toBeLessThan(startS);
      const tan = plan.samples[n].tan;
      const facing = [-t[8], t[10]]; // -Z in local east, north
      expect(facing[0] * tan[0] + facing[1] * tan[1]).toBeGreaterThan(0.95);
      // On the asphalt, not the verge.
      const p = plan.samples[n];
      const lateral = Math.abs((x - p.pos[0]) * p.left[0] + (y - p.pos[1]) * p.left[1]);
      expect(lateral).toBeLessThan(p.width / 2 - 0.5);
    }
    // Nothing that must stay off the road is on it.
    const onRoad = onRoute(plan, new SegmentIndex(plan));
    for (const m of nodes) {
      if (m.kind !== "mesh" || !KEEP_OFF.test(m.name)) continue;
      expect(clearOfRoute(m, onRoad).dropped).toBe(0);
    }
  });

  it("keeps the terrain below the asphalt", () => {
    const kn5 = readKn5(result.files["test_hairpin/test_hairpin.kn5"]);
    const meshes = allNodes(kn5.root).filter((n) => n.kind === "mesh");
    const road = meshes.filter((m) => m.name.startsWith("1ROAD_"));
    const terrain = meshes.filter((m) => m.name.startsWith("1GRASS_t"));
    // Map terrain vertices to a coarse XZ grid with their max height.
    const cell = 1.5;
    const top = new Map<string, number>();
    for (const t of terrain) {
      if (t.kind !== "mesh") continue;
      for (let i = 0; i < t.positions.length; i += 3) {
        const k = Math.round(t.positions[i] / cell) + "," + Math.round(t.positions[i + 2] / cell);
        top.set(k, Math.max(top.get(k) ?? -Infinity, t.positions[i + 1]));
      }
    }
    let checked = 0;
    for (const r of road) {
      if (r.kind !== "mesh") continue;
      for (let i = 0; i < r.positions.length; i += 3) {
        const k = Math.round(r.positions[i] / cell) + "," + Math.round(r.positions[i + 2] / cell);
        const t = top.get(k);
        if (t === undefined) continue;
        checked++;
        expect(t).toBeLessThan(r.positions[i + 1] - 0.1);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("writes an AI line that follows the road from start to finish", () => {
    const ai = readFastLaneAi(result.files["test_hairpin/ai/fast_lane.ai"]);
    expect(ai.length).toBe(result.plan.samples.length);
    // distances run along the 3D road, so slightly longer than the map length
    expect(ai[ai.length - 1].distance).toBeGreaterThan(result.plan.length * 0.99);
    expect(ai[ai.length - 1].distance).toBeLessThan(result.plan.length * 1.02);
    expect(ai.every((p) => p.speed >= 3 && p.speed <= 70)).toBe(true);
    // the hairpin forces a slow corner
    expect(Math.min(...ai.map((p) => p.speed))).toBeLessThan(25);
  });

  it("follows the DEM along the road", () => {
    const s = result.plan.samples[Math.floor(result.plan.samples.length / 3)];
    expect(Math.abs(s.h - hills(s.pos[0], s.pos[1]))).toBeLessThan(3);
    expect(result.stats.climb).toBeGreaterThan(10);
  });

  it("zips into a folder Content Manager can install", () => {
    const zip = zipTrack(result.files);
    const back = unzipSync(zip);
    expect(Object.keys(back)).toContain("test_hairpin/test_hairpin.kn5");
    expect(back["test_hairpin/test_hairpin.kn5"].length).toBe(result.stats.kn5Bytes);
  });
});

describe("start and finish on a long road drawn with jitter", async () => {
  // 4 km of gentle S-bends drawn with 1.5 m of zig-zag jitter, as routing
  // data often is: smoothing takes the jitter out and the road comes out
  // well over 40 m shorter than the path drawn (the old search window).
  const lat0 = -27.92, lng0 = 153.19;
  const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180), my = 111_320;
  const route: LngLat[] = [];
  for (let x = 0, k = 0; x <= 4000; x += 5, k++) route.push([lng0 + x / mx, lat0 + (Math.sin(x / 150) * 40 + (k % 2 ? 1.5 : -1.5)) / my]);
  const result = await buildTrack(route, { name: "Wiggles", imageryZoom: 0, corridor: 40, horizon: 0, trees: 0, buildings: false }, sources);

  it("puts the finish gate on pin B, not somewhere else", () => {
    const { plan } = result;
    const pinB = result.proj.toLocal(route[route.length - 1]);
    const finish = plan.samples[plan.timed!.finish].pos;
    expect(Math.hypot(finish[0] - pinB[0], finish[1] - pinB[1])).toBeLessThan(5);
    const pinA = result.proj.toLocal(route[0]);
    const start = plan.samples[plan.timed!.start].pos;
    expect(Math.hypot(start[0] - pinA[0], start[1] - pinA[1])).toBeLessThan(5);
  });
});

