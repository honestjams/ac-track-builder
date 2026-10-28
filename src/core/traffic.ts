// Traffic for Custom Shaders Patch: data/traffic.json, the traffic graph read
// by CSP's traffic planner (acc-lua-internal/included-tools/traffic, by
// x4fab, CC0). It has lanes (point lists in the direction of travel, AC world
// coordinates), intersections (flat polygons: every lane entering one can
// turn into every lane leaving it, with priority deciding who gives way),
// areas, and lane roles with speed limits.
//
// Built from the roads the track actually has, the route and its side
// streets, so traffic never drives off the asphalt:
//
//  - Each road gets a lane each way on the left (Australia drives on the
//    left), two each way on roads 12 m or wider.
//  - Every junction gets an intersection polygon: side streets meeting the
//    route or each other, and roads crossing.
//  - A roundabout is a clockwise ring lane with an intersection where each
//    road meets it; traffic on the ring has priority.
//  - Where a side street stops (the edge of the built area) a small polygon
//    lets cars turn round instead of driving off the end.

import type { Vec2 } from "./geo";

export interface TrafficRoad {
  /** Centreline, local metres (x east, y north). */
  pts: Vec2[];
  /** Road surface height at each point, metres. */
  h: number[];
  /** Asphalt width, metres. */
  width: number;
  /** Speed limit, km/h. */
  speed: number;
  /** The route of a circuit: the last point joins the first. */
  closed?: boolean;
}

export interface TrafficRoundabout {
  c: Vec2;
  /** Ring surface height. */
  h: number;
  /** Inner (island) and outer radius of the circulating carriageway. */
  rIn: number;
  rOut: number;
}

interface Lane {
  name: string;
  id: number;
  loop: boolean;
  role: number;
  priority: number;
  priorityOffset: number;
  speedLimit: number;
  points: [number, number, number][];
  params: Record<string, unknown>;
}

interface Intersection {
  name: string;
  id: number;
  points: [number, number, number][];
}

/** Lane roles, as the planner's Rules tab shows them (1-based in lanes' `role`). */
const ROLES = [
  { name: "Local street", priority: -4, speedLimit: 50 },
  { name: "Town road", priority: 0, speedLimit: 60 },
  { name: "Main road", priority: 2, speedLimit: 80 },
  { name: "Highway", priority: 4, speedLimit: 100 },
  { name: "Roundabout", priority: 6, speedLimit: 30 },
];
const roleFor = (speed: number) => (speed <= 50 ? 1 : speed <= 60 ? 2 : speed <= 80 ? 3 : 4);

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ac = (p: Vec2, h: number): [number, number, number] => [+p[0].toFixed(2), +h.toFixed(2), +(-p[1]).toFixed(2)];

/** Closest point on a polyline to p: the point, its distance, and the segment it falls on. */
function nearestOn(pts: Vec2[], p: Vec2): { q: Vec2; d: number; seg: number; t: number } {
  let best = { q: pts[0], d: Infinity, seg: 0, t: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
    const d = dist(p, q);
    if (d < best.d) best = { q, d, seg: i - 1, t };
  }
  return best;
}

/** Where segments ab and cd cross (strictly inside both), or null. */
function crossing(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null;
}

/** Points at least `step` metres apart (keeping the ends), with their heights. */
function thin(pts: Vec2[], h: number[], step: number): { pts: Vec2[]; h: number[] } {
  const op: Vec2[] = [pts[0]], oh = [h[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(pts[i], op[op.length - 1]) >= step) {
      op.push(pts[i]);
      oh.push(h[i]);
    }
  }
  op.push(pts[pts.length - 1]);
  oh.push(h[h.length - 1]);
  return { pts: op, h: oh };
}

/** The polyline moved sideways by `off` metres (positive = left of the direction of travel). */
function offset(pts: Vec2[], off: number, closed: boolean): Vec2[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / L) * off, p[1] + (dx / L) * off];
  });
}

