// Road tracing from aerial imagery: where the asphalt really is, and how
// wide. OSM centrelines are often a metre or two off the photo and their
// widths are guesses; tracing fixes both wherever the road can be seen.
//
// The imagery is "straightened" along the route: one row per centreline
// sample, one column every 0.1 m across. Each row's middle band teaches what
// this road's asphalt looks like (a running median, so patches, shade and
// surface changes are followed). A pixel is road when its colour (chroma)
// matches and its brightness is within shadow-to-faded range; white paint
// counts as road. Each row's road run, walking out from the centre and
// bridging cars and paint gaps, gives the two edges.
//
// Only stretches that read clearly as asphalt for 20 m or more are trusted.
// Under tree canopy or in deep shadow the road can't be seen, and the build
// eases back to the OSM line and width there.

import type { Vec2 } from "./geo";
import { frames, gaussianSmooth } from "./polyline";
import type { RoadPlan } from "./road";

/** Colour of the aerial photo at a local point, 0..1 RGB, or null where there is none. */
export type RasterSampler = (x: number, y: number) => [number, number, number] | null;

/**
 * The photo as it should look rather than as detection reads it: a sampler
 * may carry a colour-balanced `display` variant (see services/raster).
 */
export function displayOf(r: RasterSampler): RasterSampler {
  return (r as RasterSampler & { display?: RasterSampler }).display ?? r;
}

export interface TraceResult {
  /** Lateral shift of the centreline to the traced road, metres (+ left), per sample. */
  offset: number[];
  /** Traced asphalt width, metres, per sample (NaN where not traced). */
  width: number[];
  /** 0..1 how much to trust the trace at each sample. */
  conf: number[];
  /** Fraction of samples traced directly. */
  coverage: number;
}

const DT = 0.1;
/** A traced road this much wider than the mapped street has taken in something else, metres. */
const WIDER = 6;
/** The trace never wanders further than this from the mapped line, metres. */
const MAX_DRIFT = 5;

interface Pixel {
  l: number;
  c: [number, number, number];
  exg: number;
  sat: number;
  ok: boolean;
}

function pixel(rgb: [number, number, number] | null): Pixel {
  if (!rgb) return { l: 0, c: [0, 0, 0], exg: 0, sat: 0, ok: false };
  const [r, g, b] = rgb;
  const sum = r + g + b + 1e-4;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { l: sum / 3, c: [r / sum, g / sum, b / sum], exg: (2 * g - r - b) / sum, sat: max > 0 ? (max - min) / max : 0, ok: true };
}

