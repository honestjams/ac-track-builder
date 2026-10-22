import { describe, expect, it } from "vitest";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import { readKn5, type Kn5MeshNode, type Kn5Node } from "../src/core/kn5";
import { buildingHeight, treeSpotsFromImagery } from "../src/core/scenery";
import type { LngLat } from "../src/core/geo";

const lat0 = -27.92, lng0 = 153.19;
const mLat = 111_320, mLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
const at = (x: number, y: number): LngLat => [lng0 + x / mLng, lat0 + y / mLat];

/** Aerial-like texture: left half dark, mottled canopy; right half smooth pale grass. */
function fakeAerial(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (x < size / 2) {
        const k = 0.5 + rand();
        px.set([22 * k, 62 * k, 20 * k, 255], i);
      } else {
        px.set([150, 175, 110, 255], i);
      }
    }
  }
  return px;
}

describe("tree detection", () => {
  it("finds canopy in dark mottled green and not in smooth pale grass", () => {
    const size = 256;
    const spots = treeSpotsFromImagery(fakeAerial(size), size, { key: "t000", minX: 0, minY: 0, maxX: 200, maxY: 200 }, 1);
    expect(spots.length).toBeGreaterThan(100);
    expect(spots.every((s) => s.x < 105)).toBe(true);
  });

  it("returns nothing when trees are off", () => {
    expect(treeSpotsFromImagery(fakeAerial(64), 64, { key: "t", minX: 0, minY: 0, maxX: 200, maxY: 200 }, 0)).toEqual([]);
  });
});

describe("building heights", () => {
  it("prefers height, then levels, then the building type", () => {
    expect(buildingHeight({ building: "yes", height: "12.5 m" })).toBe(12.5);
    expect(buildingHeight({ building: "apartments", "building:levels": "4" })).toBe(13);
    expect(buildingHeight({ building: "house" })).toBe(6);
    expect(buildingHeight({ building: "shed" })).toBe(3.5);
  });
});

function meshes(n: Kn5Node): Kn5MeshNode[] {
  return n.kind === "mesh" ? [n] : n.children.flatMap(meshes);
}

describe("buildTrack with scenery", async () => {
  // A straight 1 km road running east along a hillside: ground drops away
  // steeply to the south (right of travel), rises gently to the north.
  const route = Array.from({ length: 51 }, (_, i) => at(i * 20 - 500, 0));
  const slope = (_x: number, y: number) => 200 + (y < 0 ? y * 0.9 : y * 0.1);
  const house: LngLat[] = [at(0, 30), at(12, 30), at(12, 40), at(0, 40)];
  const tooClose: LngLat[] = [at(100, 2), at(110, 2), at(110, 8), at(100, 8)];
  const sources: DataSources = {
    dem: async (proj, bounds, z) => DemGrid.fromFunction(proj, z, bounds, slope).sample,
    imagery: async (_proj, _chunk, _z, size) => ({ data: new Uint8Array([1]), ext: "png", rgba: fakeAerial(size) }),
    osm: {
      buildings: [{ ring: house, tags: { building: "house" } }, { ring: tooClose, tags: { building: "house" } }],
      guardRails: [],
    },
  };
  const result = await buildTrack(route, { name: "Scenery", corridor: 60, horizon: 0, textureSize: 128 }, sources);
  const kn5 = readKn5(result.files["scenery/scenery.kn5"]);
  const all = meshes(kn5.root);

  it("places trees on the canopy side only, clear of the road", () => {
    const trees = all.filter((m) => m.name.startsWith("TREES_"));
    expect(trees.length).toBeGreaterThan(0);
    expect(result.stats.trees).toBeGreaterThan(20);
    const mat = kn5.materials.find((m) => m.name === "trees")!;
    expect(mat.shader).toBe("ksPerPixelAT");
    expect(mat.alphaTested).toBe(true);
    for (const t of trees) {
      // each tree is 24 vertices; its trunk sits at their average
      for (let v = 0; v < t.positions.length / 3; v += 24) {
        let x = 0, z = 0;
        for (let k = 0; k < 24; k++) {
          x += t.positions[(v + k) * 3] / 24;
          z += t.positions[(v + k) * 3 + 2] / 24;
        }
        // Beside the road (not past its ends), trunks clear the 6.5 m road,
        // 1.5 m verge and a 1.5 m margin. AC z = -north.
        if (Math.abs(x) < 490) expect(Math.abs(z)).toBeGreaterThan(6.2);
      }
    }
  });

  it("puts a collidable guard rail on the drop-off side only", () => {
    const rails = all.filter((m) => m.name.startsWith("1WALL_RAIL_"));
    expect(rails.length).toBeGreaterThan(0);
    expect(rails.every((r) => r.name.startsWith("1WALL_RAIL_R_"))).toBe(true);
    // the rail's front face points back toward the road (north, AC -z)
    const r = rails[0];
    expect(r.normals[2]).toBeLessThan(-0.9);
    expect(result.stats.railMetres).toBeGreaterThan(800);
  });

  it("adds guide posts where there is no rail", () => {
    expect(all.some((m) => m.name.startsWith("GUIDEPOSTS_"))).toBe(true);
  });

  it("extrudes OSM buildings and drops ones on the road", () => {
    expect(result.stats.buildings).toBe(1);
    const walls = all.filter((m) => m.name.startsWith("1WALL_BLD_"));
    const roofs = all.filter((m) => m.name.startsWith("ROOFS_"));
    expect(walls).toHaveLength(1);
    expect(roofs).toHaveLength(1);
    // roof faces up, 6 m house above sloping ground
    expect(roofs[0].normals[1]).toBeCloseTo(1);
    const roofY = roofs[0].positions[1];
    expect(roofY).toBeGreaterThan(slope(0, 40) + 5);
    // walls face outward: the wall nearest the road (y = 30) faces south (AC +z)
    let found = false;
    for (let i = 0; i < walls[0].positions.length; i += 3) {
      if (Math.abs(-walls[0].positions[i + 2] - 30) < 0.01 && walls[0].normals[i + 2] > 0.9) found = true;
    }
    expect(found).toBe(true);
  });
});
