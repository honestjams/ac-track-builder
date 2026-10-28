import { describe, expect, it } from "vitest";
import { trafficGraph, trafficJson, type TrafficRoad } from "../src/core/traffic";
import type { Vec2 } from "../src/core/geo";

const line = (a: Vec2, b: Vec2, n = 20): Vec2[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
const road = (pts: Vec2[], width = 7, speed = 50): TrafficRoad => ({ pts, h: pts.map(() => 2), width, speed });
/** Local (x east, y north) from a lane point in AC coordinates. */
const local = (p: number[]): Vec2 => [p[0], -p[2]];

describe("traffic graph", () => {
  // An east-west main road, and a side street running north from its edge.
  const main = road(line([-100, 0], [100, 0]), 8, 60);
  const side = road(line([0, 4.5], [0, 80]), 6, 50);
  const g = trafficGraph([main, side], []);

  it("drives on the left, a lane each way", () => {
    const fwd = g.lanes.find((l) => l.name === "Road 1 forward")!;
    const back = g.lanes.find((l) => l.name === "Road 1 back")!;
    // Eastbound keeps left: north of the centreline (y > 0). Westbound south of it.
    expect(local(fwd.points[0])[0]).toBeLessThan(local(fwd.points.at(-1)!)[0]);
    for (const p of fwd.points) expect(local(p)[1]).toBeCloseTo(1.75, 3); // half a 3.5 m lane
    expect(local(back.points[0])[0]).toBeGreaterThan(local(back.points.at(-1)!)[0]);
    for (const p of back.points) expect(local(p)[1]).toBeCloseTo(-1.75, 3);
    expect(fwd.speedLimit).toBe(60);
  });

  it("puts an intersection where the side street meets the road, and turn-round spots at the dead ends", () => {
    const polys = g.intersections.map((i) => i.points.map(local));
    const contains = (poly: Vec2[], p: Vec2) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (poly[i][1] > p[1] !== poly[j][1] > p[1] && p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
      }
      return c;
    };
    const junction = polys.find((p) => contains(p, [0, 0]) && contains(p, [0, 6]));
    expect(junction).toBeDefined();
    // Every lane end lies inside some polygon (a junction or a turn-round).
    for (const l of g.lanes) for (const p of [l.points[0], l.points.at(-1)!]) expect(polys.some((poly) => contains(poly, local(p)))).toBe(true);
  });

  it("gives four-lane roads two lanes each way", () => {
    const wide = trafficGraph([road(line([0, 0], [200, 0]), 14, 60)], []);
    expect(wide.lanes).toHaveLength(4);
  });

  it("sends traffic clockwise round a roundabout, with priority on the ring", () => {
    const rb = { c: [0, 0] as Vec2, h: 2, rIn: 8, rOut: 15 };
    const r = trafficGraph([road(line([-120, 0], [120, 0], 60))], [rb]);
    const ring = r.lanes.find((l) => l.name.startsWith("Roundabout"))!;
    expect(ring.loop).toBe(true);
    const [a, b] = [local(ring.points[0]), local(ring.points[1])];
    // From east (angle 0) the next point is just south of it: clockwise.
    expect(a[0]).toBeGreaterThan(10);
    expect(b[1]).toBeLessThan(0);
    expect(ring.priority).toBeGreaterThan(Math.max(...r.lanes.filter((l) => l !== ring).map((l) => l.priority)));
    // The road through it is cut in two, each end meeting the ring at an arm.
    expect(r.lanes.filter((l) => !l.name.startsWith("Roundabout"))).toHaveLength(4);
    expect(r.intersections.filter((i) => i.name.includes("arm"))).toHaveLength(2);
  });

  it("keeps a circuit as one looped road", () => {
    const loop = Array.from({ length: 80 }, (_, i) => [Math.cos((i / 80) * Math.PI * 2) * 200, Math.sin((i / 80) * Math.PI * 2) * 200] as Vec2);
    const r = trafficGraph([{ ...road(loop), closed: true }], []);
    expect(r.lanes.every((l) => l.loop)).toBe(true);
    expect(r.intersections).toHaveLength(0);
  });

  it("writes JSON the planner reads: lanes, intersections, areas and rules", () => {
    const j = JSON.parse(trafficJson([main, side], []));
    expect(Object.keys(j).sort()).toEqual(["areas", "intersections", "lanes", "rules"]);
    expect(j.rules.laneRoles.length).toBeGreaterThan(0);
    const ids = j.lanes.map((l: { id: number }) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const l of j.lanes) {
      expect(l.points.length).toBeGreaterThanOrEqual(2);
      expect(l.params).toBeDefined();
      expect(l.role).toBeGreaterThanOrEqual(1);
    }
  });
});
