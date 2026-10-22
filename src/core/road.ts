// The road model: a smoothed centreline sampled every `spacing` metres, with
// a width, a centre height, and a cross-slope (banking) at each sample.
// Everything else (road mesh, terrain, walls, AI line, spawn points) is
// derived from these samples.

import type { Vec2 } from "./geo";
import type { HeightFn } from "./elevation";
import type { BuildOptions } from "./options";
import { dedupe, frames, gaussianSmooth, resample, smoothPath, type PathFrame } from "./polyline";

export interface RoadSample extends PathFrame {
  /** Full asphalt width, metres. */
  width: number;
  /** Centreline surface height, metres. */
  h: number;
  /** Cross-slope, metres of rise per metre to the left (negative = left side lower). */
  bank: number;
}

export interface RoadPlan {
  closed: boolean;
  samples: RoadSample[];
  length: number;
}

/** Width lookup for a point, usually from OSM tags; undefined = no data. */
export type WidthFn = (x: number, y: number) => number | undefined;

/** A closed loop is a route whose start and finish pins are within 30 m. */
export function isLoop(path: Vec2[]): boolean {
  const a = path[0], b = path[path.length - 1];
  return path.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 30;
}

export function planRoad(raw: Vec2[], opts: BuildOptions, widthFn?: WidthFn): RoadPlan {
  let path = dedupe(raw);
  if (path.length < 2) throw new Error("Route has fewer than two distinct points");
  const closed = isLoop(path);
  if (closed) path = path.slice(0, -1).concat([path[0]]);
  // Dense resample, smooth, then resample at the working spacing.
  let dense = resample(path, 1);
  if (closed) dense = dense.slice(0, -1);
  dense = smoothPath(dense, opts.lineSmoothing, 1, closed);
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

  const samples = fr.map((f, i) => ({ ...f, curvature: curv[i], width: widths[i], h: 0, bank: banks[i] }));
  return { closed, samples, length };
}

/** Fills in centre heights from the DEM, smoothed along the road. */
export function applyElevation(plan: RoadPlan, height: HeightFn, opts: BuildOptions): void {
  const raw = plan.samples.map((s) => height(s.pos[0], s.pos[1]));
  const smooth = gaussianSmooth(raw, opts.elevationSmoothing / opts.spacing, plan.closed);
  plan.samples.forEach((s, i) => (s.h = smooth[i]));
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
  at(n: Nearest): { h: number; bank: number; width: number } {
    const s = this.plan.samples;
    const a = s[n.seg], b = s[(n.seg + 1) % s.length];
    const f = n.frac;
    return { h: a.h + (b.h - a.h) * f, bank: a.bank + (b.bank - a.bank) * f, width: a.width + (b.width - a.width) * f };
  }
}
