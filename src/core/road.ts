// The road model: a smoothed centreline sampled every `spacing` metres, with
// a width, a centre height, and a cross-slope (banking) at each sample.
// Everything else (road mesh, terrain, walls, AI line, spawn points) is
// derived from these samples.

import type { Vec2 } from "./geo";
import type { HeightFn } from "./elevation";
import type { BuildOptions } from "./options";
import { dedupe, frames, gaussianSmooth, resample, smoothPath, type PathFrame } from "./polyline";
import { ringHeight, snapToCircles, type Circle, type Roundabout } from "./roundabout";

export interface RoadSample extends PathFrame {
  /** Full asphalt width, metres. */
  width: number;
  /** Centreline surface height, metres. */
  h: number;
  /** Cross-slope, metres of rise per metre to the left (negative = left side lower). */
  bank: number;
  /** Kerb and gutter on the [left, right], 0..1 (absent = none). */
  kerb?: [number, number];
}

export interface RoadPlan {
  closed: boolean;
  samples: RoadSample[];
  length: number;
  roundabouts: Roundabout[];
  /** Point to point: sample indices of the start and finish lines (the pins), when a run-up and run-off were added. */
  timed?: { start: number; finish: number };
}

/** Width lookup for a point, usually from OSM tags; undefined = no data. */
export type WidthFn = (x: number, y: number) => number | undefined;

/** A closed loop is a route whose start and finish pins are within 30 m. */
export function isLoop(path: Vec2[]): boolean {
  const a = path[0], b = path[path.length - 1];
  return path.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 30;
}

export function planRoad(raw: Vec2[], opts: BuildOptions, widthFn?: WidthFn, circles: Circle[] = []): RoadPlan {
  let path = dedupe(raw);
  if (path.length < 2) throw new Error("Route has fewer than two distinct points");
  const closed = isLoop(path);
  if (closed) path = path.slice(0, -1).concat([path[0]]);
  // Dense resample, smooth, then resample at the working spacing.
  let dense = resample(path, 1);
  if (closed) dense = dense.slice(0, -1);
  // Roundabout arcs go onto their exact circle and are left out of the
  // smoothing (which would pull a small circle into a hairpin); the road
  // either side eases into them.
  const pinned = snapToCircles(dense, circles);
  const snapped = dense.map((p) => [p[0], p[1]] as Vec2);
  dense = smoothPath(dense, opts.lineSmoothing, 1, closed);
  if (pinned.some(Boolean)) {
    const reach = Math.max(1, opts.lineSmoothing * 2);
    const away = distanceToPinned(pinned, closed);
    dense = dense.map((p, i) => {
      const w = Math.min(1, away[i] / reach);
      return [snapped[i][0] + (p[0] - snapped[i][0]) * w, snapped[i][1] + (p[1] - snapped[i][1]) * w];
    });
  }
  if (closed) dense.push(dense[0]);
  let pts = resample(dense, opts.spacing);
  if (closed) pts = pts.slice(0, -1);
  const fr = frames(pts, closed);
  const length = closed
    ? fr[fr.length - 1].s + Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1])
    : fr[fr.length - 1].s;

  let widths = fr.map((f) => {
    if (opts.widthOverride > 0) return opts.widthOverride;
    const w = widthFn?.(f.pos[0], f.pos[1]);
    return w && w > 2 && w < 30 ? w : opts.defaultWidth;
  });
  // Width changes ease in over ~40 m instead of stepping at way boundaries.
  widths = gaussianSmooth(widths, 20 / opts.spacing, closed);

  // Banking from smoothed curvature: tighter corner, more tilt into it.
  const curv = gaussianSmooth(fr.map((f) => f.curvature), 8 / opts.spacing, closed);
  const banks = opts.banking
    ? gaussianSmooth(curv.map((k) => -Math.max(-opts.maxBank, Math.min(opts.maxBank, k * 3))), 10 / opts.spacing, closed)
    : fr.map(() => 0);

  const samples: RoadSample[] = fr.map((f, i) => ({ ...f, curvature: curv[i], width: widths[i], h: 0, bank: banks[i] }));
  const roundabouts = ringsAlong(samples, circles, closed, length);
  return { closed, samples, length, roundabouts };
}

