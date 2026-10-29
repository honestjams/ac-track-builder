import { describe, expect, it } from "vitest";
import { buildingHeight, detectBuildings, plainHouse, ringArea } from "../src/core/buildings";
import { ROOF_COLOURS } from "../src/core/buildingStyles";

/** 200 m chunk at 512 px: grass, a pale metal roof, a terracotta roof and a grey road strip. */
function scene(): Uint8Array {
  const size = 512, px = new Uint8Array(size * size * 4);
  const mpp = 200 / size;
  const rect = (x0: number, y0: number, x1: number, y1: number, rgb: number[]) => {
    for (let y = Math.round(y0 / mpp); y < Math.round(y1 / mpp); y++) {
      for (let x = Math.round(x0 / mpp); x < Math.round(x1 / mpp); x++) px.set([...rgb, 255], (y * size + x) * 4);
    }
  };
  rect(0, 0, 200, 200, [96, 128, 70]); // grass
  rect(40, 40, 58, 52, [222, 220, 210]); // 18 x 12 m Surfmist roof
  rect(120, 130, 132, 140, [180, 86, 56]); // 12 x 10 m terracotta
  rect(0, 90, 200, 97, [205, 205, 200]); // 7 m wide pale road across the chunk
  return px;
}

describe("roof detection", () => {
  const found = detectBuildings(scene(), 512, { key: "t000", minX: 0, minY: 0, maxX: 200, maxY: 200 });

  it("finds both roofs and ignores the long thin road", () => {
    expect(found).toHaveLength(2);
  });

  it("sizes footprints to the roof and picks a matching colour", () => {
    const metal = found.find((b) => ROOF_COLOURS[b.roofColour].name === "surfmist");
    const tile = found.find((b) => ROOF_COLOURS[b.roofColour].tile);
    expect(metal).toBeDefined();
    expect(tile).toBeDefined();
    expect(Math.abs(ringArea(metal!.ring))).toBeGreaterThan(18 * 12 * 0.8);
    expect(Math.abs(ringArea(metal!.ring))).toBeLessThan(18 * 12 * 1.3);
    // image y runs south: the metal roof's centre sits 46 m below the top edge
    const cy = metal!.ring.reduce((a, p) => a + p[1], 0) / 4;
    expect(cy).toBeCloseTo(200 - 46, 0);
    expect(["gable", "hip"]).toContain(metal!.roof);
    expect(ringArea(metal!.ring)).toBeGreaterThan(0); // counter-clockwise
  });
});

describe("building heights", () => {
  it("prefers height, then levels, then the building type", () => {
    expect(buildingHeight({ building: "yes", height: "12.5 m" })).toBe(12.5);
    expect(buildingHeight({ building: "yes", render_height: "9" })).toBe(9);
    expect(buildingHeight({ building: "apartments", "building:levels": "4" })).toBe(13);
    expect(buildingHeight({ building: "house" })).toBe(3);
    expect(buildingHeight({ building: "shed" })).toBe(3.5);
  });
});

describe("house roofs", async () => {
  const { buildBuildings } = await import("../src/core/buildings");
  // A 12 x 8 m house at ground level 10, front wall along y = 0 (facing south).
  const ring: [number, number][] = [[0, 0], [12, 0], [12, 8], [0, 8]];
  const house = (roof: "hip" | "gable", garage = false) =>
    buildBuildings([{ ring, ...plainHouse(roof, 0, 2.8), source: "frontage", front: [[0, 0], [12, 0]], garage, setback: 8 }], () => 10);
  const verts = (nodes: ReturnType<typeof house>, re: RegExp) => nodes.filter((n) => re.test(n.name)).flatMap((n) =>
    Array.from({ length: n.positions.length / 3 }, (_, i) => [n.positions[i * 3], -n.positions[i * 3 + 2], n.positions[i * 3 + 1]]));

  it("overhangs the walls with eaves and rises to a ridge at the pitch", () => {
    for (const roof of ["hip", "gable"] as const) {
      const v = verts(house(roof), /^ROOF_/);
      expect(Math.min(...v.map((p) => p[0]))).toBeCloseTo(-0.45, 2);
      expect(Math.max(...v.map((p) => p[1]))).toBeCloseTo(8.45, 2);
      expect(Math.max(...v.map((p) => p[2]))).toBeCloseTo(12.8 + 4 * Math.tan((22 * Math.PI) / 180), 2);
    }
  });

  it("shortens the ridge on a hip roof, runs it to the eaves on a gable", () => {
    const top = (roof: "hip" | "gable") => {
      const v = verts(house(roof), /^ROOF_/);
      const zMax = Math.max(...v.map((p) => p[2]));
      const ridge = v.filter((p) => p[2] > zMax - 1e-3).map((p) => p[0]);
      return Math.max(...ridge) - Math.min(...ridge);
    };
    expect(top("hip")).toBeCloseTo(12 - 8, 2);
    expect(top("gable")).toBeCloseTo(12 + 0.9, 2);
  });

  it("puts soffits under the eaves, facing down, and a garage door on the street side", () => {
    const nodes = house("hip", true);
    const soffit = nodes.find((n) => n.name.startsWith("SOFFIT_"))!;
    for (let i = 1; i < soffit.normals.length; i += 3) expect(soffit.normals[i]).toBeLessThan(0);
    const door = verts(nodes, /^GARAGE_/);
    expect(door.length).toBeGreaterThan(0);
    for (const p of door) expect(p[1]).toBeLessThan(0); // just proud of the front (south) wall
    expect(Math.max(...door.map((p) => p[2])) - 10).toBeCloseTo(2.1, 2);
    // A driveway from the garage out to the nature strip (8 m setback, strip from 3.5 m), facing up.
    const drive = nodes.find((n) => n.name.startsWith("DRIVEWAY_"))!;
    const dv = verts([drive], /./);
    expect(Math.min(...dv.map((p) => p[1]))).toBeCloseTo(-4.5, 1);
    for (let i = 1; i < drive.normals.length; i += 3) expect(drive.normals[i]).toBeGreaterThan(0.9);
    // And a front door.
    expect(verts(nodes, /^DOOR_/).length).toBe(4);
  });

  it("puts glass panes over the painted windows, clear of the garage and front door", () => {
    const nodes = house("hip", true);
    const panes = nodes.filter((n) => n.name.startsWith("WINDOWS_"));
    expect(panes.length).toBeGreaterThan(0);
    const v = verts(panes, /./);
    for (const [x, y, z] of v) {
      expect(z).toBeGreaterThan(10.9); // sills above 0.9 m
      expect(z).toBeLessThan(12.8); // under the eaves
      // On the front (south) wall, never over the garage (0.4-3.4 m from its start).
      if (y < 0) expect(x < 0.4 || x > 3.4).toBe(true);
    }
    // Every pane is just proud of a wall: within 2 cm outside the footprint.
    for (const [x, y] of v) {
      const outside = Math.max(-x, x - 12, -y, y - 8);
      expect(outside).toBeGreaterThan(0.005);
      expect(outside).toBeLessThan(0.02);
    }
  });
});
