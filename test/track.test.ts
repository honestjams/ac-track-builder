import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import { readKn5, type Kn5Node } from "../src/core/kn5";
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

  it("produces a complete track folder", () => {
    const names = Object.keys(result.files).sort();
    expect(names).toEqual([
      "test_hairpin/README.txt",
      "test_hairpin/ai/fast_lane.ai",
      "test_hairpin/data/map.ini",
      "test_hairpin/data/surfaces.ini",
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
      expect(m.name).toMatch(/^1(ROAD|GRASS|WALL)_/);
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