/** Index distance from each point to the nearest pinned point. */
function distanceToPinned(pinned: boolean[], closed: boolean): number[] {
  const n = pinned.length;
  const d = pinned.map((p) => (p ? 0 : Infinity));
  for (let pass = 0; pass < (closed ? 2 : 1); pass++) {
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? d[i - 1] : closed ? d[n - 1] : Infinity;
      d[i] = Math.min(d[i], prev + 1);
    }
    for (let i = n - 1; i >= 0; i--) {
      const next = i < n - 1 ? d[i + 1] : closed ? d[0] : Infinity;
      d[i] = Math.min(d[i], next + 1);
    }
  }
  return d;
}

/**
 * Which stretches of the road run round each circle. Sets the carriageway
 * width on the ring (at least 7 m, the usual single-lane circulating width;
 * 4.6 m a lane when the ring is tagged with two or more),
 * takes the banking off (the ring falls outward instead), and records where
 * the road crosses the ring's outer edge.
 */
/** Width of one circulating lane on a multi-lane roundabout, metres. */
const MULTI_LANE_W = 4.6;

function ringsAlong(samples: RoadSample[], circles: Circle[], closed: boolean, length: number): Roundabout[] {
  const out: Roundabout[] = [];
  for (const { c, r, lanes: tagged } of circles) {
    const on = samples.map((s) => Math.abs(Math.hypot(s.pos[0] - c[0], s.pos[1] - c[1]) - r) < 1);
    if (!on.some(Boolean)) continue;
    const idx = on.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    // Circulating lanes are wider than lanes on the straight (long vehicles sweep wide): about 4.6 m each.
    const w = Math.max(7, (tagged ?? 0) >= 2 ? tagged! * MULTI_LANE_W : 0, ...idx.map((i) => samples[i].width));
    const lanes = tagged ?? (w >= 9.5 ? 2 : 1);
    const outer = r + w / 2;
    for (const i of idx) {
      samples[i].width = w;
      samples[i].bank = 0;
    }
    const crossings: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const j = i + 1 < samples.length ? i + 1 : closed ? 0 : -1;
      if (j < 0) break;
      const di = Math.hypot(samples[i].pos[0] - c[0], samples[i].pos[1] - c[1]);
      const dj = Math.hypot(samples[j].pos[0] - c[0], samples[j].pos[1] - c[1]);
      if ((di - outer) * (dj - outer) <= 0) {
        crossings.push(Math.atan2(samples[i].pos[1] - c[1], samples[i].pos[0] - c[0]));
      }
    }
    const sIn = samples[idx[0]].s, sOut = samples[idx[idx.length - 1]].s;
    out.push({ c, r, w, lanes, hc: 0, sIn, sOut: Math.min(length, sOut), crossings });
  }
  return out;
}

/** Is (x, y) on a roundabout (within its outer edge plus `margin`)? */
export function inRoundabout(plan: RoadPlan, x: number, y: number, margin = 0): Roundabout | undefined {
  return plan.roundabouts.find((rb) => Math.hypot(x - rb.c[0], y - rb.c[1]) < rb.r + rb.w / 2 + margin);
}

/** Fills in centre heights from the DEM, smoothed along the road. */
export function applyElevation(plan: RoadPlan, height: HeightFn, opts: BuildOptions): void {
  const raw = plan.samples.map((s) => height(s.pos[0], s.pos[1]));
  const smooth = gaussianSmooth(raw, opts.elevationSmoothing / opts.spacing, plan.closed);
  plan.samples.forEach((s, i) => (s.h = smooth[i]));
  // Roundabouts are level: the ring takes the ground height at its centre,
  // and the approaches ease to it over 30 m.
  for (const rb of plan.roundabouts) {
    rb.hc = height(rb.c[0], rb.c[1]);
    const outer = rb.r + rb.w / 2;
    for (const s of plan.samples) {
      const d = Math.hypot(s.pos[0] - rb.c[0], s.pos[1] - rb.c[1]);
      const ring = ringHeight(rb, Math.max(rb.r - rb.w / 2, Math.min(outer, d)));
      const f = Math.min(1, Math.max(0, (d - outer) / 30));
      const w = 1 - f * f * (3 - 2 * f);
      s.h = s.h + (ring - s.h) * w;
    }
  }
}

