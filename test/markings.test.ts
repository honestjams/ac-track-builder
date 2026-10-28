import { describe, expect, it } from "vitest";
import { planRoad, type RoadPlan } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { arrowGlyph, buildMarkings, planCentreLine, symbolGlyph, textGlyph } from "../src/core/markings";
import type { Vec2 } from "../src/core/geo";

function road(path: Vec2[], height: (s: number) => number = () => 100): RoadPlan {
  const plan = planRoad(path, withDefaults({ widthOverride: 7 }));
  plan.samples.forEach((s) => (s.h = height(s.s)));
  return plan;
}

const straight = (len: number): Vec2[] => Array.from({ length: 51 }, (_, i) => [(i / 50) * len, 0]);

describe("dividing line", () => {
  it("is broken along a flat straight", () => {
    const c = planCentreLine(road(straight(1500)));
    expect(c.barrierFwd.every((b) => !b)).toBe(true);
    expect(c.barrierBack.every((b) => !b)).toBe(true);
  });

  it("stops overtaking towards a blind crest from both sides", () => {
    // 8 m high hump in the middle of a 1.5 km straight
    const plan = road(straight(1500), (s) => 100 + 8 * Math.exp(-(((s - 750) / 120) ** 2)));
    const c = planCentreLine(plan);
    const before = plan.samples.findIndex((s) => s.s > 650), after = plan.samples.findIndex((s) => s.s > 850);
    expect(c.barrierFwd[before]).toBe(true);
    expect(c.barrierBack[after]).toBe(true);
    // far from the crest overtaking is allowed again
    expect(c.barrierFwd[10] || c.barrierBack[10]).toBe(false);
  });

  it("restricts only the traffic approaching a blind corner on the inside", () => {
    // a 90 degree bend of radius 60 m between two long straights
    const pts: Vec2[] = [];
    for (let x = -800; x <= 0; x += 20) pts.push([x, 0]);
    for (let a = 1; a <= 9; a++) {
      const t = (a / 10) * (Math.PI / 2);
      pts.push([Math.sin(t) * 60, 60 - Math.cos(t) * 60]);
    }
    for (let y = 60; y <= 860; y += 20) pts.push([60, y]);
    const plan = road(pts);
    const c = planCentreLine(plan);
    const i = plan.samples.findIndex((s) => s.s > 820);
    expect(c.barrierFwd[i] || c.barrierBack[i]).toBe(true);
  });
});

describe("marking meshes", () => {
  it("sit just above the road and face up", () => {
    const plan = road(straight(600));
    const [paint] = buildMarkings(plan, withDefaults({}));
    expect(paint.name).toMatch(/^MARKINGS_/);
    for (let i = 0; i < paint.positions.length; i += 3) {
      // AC y = up; the flat road is at 100 m minus crown
      expect(paint.positions[i + 1]).toBeGreaterThan(99.9);
      expect(paint.positions[i + 1]).toBeLessThan(100.03);
      expect(paint.normals[i + 1]).toBeCloseTo(1);
    }
  });

  it("leaves narrow roads unmarked", () => {
    const plan = planRoad(straight(600), withDefaults({ widthOverride: 4 }));
    expect(buildMarkings(plan, withDefaults({}))).toHaveLength(0);
  });
});

describe("arrows and painted numbers", () => {
  // A 14 m road along +x: two 3.5 m lanes each way.
  const plan = planRoad(straight(600), withDefaults({ widthOverride: 14 }));
  plan.samples.forEach((s) => (s.h = 100));
  const verts = (marks: Parameters<typeof buildMarkings>[5]) => {
    const all = buildMarkings(plan, withDefaults({}), () => false, () => true, { lines: [], covered: () => true }, marks);
    const pts: [number, number][] = [];
    for (const m of all) for (let i = 0; i < m.positions.length; i += 3) pts.push([m.positions[i], -m.positions[i + 2]]);
    return { all, pts };
  };

  it("draws a left arrow in the middle of its lane, head forward and to the left", () => {
    const { pts } = verts([{ s: 300, t: 2.1, kind: "arrow", shape: "left" }]);
    const xs = pts.map((p) => p[0]);
    expect(Math.min(...xs)).toBeGreaterThan(296);
    expect(Math.max(...xs)).toBeLessThan(304);
    // Tail on the inner lane's centre (1.75 m left of the centreline), branch reaching left.
    const tail = pts.filter((p) => p[0] < 297);
    for (const p of tail) expect(Math.abs(p[1] - 1.75)).toBeLessThan(0.25);
    const tip = pts.reduce((a, p) => (p[0] > a[0] ? p : a));
    expect(tip[1]).toBeGreaterThan(1.75 + 0.5);
  });

  it("turns marks round for traffic on the other side", () => {
    const { pts } = verts([{ s: 300, t: -1.5, kind: "arrow", shape: "straight" }]);
    // Lane centre 1.75 m right; the head (widest part) is at the low-x end.
    for (const p of pts) expect(Math.abs(p[1] + 1.75)).toBeLessThan(0.45);
    const wide = pts.filter((p) => Math.abs(p[1] + 1.75) > 0.25);
    expect(Math.max(...wide.map((p) => p[0]))).toBeLessThan(300);
  });

  it("faces up and skips shapes it doesn't know", () => {
    const { all } = verts([{ s: 300, t: 2, kind: "text", shape: "40" }, { s: 200, t: 2, kind: "arrow", shape: "u-turn" }]);
    expect(all).toHaveLength(1);
    for (let i = 0; i < all[0].normals.length; i += 3) expect(all[0].normals[i + 1]).toBeCloseTo(1);
    expect(arrowGlyph("u-turn")).toBeNull();
    // A bicycle: two wheels and a frame, fitting a lane, standing up it.
    const bike = symbolGlyph("bicycle")!;
    const pts = bike.lines.flat();
    expect(Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))).toBeLessThan(1.5);
    expect(Math.max(...pts.map((p) => p[0]))).toBeCloseTo(bike.length, 1);
    expect(symbolGlyph("wheelchair")).toBeNull();
    expect(textGlyph("crosswalk-ahead-now")).toBeNull(); // three words
    expect(textGlyph("ampersand&")).toBeNull(); // too long, and an unknown character
    expect(textGlyph("40")!.lines.length).toBe(3); // "4" is two strokes, "0" one
    // Words fit a lane; two words stack along the road, the first nearest the driver.
    const school = textGlyph("school")!;
    const across = school.lines.flat().map((p) => p[1]);
    expect(Math.max(...across) - Math.min(...across)).toBeLessThanOrEqual(2.81);
    const kc = textGlyph("keep-clear")!;
    expect(kc.length).toBeCloseTo(7.5, 5);
    const along = kc.lines.flat().map((p) => p[0]);
    expect(Math.max(...along)).toBeCloseTo(7.5, 5);
  });
});