function polygon(c: Vec2, r: number, h: number, sides = 8): [number, number, number][] {
  return Array.from({ length: sides }, (_, k) => {
    const a = (k / sides) * Math.PI * 2 + Math.PI / sides;
    return ac([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r], h);
  });
}

export function trafficGraph(roadsIn: TrafficRoad[], roundabouts: TrafficRoundabout[]): { lanes: Lane[]; intersections: Intersection[] } {
  // 1. Cut every road where it runs through a roundabout: traffic goes round the ring instead.
  const inRing = (p: Vec2) => roundabouts.findIndex((rb) => dist(p, rb.c) < rb.rOut + 0.5);
  const roads: TrafficRoad[] = [];
  for (const r of roadsIn) {
    if (r.pts.length < 2) continue;
    const runs: number[][] = [];
    let cur: number[] = [];
    r.pts.forEach((p, i) => {
      if (inRing(p) >= 0) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push(i);
    });
    if (cur.length) runs.push(cur);
    // A circuit with no roundabout stays one closed loop; otherwise the run
    // that wraps past the end joins the first one.
    if (r.closed && runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1].at(-1) === r.pts.length - 1) {
      runs[0] = [...runs.pop()!, ...runs[0]];
    }
    const closed = !!r.closed && runs.length === 1 && runs[0].length === r.pts.length;
    for (const run of runs) {
      const t = thin(run.map((i) => r.pts[i]), run.map((i) => r.h[i]), 2);
      let len = 0;
      for (let i = 1; i < t.pts.length; i++) len += dist(t.pts[i - 1], t.pts[i]);
      if (len >= 8) roads.push({ ...r, pts: t.pts, h: t.h, closed });
    }
  }

  // 2. Junctions: a road's end against another road, and roads crossing.
  type Junction = { c: Vec2; r: number; h: number };
  const junctions: Junction[] = [];
  const nearRing = (p: Vec2, pad: number) => roundabouts.some((rb) => dist(p, rb.c) < rb.rOut + pad);
  roads.forEach((r, ri) => {
    if (r.closed) return;
    for (const end of [0, r.pts.length - 1]) {
      const p = r.pts[end];
      if (nearRing(p, 6)) continue;
      let best: { q: Vec2; d: number; o: TrafficRoad } | null = null;
      roads.forEach((o, oi) => {
        if (oi === ri) return;
        const n = nearestOn(o.closed ? [...o.pts, o.pts[0]] : o.pts, p);
        if (n.d < o.width / 2 + 6 && (!best || n.d < best.d)) best = { q: n.q, d: n.d, o };
      });
      if (best) {
        const b = best as { q: Vec2; d: number; o: TrafficRoad };
        junctions.push({ c: b.q, r: Math.max(b.d + 3, b.o.width / 2 + 3, r.width / 2 + 3), h: r.h[end] });
      }
    }
  });
  for (let a = 0; a < roads.length; a++) {
    for (let b = a + 1; b < roads.length; b++) {
      const A = roads[a].pts, B = roads[b].pts;
      for (let i = 1; i < A.length; i++) {
        for (let j = 1; j < B.length; j++) {
          const x = crossing(A[i - 1], A[i], B[j - 1], B[j]);
          if (x && !nearRing(x, 6)) junctions.push({ c: x, r: Math.max(roads[a].width, roads[b].width) / 2 + 3, h: roads[a].h[i] });
        }
      }
    }
  }
  // Overlapping polygons confuse the planner (a lane can't be in two at
  // once), so any that touch become one circle around both, until none do.
  type Spot = Junction & { turn?: boolean };
  const mergeAll = (list: Spot[]): Spot[] => {
    const out = list.map((j) => ({ ...j }));
    for (let again = true; again;) {
      again = false;
      for (let a = 0; a < out.length && !again; a++) {
        for (let b = a + 1; b < out.length; b++) {
          const A = out[a], B = out[b], d = dist(A.c, B.c);
          if (d >= A.r + B.r + 0.5) continue;
          const big = d + A.r <= B.r ? B : d + B.r <= A.r ? A : null;
          const r = big ? big.r : (d + A.r + B.r) / 2;
          const c: Vec2 = big ? big.c : [A.c[0] + ((B.c[0] - A.c[0]) * (r - A.r)) / d, A.c[1] + ((B.c[1] - A.c[1]) * (r - A.r)) / d];
          out[a] = { c, r, h: (A.h + B.h) / 2, turn: !!A.turn && !!B.turn };
          out.splice(b, 1);
          again = true;
          break;
        }
      }
    }
    return out;
  };
  let merged: Spot[] = mergeAll(junctions);
  // Dead ends: where a road stops away from any junction, somewhere to turn round.
  for (const r of roads) {
    if (r.closed) continue;
    for (const end of [0, r.pts.length - 1]) {
      const p = r.pts[end];
      if (merged.some((j) => dist(p, j.c) < j.r - 1) || nearRing(p, 6)) continue;
      merged.push({ c: p, r: r.width / 2 + 1.5, h: r.h[end], turn: true });
    }
  }
  merged = mergeAll(merged);

  // 3. Lanes, both ways, on the left.
  const lanes: Lane[] = [];
  let laneId = 1;
  roads.forEach((r, ri) => {
    const perDir = r.width >= 12 ? 2 : 1;
    const laneW = Math.min(3.5, r.width / (2 * perDir));
    const role = roleFor(r.speed);
    for (let k = 0; k < perDir; k++) {
      const off = laneW * (k + 0.5);
      for (const dir of [1, -1]) {
        const pts = offset(r.pts, off * dir, !!r.closed);
        const h = r.h.slice();
        if (dir === -1) {
          pts.reverse();
          h.reverse();
        }
        lanes.push({
          name: `Road ${ri + 1} ${dir === 1 ? "forward" : "back"}${perDir > 1 ? ` ${k + 1}` : ""}`,
          id: laneId++,
          loop: !!r.closed,
          role,
          priority: ROLES[role - 1].priority,
          priorityOffset: 0,
          speedLimit: r.speed,
          points: pts.map((p, i) => ac(p, h[i])),
          params: {},
        });
      }
    }
  });

  // 4. Roundabouts: a clockwise ring lane, and an intersection where each road meets it.
  const intersections: Intersection[] = [];
  let interId = 1;
  roundabouts.forEach((rb, k) => {
    const rr = (rb.rIn + rb.rOut) / 2;
    const n = Math.max(16, Math.round((2 * Math.PI * rr) / 3));
    // Clockwise seen from above: the angle falls (y is north).
    const ring = Array.from({ length: n }, (_, i) => -(i / n) * Math.PI * 2);
    lanes.push({
      name: `Roundabout ${k + 1}`,
      id: laneId++,
      loop: true,
      role: 5,
      priority: ROLES[4].priority,
      priorityOffset: 0,
      speedLimit: ROLES[4].speedLimit,
      points: ring.map((a) => ac([rb.c[0] + Math.cos(a) * rr, rb.c[1] + Math.sin(a) * rr], rb.h)),
      params: { allowLaneChanges: false },
    });
    // Each road end at the ring is an arm: an angular range from inside the
    // ring lane out past the end. Arms that overlap (a road and a side street
    // meeting the ring together) become one, so no two polygons overlap.
    const r0 = rr - 2;
    const arms: { a0: number; a1: number; r1: number }[] = [];
    for (const r of roads) {
      if (r.closed) continue;
      for (const end of [0, r.pts.length - 1]) {
        const p = r.pts[end];
        if (dist(p, rb.c) > rb.rOut + 6) continue;
        const a = Math.atan2(p[1] - rb.c[1], p[0] - rb.c[0]);
        const r1 = Math.max(rb.rOut + 4, dist(p, rb.c) + 3);
        const half = Math.atan2(r.width / 2 + 3, r0);
        arms.push({ a0: a - half, a1: a + half, r1 });
      }
    }
    type Group = { a0: number; a1: number; r1: number };
    const group = (list: Group[]): Group[] => {
      const sorted = [...list].sort((x, y) => x.a0 - y.a0);
      const out: Group[] = [];
      for (const arm of sorted) {
        const g = out[out.length - 1];
        if (g && arm.a0 < g.a1 + 0.15) {
          g.a1 = Math.max(g.a1, arm.a1);
          g.r1 = Math.max(g.r1, arm.r1);
        } else out.push({ ...arm });
      }
      // Wrapping round past +pi into the first group.
      if (out.length > 1 && out[out.length - 1].a1 + 0.15 > out[0].a0 + Math.PI * 2) {
        const last = out.pop()!;
        out[0] = { a0: last.a0 - Math.PI * 2, a1: Math.max(out[0].a1, last.a1 - Math.PI * 2), r1: Math.max(out[0].r1, last.r1) };
      }
      return out;
    };
    // The angular reach of a junction circle seen from the ring's centre.
    const span = (j: { c: Vec2; r: number }) => {
      const d = dist(j.c, rb.c), a = Math.atan2(j.c[1] - rb.c[1], j.c[0] - rb.c[0]);
      const half = Math.asin(Math.min(1, j.r / Math.max(d, j.r)));
      return { d, a0: a - half, a1: a + half };
    };
    const touches = (g: Group, j: { c: Vec2; r: number }) => {
      const s = span(j);
      if (s.d - j.r > g.r1 + 0.5) return false;
      for (const off of [-Math.PI * 2, 0, Math.PI * 2]) if (s.a0 + off < g.a1 + 0.05 && s.a1 + off > g.a0 - 0.05) return true;
      return false;
    };
    // A junction that would touch an arm (a side street meeting the road as
    // it arrives at the ring) joins it, until none touch.
    let groups = group(arms);
    for (let again = true; again;) {
      again = false;
      const idx = merged.findIndex((j) => dist(j.c, rb.c) < rb.rOut + 4 + j.r + 0.5 || groups.some((g) => touches(g, j)));
      if (idx >= 0) {
        const j = merged[idx];
        const s = span(j);
        arms.push({ a0: s.a0, a1: s.a1, r1: s.d + j.r });
        merged.splice(idx, 1);
        groups = group(arms);
        again = true;
      }
    }
    for (const g of groups) {
      // Arms all round a small ring: leave a gap so the sector doesn't close on itself.
      g.a1 = Math.min(g.a1, g.a0 + Math.PI * 2 - 0.3);
      // An annular sector: arcs at r0 (inside the ring lane) and r1, so the
      // ring lane runs in at one end and out at the other however wide it is.
      const steps = Math.max(1, Math.ceil((g.a1 - g.a0) / 0.2));
      const arc = (rad: number) => Array.from({ length: steps + 1 }, (_, i): Vec2 => {
        const a = g.a0 + ((g.a1 - g.a0) * i) / steps;
        return [rb.c[0] + Math.cos(a) * rad, rb.c[1] + Math.sin(a) * rad];
      });
      intersections.push({
        name: `Roundabout ${k + 1} arm`,
        id: interId++,
        points: [...arc(g.r1), ...arc(r0).reverse()].map((q) => ac(q, rb.h)),
      });
    }
  });

  for (const j of merged) intersections.push({ name: `${j.turn ? "Turn" : "Junction"} ${interId}`, id: interId++, points: polygon(j.c, j.r, j.h, j.turn ? 6 : 8) });

  return { lanes, intersections };
}

/** data/traffic.json for CSP's traffic planner. */
export function trafficJson(roads: TrafficRoad[], roundabouts: TrafficRoundabout[]): string {
  const g = trafficGraph(roads, roundabouts);
  return JSON.stringify({ lanes: g.lanes, intersections: g.intersections, areas: [], rules: { laneRoles: ROLES } });
}