/** Road surface height at lateral offset t (metres, positive = left of travel). */
export function surfaceHeight(s: RoadSample, t: number, crown: number): number {
  const half = s.width / 2;
  const tc = Math.max(-half, Math.min(half, t));
  return s.h + s.bank * tc - crown * Math.abs(tc);
}

export interface Nearest {
  dist: number;
  /** Index of the segment start sample. */
  seg: number;
  /** Fraction along the segment, 0..1. */
  frac: number;
  /** Signed lateral offset, positive = left. */
  t: number;
}

/**
 * Spatial hash of the centreline segments for nearest-point queries
 * (terrain blending, wall clearance, chunk selection).
 */
export class SegmentIndex {
  private readonly cells = new Map<string, number[]>();

  constructor(private readonly plan: RoadPlan, private readonly cell = 25) {
    const n = this.segmentCount;
    for (let i = 0; i < n; i++) {
      const [a, b] = this.ends(i);
      const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
      const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = x + "," + y;
          let list = this.cells.get(k);
          if (!list) this.cells.set(k, (list = []));
          list.push(i);
        }
      }
    }
  }

  get segmentCount(): number {
    const n = this.plan.samples.length;
    return this.plan.closed ? n : n - 1;
  }

  ends(i: number): [Vec2, Vec2] {
    const s = this.plan.samples;
    return [s[i].pos, s[(i + 1) % s.length].pos];
  }

  /** Nearest point on the road within maxDist, or null. Optional filter skips segments. */
  nearest(x: number, y: number, maxDist: number, skip?: (seg: number) => boolean): Nearest | null {
    const c = this.cell;
    const r = Math.ceil(maxDist / c);
    const cx = Math.floor(x / c), cy = Math.floor(y / c);
    let best: Nearest | null = null;
    let bestD2 = maxDist * maxDist;
    const seen = new Set<number>();
    for (let ring = 0; ring <= r; ring++) {
      // Once the closest point found is nearer than this ring can reach, stop.
      if (best && (ring - 1) * c > Math.sqrt(bestD2)) break;
      for (let gx = cx - ring; gx <= cx + ring; gx++) {
        for (let gy = cy - ring; gy <= cy + ring; gy++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== ring) continue;
          const list = this.cells.get(gx + "," + gy);
          if (!list) continue;
          for (const i of list) {
            if (seen.has(i)) continue;
            seen.add(i);
            if (skip?.(i)) continue;
            const [a, b] = this.ends(i);
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L2 = dx * dx + dy * dy || 1e-12;
            const f = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
            const px = a[0] + dx * f, py = a[1] + dy * f;
            const d2 = (x - px) ** 2 + (y - py) ** 2;
            if (d2 < bestD2) {
              bestD2 = d2;
              const L = Math.sqrt(L2);
              // left of travel = positive cross product
              const t = (dx * (y - a[1]) - dy * (x - a[0])) / L;
              best = { dist: Math.sqrt(d2), seg: i, frac: f, t };
            }
          }
        }
      }
    }
    return best;
  }

  /** Interpolated sample values at a nearest-point result. */
  at(n: Nearest): { h: number; bank: number; width: number; kerb: number } {
    const s = this.plan.samples;
    const a = s[n.seg], b = s[(n.seg + 1) % s.length];
    const f = n.frac;
    // Kerb on the side of the road the point is on.
    const side = n.t >= 0 ? 0 : 1;
    const ka = a.kerb?.[side] ?? 0, kb = b.kerb?.[side] ?? 0;
    return { h: a.h + (b.h - a.h) * f, bank: a.bank + (b.bank - a.bank) * f, width: a.width + (b.width - a.width) * f, kerb: ka + (kb - ka) * f };
  }
}
