// Centreline processing: OSM geometry is a coarse polyline with kinks at every
// node, so it is resampled densely, smoothed, and resampled again at the
// spacing the meshes use. Smoothing keeps both ends pinned on open roads and
// wraps around on loops.

import type { Vec2 } from "./geo";

export function cumulative(pts: Vec2[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return out;
}

export function dedupe(pts: Vec2[], minDist = 0.05): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > minDist) out.push(p);
  }
  return out;
}

/** Points every `spacing` metres along the polyline, always including both ends. */
export function resample(pts: Vec2[], spacing: number): Vec2[] {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / spacing));
  const step = total / n;
  const out: Vec2[] = [];
  let seg = 1;
  for (let i = 0; i <= n; i++) {
    const s = i * step;
    while (seg < pts.length - 1 && cum[seg] < s) seg++;
    const t = (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1] || 1);
    const a = pts[seg - 1], b = pts[seg];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Gaussian smoothing of a uniformly spaced series. */
export function gaussianSmooth(values: number[], sigmaSamples: number, closed: boolean): number[] {
  if (sigmaSamples < 0.5) return values.slice();
  const radius = Math.ceil(sigmaSamples * 3);
  const kernel: number[] = [];
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      let j = i + k;
      if (closed) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      const w = kernel[k + radius];
      sum += values[j] * w;
      wsum += w;
    }
    out[i] = sum / wsum;
  }
  return out;
}

/**
 * Smooths a uniformly spaced 2D polyline. On open roads the first and last
 * points stay put and the smoothing fades in over `sigma` near each end, so
 * pins land exactly where they were placed.
 */
export function smoothPath(pts: Vec2[], sigmaMetres: number, spacing: number, closed: boolean): Vec2[] {
  const sigma = sigmaMetres / spacing;
  const xs = gaussianSmooth(pts.map((p) => p[0]), sigma, closed);
  const ys = gaussianSmooth(pts.map((p) => p[1]), sigma, closed);
  const n = pts.length;
  return pts.map((p, i) => {
    if (closed) return [xs[i], ys[i]];
    const edge = Math.min(i, n - 1 - i);
    const w = Math.min(1, edge / Math.max(1, sigma * 2));
    return [p[0] + (xs[i] - p[0]) * w, p[1] + (ys[i] - p[1]) * w];
  });
}

export interface PathFrame {
  pos: Vec2;
  /** Unit tangent. */
  tan: Vec2;
  /** Unit normal pointing left of the driving direction. */
  left: Vec2;
  /** Signed curvature, 1/m, positive turning left. */
  curvature: number;
  /** Distance along the path, m. */
  s: number;
}

export function frames(pts: Vec2[], closed: boolean): PathFrame[] {
  const n = pts.length;
  const cum = cumulative(pts);
  const idx = (i: number) => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  return pts.map((p, i) => {
    const a = pts[idx(i - 1)], b = pts[idx(i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    // Curvature from the circle through the neighbours (Menger curvature).
    let curvature = 0;
    if (closed || (i > 0 && i < n - 1)) {
      const ax = p[0] - a[0], ay = p[1] - a[1], bx = b[0] - p[0], by = b[1] - p[1];
      const crossAB = ax * by - ay * bx;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), lc = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (la * lb * lc > 1e-9) curvature = (2 * crossAB) / (la * lb * lc);
    }
    return { pos: p, tan: [tx, ty], left: [-ty, tx], curvature, s: cum[i] };
  });
}

/** Ramer-Douglas-Peucker simplification, for drawing outlines. */
export function simplify(pts: Vec2[], tolerance: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bestD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