function median(v: number[]): number {
  if (!v.length) return NaN;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Straightened strip: rows[i][j] at lateral offset t = (j - half) * DT. */
export function rectify(plan: RoadPlan, raster: RasterSampler, halfWidth: number): { rows: Pixel[][]; half: number } {
  const half = Math.round(halfWidth / DT);
  const rows = plan.samples.map((s) => {
    const row: Pixel[] = [];
    for (let j = -half; j <= half; j++) {
      const t = j * DT;
      row.push(pixel(raster(s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t)));
    }
    return row;
  });
  return { rows, half };
}

export function traceRoad(plan: RoadPlan, raster: RasterSampler, osmWidths?: number[]): TraceResult {
  const n = plan.samples.length;
  const widths = osmWidths ?? plan.samples.map((s) => s.width);
  const reach = Math.max(14, Math.max(...widths) * 1.4);
  const { rows, half } = rectify(plan, raster, reach);
  const m = rows[0]?.length ?? 0;

  // Asphalt reference per row from the middle 2.4 m: not green, not
  // saturated, not paint-bright. A row only counts if most of it qualifies.
  const band = 12;
  const refL: number[] = [], refC: [number, number, number][] = [], valid: boolean[] = [];
  for (const row of rows) {
    const mid = row.slice(half - band, half + band + 1);
    const ls = mid.map((p) => p.l);
    const lMed = median(ls);
    const ok = mid.filter((p) => p.ok && p.exg < 0.04 && p.sat < 0.25 && p.l < lMed + 0.12);
    valid.push(ok.length >= 18);
    refL.push(median(ok.map((p) => p.l)));
    refC.push([0, 1, 2].map((k) => median(ok.map((p) => p.c[k]))) as [number, number, number]);
  }
  const W = 25;
  const rL: number[] = [], rC: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const idx: number[] = [];
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) if (valid[k]) idx.push(k);
    if (idx.length < 5) {
      rL.push(NaN);
      rC.push([NaN, NaN, NaN]);
      continue;
    }
    rL.push(median(idx.map((k) => refL[k])));
    rC.push([0, 1, 2].map((c) => median(idx.map((k) => refC[k][c]))) as [number, number, number]);
  }

  const left = new Array<number>(n).fill(NaN), right = new Array<number>(n).fill(NaN);
  let centre = half;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(rL[i])) continue;
    const road = rows[i].map((p) => {
      if (!p.ok) return false;
      const ratio = p.l / Math.max(1e-3, rL[i]);
      if (ratio > 1.55 && p.sat < 0.22) return true; // paint
      const dc = Math.hypot(p.c[0] - rC[i][0], p.c[1] - rC[i][1], p.c[2] - rC[i][2]);
      return dc < 0.03 && ratio > 0.4 && ratio < 1.45 && p.exg < 0.04;
    });
    // Start from the road pixel nearest the running centre estimate.
    let start = -1;
    for (let d = 0; d <= 15 && start < 0; d++) {
      if (road[centre - d]) start = centre - d;
      else if (road[centre + d]) start = centre + d;
    }
    if (start < 0) continue;
    const walk = (dir: 1 | -1): number => {
      let k = start, last = start;
      while (k + dir >= 0 && k + dir < m) {
        k += dir;
        if (road[k]) {
          last = k;
          continue;
        }
        // A gap (a car, a shadow edge): bridge it if solid road follows.
        let g = k;
        while (g >= 0 && g < m && !road[g] && Math.abs(g - k) < 16) g += dir;
        let solid = g >= 0 && g < m && road[g];
        for (let j = 1; solid && j < 6; j++) solid = !!road[Math.min(m - 1, Math.max(0, g + dir * j))];
        if (!solid) break;
        k = last = g;
      }
      return last;
    };
    const lo = walk(-1), hi = walk(1);
    const w = (hi - lo) * DT;
    let inRun = 0;
    for (let k = lo; k <= hi; k++) if (road[k]) inRun++;
    // Not the road's edges: a run that carries on out of view (grey roofs,
    // a car park), or one far wider than the street (parking bays alongside).
    // Following those walks the trace off the road, a little more each row.
    const open = lo <= 1 || hi >= m - 2;
    const tooWide = w > widths[i] + WIDER;
    if (!open && !tooWide && w >= 3 && w <= 22 && inRun / (hi - lo + 1) > 0.75) {
      left[i] = (hi - half) * DT; // +t is left
      right[i] = (lo - half) * DT;
      const drift = Math.round(MAX_DRIFT / DT);
      centre = Math.max(half - drift, Math.min(half + drift, Math.round((lo + hi) / 2 * 0.3 + centre * 0.7)));
    }
  }

  // Trust only runs of 10+ traced samples (20 m).
  for (let i = 0; i < n;) {
    if (Number.isNaN(left[i])) { i++; continue; }
    let j = i;
    while (j < n && !Number.isNaN(left[j])) j++;
    if (j - i < 10) for (let k = i; k < j; k++) left[k] = right[k] = NaN;
    i = j;
  }
  const traced = left.map((v) => !Number.isNaN(v));
  const coverage = traced.filter(Boolean).length / Math.max(1, n);

  // Robust smoothing: running median (30 m) through the traced samples, then Gaussian.
  const robust = (v: number[]): number[] => {
    const med = v.map((_, i) => {
      const w: number[] = [];
      for (let k = Math.max(0, i - 12); k <= Math.min(n - 1, i + 12); k++) if (traced[k]) w.push(v[k]);
      return w.length >= 4 ? median(w) : NaN;
    });
    // Fill gaps by holding the nearest traced value (confidence takes it back to OSM there).
    let last = NaN;
    const filled = med.map((x) => (Number.isNaN(x) ? last : (last = x)));
    last = NaN;
    for (let i = n - 1; i >= 0; i--) {
      if (!Number.isNaN(med[i])) last = med[i];
      else if (Number.isNaN(filled[i])) filled[i] = last;
    }
    return gaussianSmooth(filled.map((x) => (Number.isNaN(x) ? 0 : x)), 4, plan.closed);
  };
  const L = robust(left), R = robust(right);

  // Confidence: 1 where traced, fading to 0 over 20 m (10 samples) away from it.
  const dist = traced.map((t) => (t ? 0 : Infinity));
  for (let i = 1; i < n; i++) dist[i] = Math.min(dist[i], dist[i - 1] + 1);
  for (let i = n - 2; i >= 0; i--) dist[i] = Math.min(dist[i], dist[i + 1] + 1);
  const conf = gaussianSmooth(dist.map((d) => Math.max(0, 1 - d / 10)), 3, plan.closed).map((c) => Math.max(0, Math.min(1, c)));

  const offset = L.map((l, i) => {
    const o = (l + R[i]) / 2;
    return Math.max(-6, Math.min(6, o)) * conf[i];
  });
  const width = L.map((l, i) => (conf[i] > 0 ? Math.max(3, Math.min(20, l - R[i])) : NaN));
  // The line itself must stay smooth: a long blur, then a cap on how fast it may drift sideways.
  const smooth = gaussianSmooth(offset, 8, plan.closed);
  const spacing = n > 1 ? plan.samples[1].s - plan.samples[0].s : 2;
  const maxStep = 0.06 * spacing;
  for (let i = 1; i < n; i++) smooth[i] = Math.max(smooth[i - 1] - maxStep, Math.min(smooth[i - 1] + maxStep, smooth[i]));
  for (let i = n - 2; i >= 0; i--) smooth[i] = Math.max(smooth[i + 1] - maxStep, Math.min(smooth[i + 1] + maxStep, smooth[i]));
  return { offset: smooth, width, conf, coverage };
}

