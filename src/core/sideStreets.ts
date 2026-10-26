// Side streets: the other roads near the route, drawn so the route doesn't
// run through an empty world. They come from the vector tiles, are cut away
// where they overlap the route itself, and are draped on the terrain. Where
// one meets the route it is extended to the route's edge and the route's
// verge (and edge line) opens up for the junction mouth.
//
// Grade-separated roads (motorways, links, bridges, tunnels) are left out:
// drawn on the ground they would make crossings that don't exist.

import type { HeightFn } from "./elevation";
import type { LngLat, LocalProjection, Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import type { BuildOptions } from "./options";
import { resample } from "./polyline";
import { inRoundabout, isLoop, planRoad, surfaceHeight, type RoadPlan, type SegmentIndex } from "./road";
import { applyTrace, traceRoad, type RasterSampler } from "./trace";
import { pad } from "./roadMesh";
import { ChunkedMesh } from "./scenery";
import { SEAL_LENGTH } from "./textures";

export interface StreetLine {
  pts: LngLat[];
  cls: string;
  brunnel?: string;
}

export interface StreetName {
  pts: LngLat[];
  name: string;
}

/** Asphalt width by road class for streets that aren't the route. */
const SIDE_WIDTH: Record<string, number> = {
  primary: 7.5, secondary: 7, tertiary: 6.5, minor: 6, service: 4, track: 3.5,
};

export interface Junction {
  /** Route sample index where the side street meets it. */
  seg: number;
  /** Distance along the route. */
  s: number;
  /** Which side of the route: 1 left, -1 right. */
  side: 1 | -1;
  /** Side street width, metres. */
  width: number;
  /** Unit direction of the side street, pointing away from the route. */
  dir: Vec2;
  name?: string;
}

export interface SideStreet {
  pts: Vec2[];
  width: number;
  /** Per-point widths once traced from the photo. */
  widths?: number[];
  /** The traced centreline as a road plan, and how far to trust each sample. */
  traced?: { plan: RoadPlan; conf: number[] };
  cls: string;
  name?: string;
  /** Indices into `pts` that sit on the route's edge (junction mouths). */
  joins: number[];
}

/** Grid hash of line segments for "how far to the nearest street" queries. */
export class LineIndex {
  private cells = new Map<string, [Vec2, Vec2, number][]>();
  constructor(lines: { pts: Vec2[]; width: number }[], private readonly cell = 20) {
    for (const l of lines) {
      for (let i = 1; i < l.pts.length; i++) {
        const a = l.pts[i - 1], b = l.pts[i];
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const k = x + "," + y;
          if (!this.cells.has(k)) this.cells.set(k, []);
          this.cells.get(k)!.push([a, b, l.width]);
        }
      }
    }
  }

  /** Distance from (x, y) to the nearest street's edge (negative inside it). */
  clearance(x: number, y: number): number {
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let best = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const [a, b, w] of this.cells.get(gx + "," + gy) ?? []) {
          const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
          best = Math.min(best, Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t) - w / 2);
        }
      }
    }
    return best;
  }
}

function nearestName(p: Vec2, names: { pts: Vec2[]; name: string }[], max: number): string | undefined {
  let best: string | undefined, bestD = max;
  for (const n of names) {
    for (let i = 1; i < n.pts.length; i++) {
      const a = n.pts[i - 1], b = n.pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
      const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
      if (d < bestD) {
        bestD = d;
        best = n.name;
      }
    }
  }
  return best;
}

export interface StreetPlan {
  streets: SideStreet[];
  junctions: Junction[];
  /** The route's own name at each sample, where the map has one. */
  routeNames: (string | undefined)[];
}

