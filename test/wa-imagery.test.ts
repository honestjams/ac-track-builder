import { describe, expect, it } from "vitest";
import { imageryChain, tileBbox, tileUrl } from "../src/services/tiles";

describe("Landgate WA imagery", () => {
  it("comes first in WA, before Esri", () => {
    expect(imageryChain([115.86, -31.95])).toEqual(["wa", "esri"]); // Perth
    expect(imageryChain([151.2, -33.87])).toEqual(["nsw", "esri"]);
    expect(imageryChain([174.8, -41.2])).toEqual(["esri"]);
  });

  it("asks the ImageServer for a tile by its Web Mercator box", () => {
    expect(tileBbox(0, 0, 0)).toBe("-20037508.343,-20037508.343,20037508.343,20037508.343");
    const url = tileUrl("wa", 18, 215043, 158446);
    expect(url).toContain("/Locate/ImageServer/exportImage?bbox=");
    expect(url).not.toContain("{bbox}");
    const [x0, y0, x1, y1] = new URL(url).searchParams.get("bbox")!.split(",").map(Number);
    expect(x1 - x0).toBeCloseTo(152.874, 2);
    expect(y1 - y0).toBeCloseTo(152.874, 2);
  });
});