/**
 * Moves the centreline onto the traced road and takes its width, blending
 * to the OSM line and width by confidence. Roundabout samples stay on their
 * circle.
 */
export function applyTrace(plan: RoadPlan, tr: TraceResult, onRing: (i: number) => boolean): void {
  const s = plan.samples;
  const pts: Vec2[] = s.map((p, i) => {
    if (onRing(i)) return p.pos;
    const o = tr.offset[i];
    return [p.pos[0] + p.left[0] * o, p.pos[1] + p.left[1] * o];
  });
  const fr = frames(pts, plan.closed);
  const curv = gaussianSmooth(fr.map((f) => f.curvature), 4, plan.closed);
  fr.forEach((f, i) => {
    const p = s[i];
    p.pos = f.pos;
    p.tan = f.tan;
    p.left = f.left;
    p.s = f.s;
    p.curvature = curv[i];
    if (!onRing(i) && !Number.isNaN(tr.width[i])) p.width = p.width + (tr.width[i] - p.width) * tr.conf[i];
  });
  const last = s[s.length - 1];
  plan.length = plan.closed ? last.s + Math.hypot(s[0].pos[0] - last.pos[0], s[0].pos[1] - last.pos[1]) : last.s;
  for (const rb of plan.roundabouts) {
    const near = (sd: number) => s.reduce((a, p) => (Math.abs(p.s - sd) < Math.abs(a.s - sd) ? p : a)).s;
    rb.sIn = near(rb.sIn);
    rb.sOut = near(rb.sOut);
  }
}