export function planSideStreets(
  lines: StreetLine[],
  names: StreetName[],
  plan: RoadPlan,
  index: SegmentIndex,
  opts: BuildOptions,
  proj: LocalProjection,
): StreetPlan {
  const localNames = names.map((n) => ({ name: n.name, pts: n.pts.map((p) => proj.toLocal(p)) }));
  const streets: SideStreet[] = [];
  const junctions: Junction[] = [];

  for (const line of lines) {
    const width = SIDE_WIDTH[line.cls];
    if (!width || line.brunnel === "bridge" || line.brunnel === "tunnel" || line.pts.length < 2) continue;
    const dense = resample(line.pts.map((p) => proj.toLocal(p)), 2);
    // Keep points clear of the route and its verges, inside the terrain corridor.
    const state = dense.map(([x, y]) => {
      if (inRoundabout(plan, x, y, opts.vergeWidth + width / 2)) return "ring";
      const n = index.nearest(x, y, opts.corridor);
      if (!n) return "far";
      if (n.dist < index.at(n).width / 2 + opts.vergeWidth + width / 2 * 0.2 + 0.3) return "route";
      return n.dist < opts.corridor - 3 ? "keep" : "far";
    });
    for (let i = 0; i < dense.length;) {
      if (state[i] !== "keep") { i++; continue; }
      let j = i;
      while (j < dense.length && state[j] === "keep") j++;
      let pts = dense.slice(i, j);
      const joins: number[] = [];
      // Ends that were cut by the route become junctions: run them to its edge.
      const join = (end: Vec2, outward: Vec2): Vec2 | null => {
        const n = index.nearest(end[0], end[1], 30);
        if (!n) return null;
        const s = plan.samples[n.seg];
        const side: 1 | -1 = n.t >= 0 ? 1 : -1;
        const half = index.at(n).width / 2;
        // Carry on along the street itself until it meets the route's edge.
        const across = Math.abs(outward[0] * s.left[0] + outward[1] * s.left[1]);
        const back = (n.dist - (half - 0.05)) / Math.max(0.35, across);
        const edge: Vec2 = [end[0] - outward[0] * back, end[1] - outward[1] * back];
        junctions.push({ seg: n.seg, s: s.s, side, width, dir: outward, name: undefined });
        return edge;
      };
      if (i > 0 && state[i - 1] === "route" && pts.length > 1) {
        const out = norm([pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]);
        const e = join(pts[0], out);
        if (e) {
          pts = [e, ...pts];
          joins.push(0);
        }
      }
      if (j < dense.length && state[j] === "route" && pts.length > 1) {
        const k = pts.length - 1;
        const out = norm([pts[k - 1][0] - pts[k][0], pts[k - 1][1] - pts[k][1]]);
        const e = join(pts[k], out);
        if (e) {
          pts = [...pts, e];
          joins.push(pts.length - 1);
        }
      }
      const length = pts.reduce((a, p, k) => (k ? a + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);
      if (length >= 8) {
        const name = nearestName(pts[Math.floor(pts.length / 2)], localNames, 8);
        streets.push({ pts, width, cls: line.cls, name, joins });
        for (let k = junctions.length - joins.length; k < junctions.length; k++) junctions[k].name = name;
      } else {
        junctions.splice(junctions.length - joins.length, joins.length);
      }
      i = j;
    }
  }

  // Merge junctions at the same mouth (a street split across tiles).
  const merged: Junction[] = [];
  for (const jn of junctions.sort((a, b) => a.s - b.s)) {
    const prev = merged.find((m) => m.side === jn.side && Math.abs(m.s - jn.s) < Math.max(m.width, jn.width));
    if (prev) prev.name ??= jn.name;
    else merged.push(jn);
  }

  const routeNames = plan.samples.map(() => undefined as string | undefined);
  for (let i = 0; i < plan.samples.length; i += 10) {
    const nm = nearestName(plan.samples[i].pos, localNames, 10);
    for (let k = i; k < Math.min(plan.samples.length, i + 10); k++) routeNames[k] = nm;
  }
  return { streets, junctions: merged, routeNames };
}

function norm(v: Vec2): Vec2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/**
 * Height of a street's surface at lateral offset `t` (+ left) from its point
 * k: 10 cm above the ground, blending down over the last 10 m to a junction
 * to sit 2 cm under the route's surface.
 */
export function streetSurface(plan: RoadPlan, index: SegmentIndex, opts: BuildOptions, ground: HeightFn) {
  const routeSurface = (x: number, y: number) => {
    const near = index.nearest(x, y, 40);
    if (!near) return ground(x, y);
    const s = plan.samples[near.seg];
    return surfaceHeight(s, near.t, opts.crown);
  };
  return (st: SideStreet, k: number, t: number) => {
    const n = st.pts.length;
    const a = st.pts[Math.max(0, k - 1)], b = st.pts[Math.min(n - 1, k + 1)];
    const d = norm([b[0] - a[0], b[1] - a[1]]);
    const x = st.pts[k][0] - d[1] * t, y = st.pts[k][1] + d[0] * t;
    const draped = ground(x, y) + 0.1;
    let along = 0, dJoin = Infinity;
    const at: number[] = [0];
    for (let q = 1; q < n; q++) at.push(at[q - 1] + Math.hypot(st.pts[q][0] - st.pts[q - 1][0], st.pts[q][1] - st.pts[q - 1][1]));
    along = at[k];
    for (const j of st.joins) dJoin = Math.min(dJoin, Math.abs(along - at[j]));
    if (dJoin >= 10) return draped;
    const r = routeSurface(x, y) - 0.02;
    const f = dJoin / 10;
    return r + (draped - r) * f * f * (3 - 2 * f);
  };
}

/**
 * Draped ribbons. Each street sits 10 cm above the ground; at a junction it
 * blends down to the route's surface over 10 m and tucks 2 cm under the
 * route's edge so the two never fight.
 */
export function buildSideStreets(
  streets: SideStreet[],
  plan: RoadPlan,
  index: SegmentIndex,
  opts: BuildOptions,
  ground: HeightFn,
  materialFor: (st: SideStreet, i: number) => string | { material: string; perStreet: true },
): Kn5MeshNode[] {
  const out: Kn5MeshNode[] = [];
  const meshes = new Map<string, ChunkedMesh>();
  const surface = streetSurface(plan, index, opts, ground);
  streets.forEach((st, si) => {
    const choice = materialFor(st, si);
    const mat = typeof choice === "string" ? choice : choice.material;
    if (!meshes.has(mat)) meshes.set(mat, new ChunkedMesh(0));
    const mb = meshes.get(mat)!.next(st.pts.length * 2);
    const n = st.pts.length;
    const along = [0];
    for (let k = 1; k < n; k++) along.push(along[k - 1] + Math.hypot(st.pts[k][0] - st.pts[k - 1][0], st.pts[k][1] - st.pts[k - 1][1]));
    const base = mb.vertexCount;
    for (let k = 0; k < n; k++) {
      const a = st.pts[Math.max(0, k - 1)], b = st.pts[Math.min(n - 1, k + 1)];
      const t = norm([b[0] - a[0], b[1] - a[1]]);
      const left: Vec2 = [-t[1], t[0]];
      const w = st.widths?.[k] ?? st.width;
      for (const side of [1, -1]) {
        const x = st.pts[k][0] + left[0] * side * w / 2, y = st.pts[k][1] + left[1] * side * w / 2;
        mb.vertex([x, y, surface(st, k, side * w / 2)], side > 0 ? 0 : 1, typeof choice === "string" ? along[k] / SEAL_LENGTH : along[k] / Math.max(1, along[n - 1]));
      }
    }
    for (let k = 0; k < n - 1; k++) {
      const p = base + k * 2, q = p + 2;
      mb.quad(p, p + 1, q + 1, q);
    }
  });
  let i = 0;
  for (const [mat, cm] of meshes) {
    for (const m of cm.all()) {
      m.normals = null; // from the faces
      // Drivable like the road, but not valid track: cutting through one is a shortcut.
      out.push(m.toKn5(`1STREET_${pad(i++)}`, mat));
    }
  }
  return out;
}

/**
 * Traces each side street in the aerial photo the way the route is traced,
 * moving it onto its real line and width. Junction ends stay pinned to the
 * route's edge.
 */
export function traceSideStreets(streets: SideStreet[], raster: RasterSampler, opts: BuildOptions): number {
  let traced = 0;
  for (const st of streets) {
    const length = st.pts.reduce((a, p, k) => (k ? a + Math.hypot(p[0] - st.pts[k - 1][0], p[1] - st.pts[k - 1][1]) : 0), 0);
    if (length < 30 || isLoop(st.pts)) continue;
    const sub = planRoad(st.pts, { ...opts, widthOverride: st.width, lineSmoothing: 2, banking: false });
    const tr = traceRoad(sub, raster);
    if (tr.coverage < 0.2) continue;
    const n = sub.samples.length;
    // Ease the shift to nothing over 12 m at each junction end.
    const ends = st.joins.map((j) => (j === 0 ? 0 : n - 1));
    tr.offset = tr.offset.map((o, i) => {
      const d = Math.min(Infinity, ...ends.map((e) => Math.abs(sub.samples[i].s - sub.samples[e].s)));
      return o * Math.min(1, d / 12);
    });
    applyTrace(sub, tr, () => false);
    st.pts = sub.samples.map((s) => s.pos);
    st.widths = sub.samples.map((s) => s.width);
    st.joins = ends;
    st.traced = { plan: sub, conf: tr.conf };
    traced++;
  }
  return traced;
}
