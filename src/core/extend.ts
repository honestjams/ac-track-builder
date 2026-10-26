// Run-up and run-off for point-to-point roads. The timed section is the
// road between the two pins; the car needs room before the start line to
// line up a grid (and get rolling for a flying lap), and room after the
// finish to brake. Both are added along the real streets the route starts
// and ends on, following them on through junctions where a street carries
// straight on, and continuing straight ahead where the street ends.

import type { Vec2 } from "./geo";

/** How far the route is extended before its start and after its finish, metres. */
export interface Extension {
  path: Vec2[];
  /** Distance along `path` (polyline metres) of the original start and finish. */
  startAt: number;
  finishAt: number;
}

const SNAP = 10; // a street within this distance of the end carries it on
const JOIN = 4; // chain onto another street whose end is this close
const STEP = 2;

function len(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function unit(a: Vec2, b: Vec2): Vec2 {
  const l = len(a, b) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

/** Point `d` metres back from the end of a path (or its first point). */
function back(path: Vec2[], d: number): Vec2 {
  let acc = 0;
  for (let i = path.length - 1; i > 0; i--) {
    const l = len(path[i], path[i - 1]);
    if (acc + l >= d) {
      const f = (d - acc) / l;
      return [path[i][0] + (path[i - 1][0] - path[i][0]) * f, path[i][1] + (path[i - 1][1] - path[i][1]) * f];
    }
    acc += l;
  }
  return path[0];
}

/**
 * Carries a path on from its last point for `want` metres: along a street
 * heading the same way where there is one, otherwise straight on.
 */
export function carryOn(path: Vec2[], lines: Vec2[][], want: number): Vec2[] {
  const out: Vec2[] = [];
  let at = path[path.length - 1];
  let dir = unit(back(path, Math.min(15, pathLength(path))), at);
  let got = 0;
  const used = new Set<Vec2[]>();
  let snap = SNAP;
  while (got < want - 1e-6) {
    // The street under the end, followed the way the road is heading.
    let best: { line: Vec2[]; seg: number; f: number; fwd: boolean; score: number } | null = null;
    for (const line of lines) {
      if (used.has(line)) continue;
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const L = len(a, b);
        if (L < 1e-6) continue;
        const f = Math.max(0, Math.min(1, ((at[0] - a[0]) * (b[0] - a[0]) + (at[1] - a[1]) * (b[1] - a[1])) / (L * L)));
        const d = Math.hypot(at[0] - (a[0] + (b[0] - a[0]) * f), at[1] - (a[1] + (b[1] - a[1]) * f));
        if (d > snap) continue;
        const u = unit(a, b), dot = u[0] * dir[0] + u[1] * dir[1];
        if (Math.abs(dot) < 0.8) continue;
        const score = d + (1 - Math.abs(dot)) * 20;
        if (!best || score < best.score) best = { line, seg: i, f, fwd: dot > 0, score };
      }
    }
    if (!best) break;
    used.add(best.line);
    // Walk along it from the foot of the end point.
    const { line, seg, f, fwd } = best;
    const a = line[seg - 1], b = line[seg];
    const pts: Vec2[] = [[a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]];
    if (fwd) for (let i = seg; i < line.length; i++) pts.push(line[i]);
    else for (let i = seg - 1; i >= 0; i--) pts.push(line[i]);
    let prev = at;
    for (const p of pts) {
      const l = len(prev, p);
      if (l < 1e-6) continue;
      if (got + l >= want) {
        const k = (want - got) / l;
        const q: Vec2 = [prev[0] + (p[0] - prev[0]) * k, prev[1] + (p[1] - prev[1]) * k];
        dir = unit(prev, q);
        out.push(q);
        got = want;
        prev = q;
        break;
      }
      dir = unit(prev, p);
      out.push(p);
      got += l;
      prev = p;
    }
    at = prev;
    snap = JOIN;
  }
  // Straight on for whatever is left.
  for (let d = STEP; got < want - 1e-6; d += STEP) {
    const step = Math.min(STEP, want - got);
    at = [at[0] + dir[0] * step, at[1] + dir[1] * step];
    out.push(at);
    got += step;
  }
  return out;
}

export function pathLength(path: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += len(path[i - 1], path[i]);
  return l;
}

/** Adds `before` metres ahead of the start and `after` metres past the finish. */
export function extendRoute(path: Vec2[], lines: Vec2[][], before: number, after: number): Extension {
  const head = before > 0 ? carryOn(path.slice().reverse(), lines, before).reverse() : [];
  const tail = after > 0 ? carryOn(path, lines, after) : [];
  const full = [...head, ...path, ...tail];
  const startAt = pathLength([...head, path[0]]);
  return { path: full, startAt, finishAt: startAt + pathLength(path) };
}
