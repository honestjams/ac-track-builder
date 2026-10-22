import { describe, expect, it } from "vitest";
import { planRoad, type RoadPlan } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { buildMarkings, planCentreLine } from "../src/core/markings";
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
