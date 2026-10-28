import { describe, expect, it } from "vitest";
import { extConfig } from "../src/core/cspConfig";

describe("CSP night lighting", () => {
  it("lists each street light in AC space, on a night condition, and makes the lanterns glow", () => {
    const ini = extConfig([[10, 20, 8.2], [-5, 3, 9]]);
    expect(ini).toContain("NAME = NIGHT_SMOOTH");
    expect(ini).toContain("[LIGHT_SERIES_0]");
    expect(ini).toContain("CONDITION = NIGHT_SMOOTH");
    expect(ini).toContain("POSITION_0 = 10.00, 8.20, -20.00"); // x, up, south
    expect(ini).toContain("POSITION_1 = -5.00, 9.00, -3.00");
    expect(ini).toMatch(/MATERIALS = lamp\r\nCONDITION = NIGHT_SMOOTH\r\nKEY_0 = ksEmissive/);
    // Grass FX on the photo's grass, never through the road.
    expect(ini).toMatch(/\[GRASS_FX\]\r\nGRASS_MATERIALS = terrain_\?, strip_photo_\?/);
    expect(ini).toContain("OCCLUDING_MATERIALS = road_?, concrete");
    // Every section header is unique.
    const heads = ini.match(/^\[[^\]]+\]/gm)!;
    expect(new Set(heads).size).toBe(heads.length);
  });

  it("leaves out the light series when there are no lights", () => {
    expect(extConfig([])).not.toContain("LIGHT_SERIES");
  });
});
