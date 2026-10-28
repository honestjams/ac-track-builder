import { describe, expect, it } from "vitest";
import { trimSpurs } from "../src/core/spurs";
import type { LngLat } from "../src/core/geo";

// Local metres (x east, y north) to lng/lat near Brisbane.
const O: LngLat = [153.0, -27.5];
const kx = Math.cos((O[1] * Math.PI) / 180) * 111320, ky = 110574;
const ll = ([x, y]: [number, number]): LngLat => [O[0] + x / kx, O[1] + y / ky];
const xy = ([lng, lat]: LngLat): [number, number] => [(lng - O[0]) * kx, (lat - O[1]) * ky];

/** A polyline through the given corners, a point every 5 m. */
function line(...corners: [number, number][]): LngLat[] {
  const out: LngLat[] = [ll(corners[0])];
  for (let i = 1; i < corners.length; i++) {
    const [a, b] = [corners[i - 1], corners[i]];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let k = 1; k <= n; k++) out.push(ll([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]));
  }
  return out;
}

const length = (c: LngLat[]) => c.slice(1).reduce((s, p, i) => s + Math.hypot(...([0, 1].map((k) => xy(p)[k] - xy(c[i])[k]) as [number, number])), 0);

describe("U-turn spurs", () => {
  // A divided road: northbound carriageway at x = 0, southbound at x = 10.
  it("cuts a start pin snapped to the far carriageway", () => {
    const route = line([10, 100], [10, 0], [0, 0], [0, 1000]);
    const t = trimSpurs(route, [ll([5, 0])]);
    expect(t.cut).toHaveLength(1);
    const pts = t.coords.map(xy);
    expect(Math.max(...pts.map((p) => p[0]))).toBeLessThan(1);
    expect(pts[0][1]).toBeGreaterThan(90);
    expect(pts[0][1]).toBeLessThan(130);
    expect(pts.at(-1)![1]).toBeCloseTo(1000, 0);
  });

  it("cuts an end pin snapped to the far carriageway", () => {
    const route = line([0, 0], [0, 600], [10, 600], [10, 500]);
    const t = trimSpurs(route, [ll([5, 600])]);
    const pts = t.coords.map(xy);
    expect(Math.max(...pts.map((p) => p[0]))).toBeLessThan(1);
    expect(pts.at(-1)![1]).toBeGreaterThan(470);
    expect(pts.at(-1)![1]).toBeLessThan(510);
  });

  it("cuts a detour to a middle pin on the far side, leaving one clean road", () => {
    const route = line([0, 0], [0, 400], [10, 400], [10, 200], [0, 200], [0, 1000]);
    const t = trimSpurs(route, [ll([5, 400]), ll([5, 200])]);
    expect(t.kept).toHaveLength(0);
    const pts = t.coords.map(xy);
    expect(Math.max(...pts.map((p) => p[0]))).toBeLessThan(1);
    for (let i = 1; i < pts.length; i++) expect(pts[i][1]).toBeGreaterThan(pts[i - 1][1]);
    expect(length(t.coords)).toBeGreaterThan(990);
    expect(length(t.coords)).toBeLessThan(1010);
  });

  it("leaves a long out-and-back alone rather than cut it short", () => {
    // Out on the near side, round, back on the far side and on south from there.
    const route = line([0, 0], [0, 300], [0, 600], [10, 600], [10, 300], [10, 0], [10, -500]);
    // The route really does go back, further than a spur: nothing to cut.
    expect(trimSpurs(route, [ll([5, 600])]).cut).toHaveLength(0);
  });

  it("leaves a mountain hairpin alone: the router reports no U-turn there", () => {
    const route = line([0, 0], [0, 300], [6, 312], [12, 300], [12, 0]);
    const t = trimSpurs(route, []);
    expect(t.coords).toBe(route);
    // And a U-turn reported somewhere else entirely is kept, not acted on.
    expect(trimSpurs(route, [ll([500, 500])]).kept).toHaveLength(1);
  });
});
