import { describe, expect, it } from "vitest";
import { planRoad } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { findLines, paintCandidates } from "../src/core/paintLines";
import type { RasterSampler } from "../src/core/trace";
import type { Vec2 } from "../src/core/geo";

/** 7.5 m road along y = 0: solid edge lines at +-3.3 m, a 3-on-9-off centre line starting at x = 4. */
const photo: RasterSampler = (x, y) => {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 0.015;
  if (Math.abs(y) > 3.75) return [0.3 + n, 0.42 + n, 0.2 + n];
  const paint = (Math.abs(Math.abs(y) - 3.3) < 0.06) || (Math.abs(y) < 0.06 && (((x - 4) % 12) + 12) % 12 < 3);
  return paint ? [0.8, 0.8, 0.78] : [0.36 + n, 0.36 + n, 0.38 + n];
};

describe("line markings from the photo", () => {
  const path: Vec2[] = Array.from({ length: 21 }, (_, i) => [i * 20, 0]);
  const plan = planRoad(path, withDefaults({ widthOverride: 7.5 }));
  const lines = findLines(plan, paintCandidates(plan, photo, () => true), () => true);

  it("finds both edge lines as solid and the centre line as dashed", () => {
    const byPos = lines.map((l) => ({ t: l.t[Math.floor(l.t.length / 2)], kind: l.kind })).sort((a, b) => a.t - b.t);
    expect(byPos).toHaveLength(3);
    expect(byPos[0].t).toBeCloseTo(-3.3, 0);
    expect(byPos[0].kind).toBe("solid");
    expect(byPos[1].t).toBeCloseTo(0, 0);
    expect(byPos[1].kind).toBe("dash");
    expect(byPos[2].t).toBeCloseTo(3.3, 0);
  });

  it("matches the dash phase of the real line", () => {
    const centre = lines.find((l) => l.kind === "dash")!;
    expect(Math.abs(centre.phase - 4)).toBeLessThan(0.6);
  });

  it("finds nothing where nothing can be trusted", () => {
    expect(findLines(plan, paintCandidates(plan, photo, () => false), () => false)).toHaveLength(0);
  });
});
