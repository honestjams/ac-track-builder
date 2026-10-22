import { describe, expect, it } from "vitest";
import { buildingHeight, detectBuildings, ringArea } from "../src/core/buildings";
import { ROOF_COLOURS } from "../src/core/textures";

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
    expect(metal!.roof).toBe("gable");
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
