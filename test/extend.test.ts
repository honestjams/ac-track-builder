import { describe, expect, it } from "vitest";
import { carryOn, extendRoute, pathLength } from "../src/core/extend";
import type { Vec2 } from "../src/core/geo";

describe("run-up and run-off", () => {
  // The route runs east along y = 0 from x = 0 to 300. The street it's on
  // carries on east to x = 400, then bends north-east; west of the start
  // it runs on to x = -40 and stops.
  const street: Vec2[] = [[-40, 0], [0, 0], [300, 0], [400, 0], [480, 60]];
  const route: Vec2[] = [[0, 0], [100, 0], [200, 0], [300, 0]];

  it("follows the street the road ends on, round its bends", () => {
    const tail = carryOn(route, [street], 150);
    expect(pathLength([route[route.length - 1], ...tail])).toBeCloseTo(150, 0);
    const end = tail[tail.length - 1];
    expect(end[1]).toBeGreaterThan(20); // went round the bend, not straight on
    expect(end[0]).toBeGreaterThan(400);
  });

  it("carries on straight where the street runs out", () => {
    const head = carryOn(route.slice().reverse(), [street], 100);
    const end = head[head.length - 1];
    expect(end[0]).toBeCloseTo(-100, 0);
    expect(Math.abs(end[1])).toBeLessThan(0.5);
  });

  it("ignores streets heading off sideways", () => {
    const cross: Vec2[] = [[300, -50], [300, 50]];
    const tail = carryOn(route, [cross], 50);
    expect(tail[tail.length - 1][0]).toBeCloseTo(350, 0);
  });

  it("knows where the original start and finish are on the longer path", () => {
    const ext = extendRoute(route, [street], 100, 150);
    expect(ext.startAt).toBeCloseTo(100, 0);
    expect(ext.finishAt - ext.startAt).toBeCloseTo(300, 0);
    expect(pathLength(ext.path)).toBeCloseTo(550, 0);
  });
});
