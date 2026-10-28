// Line markings as their own geometry, laid 15 mm above the asphalt, after
// Australian practice (AS 1742.2), which Japan and the UK broadly share:
//
//  - Edge lines: continuous white, 0.1 m wide, on roads 5.5 m and wider.
//  - Dividing line on two-lane roads: broken (3 m line, 9 m gap) where
//    there is overtaking sight distance; a continuous barrier line on the
//    side of any direction that doesn't have it, so double barrier lines on
//    blind corners and crests.
//  - Raised reflective pavement markers on the dividing line every 24 m.
//
// Traffic keeps left: vehicles travelling forward along the road (A to B)
// are on its left (positive lateral offset).

import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { surfaceHeight, type RoadPlan, type RoadSample } from "./road";
import { ChunkedMesh } from "./scenery";
import { pad } from "./roadMesh";
import type { ImageLine } from "./paintLines";

const LIFT = 0.015;
const LINE = 0.1;
const EYE = 1.15;
/** Overtaking needs this much clear road ahead, metres. */
export const OVERTAKING_SIGHT = 250;
const MIN_TWO_LANE = 5.5;

/**
 * Sight distance ahead of each sample in each direction, metres (capped).
 * Blocked horizontally when the road between bends further than its edge
 * plus 1.5 m from the line of sight, and vertically when the road rises
 * above the line from a driver's eye to a car ahead (both 1.15 m up).
 */
export function sightDistances(plan: RoadPlan, cap = OVERTAKING_SIGHT + 50): { fwd: number[]; back: number[] } {
  const s = plan.samples;
  const n = s.length;
  const spacing = n > 1 ? s[1].s - s[0].s : 2;
  const step = Math.max(1, Math.round(4 / spacing));
  const maxSteps = Math.ceil(cap / spacing);
  const idx = (i: number) => (plan.closed ? ((i % n) + n) % n : i);
  const walk = (i: number, dir: 1 | -1): number => {
    const a = s[i];
    let seen = 0;
    for (let k = step; k <= maxSteps; k += step) {
      const jRaw = i + dir * k;
      if (!plan.closed && (jRaw < 0 || jRaw >= n)) return cap; // the road ends in clear view
      const b = s[idx(jRaw)];
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1];
      const L = Math.hypot(dx, dy) || 1;
      let blocked = false;
      for (let m = step; m < k && !blocked; m += step) {
        const c = s[idx(i + dir * m)];
        const lateral = Math.abs((c.pos[0] - a.pos[0]) * dy - (c.pos[1] - a.pos[1]) * dx) / L;
        if (lateral > c.width / 2 + 1.5) blocked = true;
        const f = m / k;
        if (c.h > a.h + EYE + (b.h - a.h) * f) blocked = true;
      }
      if (blocked) return seen;
      seen = k * spacing;
    }
    return cap;
  };
  const fwd = s.map((_, i) => walk(i, 1));
  const back = s.map((_, i) => walk(i, -1));
  return { fwd, back };
}

/** Fill short gaps and drop short runs in a per-sample mask. */
function tidy(mask: boolean[], spacing: number, gapM: number, runM: number): boolean[] {
  const out = mask.slice();
  const n = out.length;
  const gap = Math.round(gapM / spacing), minRun = Math.round(runM / spacing);
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!out[i]) continue;
    if (last >= 0 && i - last > 1 && i - last <= gap) for (let k = last; k < i; k++) out[k] = true;
    last = i;
  }
  for (let i = 0; i < n;) {
    if (!out[i]) { i++; continue; }
    let j = i;
    while (j < n && out[j]) j++;
    if (j - i < minRun) for (let k = i; k < j; k++) out[k] = false;
    i = j;
  }
  return out;
}

export interface CentrePlan {
  /** Per sample: forward traffic may not overtake. */
  barrierFwd: boolean[];
  /** Per sample: backward traffic may not overtake. */
  barrierBack: boolean[];
}

export function planCentreLine(plan: RoadPlan): CentrePlan {
  const spacing = plan.samples.length > 1 ? plan.samples[1].s - plan.samples[0].s : 2;
  const { fwd, back } = sightDistances(plan);
  return {
    barrierFwd: tidy(fwd.map((d) => d < OVERTAKING_SIGHT), spacing, 40, 30),
    barrierBack: tidy(back.map((d) => d < OVERTAKING_SIGHT), spacing, 40, 30),
  };
}

/** Sample index at or before distance s (open roads clamp, loops wrap). */
function indexAt(plan: RoadPlan, s: number): number {
  const a = plan.samples;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Interpolated sample at distance s. */
function sampleAt(plan: RoadPlan, s: number): RoadSample {
  const a = plan.samples;
  const i = indexAt(plan, s);
  const j = Math.min(a.length - 1, i + 1);
  const p = a[i], q = a[j];
  const f = j === i ? 0 : Math.max(0, Math.min(1, (s - p.s) / (q.s - p.s)));
  const mix = (x: number, y: number) => x + (y - x) * f;
  const tx = mix(p.tan[0], q.tan[0]), ty = mix(p.tan[1], q.tan[1]), tl = Math.hypot(tx, ty) || 1;
  return {
    ...p,
    pos: [mix(p.pos[0], q.pos[0]), mix(p.pos[1], q.pos[1])],
    tan: [tx / tl, ty / tl],
    left: [-ty / tl, tx / tl],
    s,
    h: mix(p.h, q.h),
    bank: mix(p.bank, q.bank),
    width: mix(p.width, q.width),
  };
}

export function buildMarkings(
  plan: RoadPlan,
  opts: BuildOptions,
  /** Distances along the road to leave unmarked (e.g. inside roundabouts). */
  skip: (s: number) => boolean = () => false,
  /** Where an edge line breaks for a side street (side 1 = left). */
  edgeGap: (side: 1 | -1, s: number) => boolean = () => false,
  /**
   * Lines read off the aerial photo, and the samples they speak for. There
   * the photo decides (including "no lines"); elsewhere markings are
   * generated from sight distance.
   */
  image?: { lines: ImageLine[]; covered: (i: number) => boolean },
  /** Marks seen by street-level imagery: s along, t across (+ left). */
  discrete: DiscreteMark[] = [],
): Kn5MeshNode[] {
  const paint = new ChunkedMesh(0);
  const yellow = new ChunkedMesh(0);
  const rrpm = new ChunkedMesh(0);
  const samples = plan.samples;
  const end = plan.closed ? plan.length : samples[samples.length - 1].s;

  /** A stripe from s0 to s1 at lateral offset t(sample), `w` wide. */
  const stripe = (s0: number, s1: number, t: (p: RoadSample) => number, w = LINE, cm = paint) => {
    if (s1 - s0 < 0.2) return;
    const stops = [s0];
    for (let i = indexAt(plan, s0) + 1; i < samples.length && samples[i].s < s1; i++) stops.push(samples[i].s);
    stops.push(s1);
    const mb = cm.next(stops.length * 2);
    const base = mb.vertexCount;
    for (const sd of stops) {
      const p = sampleAt(plan, sd);
      const tc = t(p);
      for (const side of [w / 2, -w / 2]) {
        const tt = tc + side;
        mb.vertex([p.pos[0] + p.left[0] * tt, p.pos[1] + p.left[1] * tt, surfaceHeight(p, tt, opts.crown) + LIFT], side > 0 ? 0 : 1, sd);
        mb.normals!.push(0, 0, 1);
      }
    }
    for (let k = 0; k < stops.length - 1; k++) {
      const a = base + k * 2, b = a + 2;
      // left edge first: back-left, back-right, front-right, front-left
      mb.quad(a, a + 1, b + 1, b);
    }
  };

  /** Runs of s where `on(i)` holds, split around skipped stretches. */
  const runs = (on: (i: number) => boolean): [number, number][] => {
    const out: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= samples.length; i++) {
      const ok = i < samples.length && on(i) && !skip(samples[i].s);
      if (ok && start < 0) start = samples[i].s;
      if (!ok && start >= 0) {
        out.push([start, i < samples.length ? samples[i].s : end]);
        start = -1;
      }
    }
    return out;
  };

  const generated = (i: number) => !image?.covered(i);
  const twoLane = (i: number) => samples[i].width >= MIN_TWO_LANE && generated(i);

  // Lines from the photo, at their measured offsets, dashed in phase with the real ones.
  for (const ln of image?.lines ?? []) {
    const offsetAt = (p: RoadSample) => {
      const i = Math.max(ln.i0, Math.min(ln.i1, indexAt(plan, p.s)));
      return ln.t[i - ln.i0];
    };
    const cm = ln.colour === "yellow" ? yellow : paint;
    for (const [a, b] of runs((i) => i >= ln.i0 && i <= ln.i1)) {
      if (ln.kind === "solid") stripe(a, b, offsetAt, LINE, cm);
      else {
        for (let d = Math.floor((a - ln.phase) / 12) * 12 + ln.phase; d < b; d += 12) {
          stripe(Math.max(a, d), Math.min(b, d + 3), offsetAt, LINE, cm);
        }
      }
    }
  }

  // Edge lines, 0.2 m in from the seal edge.
  for (const side of [1, -1] as const) {
    for (const [a, b] of runs((i) => twoLane(i) && !edgeGap(side, samples[i].s))) {
      stripe(a, b, (p) => side * (p.width / 2 - 0.2));
    }
  }

  // Dividing line.
  const centre = planCentreLine(plan);
  const broken = (a: number, b: number, t: number) => {
    // 3 m line, 9 m gap, phased on distance so the pattern is continuous.
    for (let d = Math.ceil(a / 12) * 12 - 12; d < b; d += 12) stripe(Math.max(a, d), Math.min(b, d + 3), () => t);
  };
  const lineFor = (fwd: boolean, back: boolean) => (i: number) =>
    twoLane(i) && centre.barrierFwd[i] === fwd && centre.barrierBack[i] === back;
  for (const [a, b] of runs(lineFor(false, false))) broken(a, b, 0);
  for (const [a, b] of runs(lineFor(true, true))) {
    stripe(a, b, () => LINE);
    stripe(a, b, () => -LINE);
  }
  // Forward traffic keeps left (positive t): its barrier line sits on that side.
  for (const [a, b] of runs(lineFor(true, false))) {
    stripe(a, b, () => LINE);
    broken(a, b, -LINE);
  }
  for (const [a, b] of runs(lineFor(false, true))) {
    stripe(a, b, () => -LINE);
    broken(a, b, LINE);
  }

  // Stop lines, give-way lines and zebra crossings where street-level imagery saw them.
  /** A paint patch from s0..s1 along and t0..t1 across, draped on the road. */
  const patch = (s0: number, s1: number, t0: number, t1: number) => {
    const steps = 3;
    // Columns every half metre or so across, so the paint follows the crown instead of sinking into it.
    const hi = Math.max(t0, t1), lo = Math.min(t0, t1);
    const cols = Math.max(1, Math.ceil((hi - lo) / 0.5));
    const mb = paint.next((steps + 1) * (cols + 1));
    const base = mb.vertexCount;
    for (let k = 0; k <= steps; k++) {
      const p = sampleAt(plan, s0 + ((s1 - s0) * k) / steps);
      for (let c = 0; c <= cols; c++) {
        const t = hi - ((hi - lo) * c) / cols;
        mb.vertex([p.pos[0] + p.left[0] * t, p.pos[1] + p.left[1] * t, surfaceHeight(p, t, opts.crown) + LIFT], 0, 0);
        mb.normals!.push(0, 0, 1);
      }
    }
    const row = cols + 1;
    for (let k = 0; k < steps; k++) {
      for (let c = 0; c < cols; c++) {
        const a = base + k * row + c, b = a + row;
        mb.quad(a, a + 1, b + 1, b);
      }
    }
  };
  /** Centre of the lane a lateral offset falls in, from the photo's lines where it has them. */
  const laneCentre = (sd: number, t: number): number => {
    const i = indexAt(plan, sd);
    const half = samples[i].width / 2;
    const side = t >= 0 ? 1 : -1;
    const bounds = [0, side * half];
    for (const ln of image?.lines ?? []) {
      if (i < ln.i0 || i > ln.i1) continue;
      const lt = ln.t[i - ln.i0];
      if (lt * side > 0.5 && lt * side < half - 0.5) bounds.push(lt);
    }
    bounds.sort((a, b) => a - b);
    for (let k = 0; k < bounds.length - 1; k++) {
      if (t >= bounds[k] && t <= bounds[k + 1] && bounds[k + 1] - bounds[k] < 4.6) return (bounds[k] + bounds[k + 1]) / 2;
    }
    // No lane lines to go by: lanes of about 3.4 m across this side.
    const lanes = Math.max(1, Math.round(half / 3.4));
    const w = half / lanes;
    const k = Math.max(0, Math.min(lanes - 1, Math.floor(Math.abs(t) / w)));
    return side * (k + 0.5) * w;
  };
  /**
   * Strokes and arrowheads in a mark's own frame (a along its direction of
   * travel, c across, + left), draped onto the road with the tail at sd,
   * centred on tc. Marks for the other direction (right of the
   * centreline) are turned round.
   */
  const drape = (sd: number, tc: number, g: Glyph) => {
    const dir = tc >= 0 ? 1 : -1;
    const put = (mb: MeshBuilder, a: number, c: number) => {
      const p = sampleAt(plan, sd + dir * a);
      const t = tc + dir * c;
      mb.vertex([p.pos[0] + p.left[0] * t, p.pos[1] + p.left[1] * t, surfaceHeight(p, t, opts.crown) + LIFT], 0, 0);
      mb.normals!.push(0, 0, 1);
    };
    for (const line of g.lines) {
      for (let k = 0; k < line.length - 1; k++) {
        const [a0, c0] = line[k], [a1, c1] = line[k + 1];
        const L = Math.hypot(a1 - a0, c1 - c0) || 1;
        const da = (a1 - a0) / L, dc = (c1 - c0) / L;
        // Run on half a stroke at each end so corners close up.
        const e = g.width / 2, na = -dc * e, nc = da * e;
        const pa = a0 - da * e, pc = c0 - dc * e, qa = a1 + da * e, qc = c1 + dc * e;
        const mb = paint.next(4);
        const b = mb.vertexCount;
        put(mb, pa - na, pc - nc);
        put(mb, qa - na, qc - nc);
        put(mb, qa + na, qc + nc);
        put(mb, pa + na, pc + nc);
        mb.quad(b, b + 1, b + 2, b + 3);
      }
    }
    for (const h of g.heads) {
      const [a, c] = h.at, [da, dc] = h.dir;
      const mb = paint.next(3);
      const b = mb.vertexCount;
      put(mb, a + dc * HEAD_HALF, c - da * HEAD_HALF);
      put(mb, a + da * HEAD_LEN, c + dc * HEAD_LEN);
      put(mb, a - dc * HEAD_HALF, c + da * HEAD_HALF);
      mb.tri(b, b + 1, b + 2);
    }
  };

  for (const d of discrete) {
    if (skip(d.s) || d.s < 1 || d.s > end - 1) continue;
    const half = sampleAt(plan, d.s).width / 2 - 0.2;
    const side = d.t >= 0 ? 1 : -1;
    if (d.kind === "start") patch(d.s - 0.2, d.s + 0.2, -half, half);
    else if (d.kind === "finish") {
      // Chequered: two rows of 0.5 m squares right across.
      for (let row = 0; row < 2; row++) {
        for (let t = -half, k = 0; t < half - 0.05; t += 0.5, k++) {
          if ((k + row) % 2 === 0) patch(d.s - 0.5 + row * 0.5, d.s + row * 0.5, t, Math.min(half, t + 0.5));
        }
      }
    } else if (d.kind === "stop") patch(d.s - 0.15, d.s + 0.15, 0, side * half);
    else if (d.kind === "giveway") {
      for (let t = 0.1; t < half; t += 1.2) patch(d.s - 0.15, d.s + 0.15, side * t, side * Math.min(half, t + 0.6));
    } else if (d.kind === "zebra") {
      // Zebra: 0.5 m bars across the whole road, 1 m apart, 3 m deep.
      for (let t = -half; t < half - 0.4; t += 1) patch(d.s - 1.5, d.s + 1.5, t, t + 0.5);
    } else {
      const g = d.kind === "arrow" ? arrowGlyph(d.shape) : d.kind === "symbol" ? symbolGlyph(d.shape) : textGlyph(d.shape);
      if (!g) continue;
      // Centred on where it was seen, kept on the road; the tail is where its traffic meets it first.
      const s0 = Math.max(1, Math.min(end - 1 - g.length, d.s - g.length / 2));
      drape(side > 0 ? s0 : s0 + g.length, laneCentre(d.s, d.t), g);
    }
  }

  // Raised pavement markers between the dividing lines, every 24 m.
  for (let d = 24; d < end - 12; d += 24) {
    const i = indexAt(plan, d);
    if (!twoLane(i) || skip(d)) continue;
    const p = sampleAt(plan, d);
    const mb = rrpm.next(20);
    const z = surfaceHeight(p, 0, opts.crown);
    stud(mb, p, z);
  }

  return [
    ...paint.all().map((m, i) => m.toKn5(`MARKINGS_${pad(i)}`, "paint", { castShadows: false })),
    ...yellow.all().map((m, i) => m.toKn5(`MARKINGS_Y_${pad(i)}`, "paint_yellow", { castShadows: false })),
    ...rrpm.all().map((m, i) => m.toKn5(`RRPM_${pad(i)}`, "rrpm", { castShadows: false })),
  ];
}

/** Transverse marks and symbols seen by street-level imagery: s along, t across (+ left). */
export interface DiscreteMark {
  s: number;
  t: number;
  kind: "stop" | "giveway" | "zebra" | "arrow" | "text" | "symbol" | "start" | "finish";
  /** Arrow: left, right, straight, split-left-or-straight, ...; text: the characters; symbol: bicycle. */
  shape?: string;
}

/** A painted symbol: strokes and arrowheads, a along the direction of travel from its tail, c across (+ left). */
export interface Glyph {
  lines: [number, number][][];
  heads: { at: [number, number]; dir: [number, number] }[];
  width: number;
  length: number;
}

const HEAD_LEN = 1.2;
const HEAD_HALF = 0.36;

const unit = (a: number, c: number): [number, number] => {
  const l = Math.hypot(a, c) || 1;
  return [a / l, c / l];
};

/**
 * Pavement arrows, elongated as they are painted so they read from a
 * driver's eye: 5 m long, the turn branches reaching about a metre across.
 */
export function arrowGlyph(shape = "straight"): Glyph | null {
  const straight = { line: [[0, 0], [3.8, 0]] as [number, number][], head: { at: [3.8, 0] as [number, number], dir: [1, 0] as [number, number] } };
  const turn = (side: 1 | -1, from: number) => {
    const end: [number, number] = [from + 1.0, side * 0.55];
    return { line: [[from, 0], end] as [number, number][], head: { at: end, dir: unit(1.0, side * 0.55) } };
  };
  const parts = {
    straight: [straight],
    left: [{ line: [[0, 0], [2.4, 0]] as [number, number][], head: null }, turn(1, 2.4)],
    right: [{ line: [[0, 0], [2.4, 0]] as [number, number][], head: null }, turn(-1, 2.4)],
    "split-left-or-straight": [straight, turn(1, 1.6)],
    "split-right-or-straight": [straight, turn(-1, 1.6)],
    "split-left-or-right": [{ line: [[0, 0], [2.4, 0]] as [number, number][], head: null }, turn(1, 2.4), turn(-1, 2.4)],
  }[shape];
  if (!parts) return null;
  return {
    lines: parts.map((p) => p.line),
    heads: parts.flatMap((p) => (p.head ? [p.head] : [])),
    width: 0.2,
    length: 5,
  };
}

/** Stroke digits in a unit box: x across (0 = left as read), y along (0 = nearest). */
const DIGITS: Record<string, [number, number][][]> = {
  "0": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  "1": [[[0.5, 0], [0.5, 1], [0.2, 0.8]]],
  "2": [[[0, 1], [1, 1], [1, 0.5], [0, 0.5], [0, 0], [1, 0]]],
  "3": [[[0, 1], [1, 1], [1, 0], [0, 0]], [[0.2, 0.5], [1, 0.5]]],
  "4": [[[0, 1], [0, 0.45], [1, 0.45]], [[0.75, 1], [0.75, 0]]],
  "5": [[[1, 1], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [0, 0]]],
  "6": [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]]],
  "7": [[[0, 1], [1, 1], [0.35, 0]]],
  "8": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[0, 0.5], [1, 0.5]]],
  "9": [[[1, 0.5], [0, 0.5], [0, 1], [1, 1], [1, 0], [0, 0]]],
};

/** Stroke letters in a unit box (x right, y up = away from the driver). */
const LETTERS: Record<string, [number, number][][]> = {
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.2, 0.4], [0.8, 0.4]]],
  B: [[[0, 0], [0, 1], [0.8, 1], [1, 0.85], [1, 0.62], [0.8, 0.5], [0, 0.5]], [[0.8, 0.5], [1, 0.38], [1, 0.12], [0.8, 0], [0, 0]]],
  C: [[[1, 1], [0, 1], [0, 0], [1, 0]]],
  D: [[[0, 0], [0, 1], [0.65, 1], [1, 0.7], [1, 0.3], [0.65, 0], [0, 0]]],
  E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, 0.5], [0.75, 0.5]]],
  F: [[[1, 1], [0, 1], [0, 0]], [[0, 0.5], [0.75, 0.5]]],
  G: [[[1, 1], [0, 1], [0, 0], [1, 0], [1, 0.5], [0.5, 0.5]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.5, 0], [0.5, 1]]],
  J: [[[1, 1], [1, 0], [0, 0], [0, 0.3]]],
  K: [[[0, 0], [0, 1]], [[1, 1], [0, 0.45], [1, 0]]],
  L: [[[0, 1], [0, 0], [1, 0]]],
  M: [[[0, 0], [0, 1], [0.5, 0.5], [1, 1], [1, 0]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  O: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  P: [[[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]]],
  R: [[[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5], [1, 0]]],
  S: [[[1, 1], [0, 1], [0, 0.5], [1, 0.5], [1, 0], [0, 0]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  U: [[[0, 1], [0, 0], [1, 0], [1, 1]]],
  V: [[[0, 1], [0.5, 0], [1, 1]]],
  W: [[[0, 1], [0.25, 0], [0.5, 0.6], [0.75, 0], [1, 1]]],
  X: [[[0, 0], [1, 1]], [[0, 1], [1, 0]]],
  Y: [[[0, 1], [0.5, 0.5], [1, 1]], [[0.5, 0.5], [0.5, 0]]],
  Z: [[[0, 1], [1, 1], [0, 0], [1, 0]]],
};

/**
 * Painted numbers and words (speed limits, SLOW, BUS, SCHOOL, KEEP CLEAR):
 * elongated characters 3 m tall, squeezed to fit a lane. Words separated by
 * "-" stack along the road, the first nearest the driver.
 */
export function textGlyph(text = ""): Glyph | null {
  const words = text.toUpperCase().split(/[-\s]+/).filter(Boolean);
  if (!words.length || words.length > 2) return null;
  const strokes = (ch: string) => DIGITS[ch] ?? LETTERS[ch];
  if (words.some((w) => w.length > 8 || [...w].some((ch) => !strokes(ch)))) return null;
  const H = 3, rowGap = 1.5, LANE = 2.8;
  const lines: [number, number][][] = [];
  let narrowest = 0.75;
  words.forEach((word, row) => {
    const chars = [...word];
    const gap = /^\d+$/.test(word) ? 0.35 : 0.2;
    const W = Math.min(0.75, (LANE - gap * (chars.length - 1)) / chars.length);
    narrowest = Math.min(narrowest, W);
    const total = chars.length * W + (chars.length - 1) * gap;
    const y0 = row * (H + rowGap);
    chars.forEach((ch, k) => {
      const x0 = k * (W + gap);
      for (const pl of strokes(ch)) lines.push(pl.map(([x, y]) => [y0 + y * H, total / 2 - (x0 + x * W)]));
    });
  });
  return { lines, heads: [], width: narrowest < 0.5 ? 0.12 : 0.18, length: H * words.length + rowGap * (words.length - 1) };
}

/**
 * Painted symbols. A bicycle: drawn side-on, standing up the lane for the
 * approaching driver (its height along the road, stretched like road text),
 * about 1.3 m across and 2 m long.
 */
export function symbolGlyph(shape = ""): Glyph | null {
  if (shape !== "bicycle") return null;
  // Bike space: x across the bike (rear -, front +), y up; mapped to a = along, c = across.
  const map = ([x, y]: [number, number]): [number, number] => [y * 1.6, -x * 0.62];
  const wheel = (cx: number): [number, number][] =>
    Array.from({ length: 17 }, (_, k) => map([cx + Math.cos((k / 16) * Math.PI * 2) * 0.38, 0.38 + Math.sin((k / 16) * Math.PI * 2) * 0.38]));
  const rear: [number, number] = [-0.62, 0.38], front: [number, number] = [0.62, 0.38], crank: [number, number] = [0, 0.38];
  const seat: [number, number] = [-0.18, 0.95], head: [number, number] = [0.48, 1.0];
  const lines: [number, number][][] = [
    wheel(-0.62),
    wheel(0.62),
    [rear, crank, seat, rear].map(map),
    [seat, head, crank].map(map),
    [head, front].map(map),
    [[-0.32, 1.0], [-0.04, 1.0]].map((p) => map(p as [number, number])), // saddle
    [head, [0.36, 1.14]].map((p) => map(p as [number, number])), // handlebar
  ];
  return { lines, heads: [], width: 0.08, length: Math.max(...lines.flat().map((p) => p[0])) };
}

/** A 100 x 100 x 20 mm marker on the centreline. */
function stud(mb: MeshBuilder, p: RoadSample, z: number): void {
  const hx = p.tan[0] * 0.05, hy = p.tan[1] * 0.05, lx = p.left[0] * 0.05, ly = p.left[1] * 0.05;
  const c: [number, number][] = [
    [p.pos[0] - hx - lx, p.pos[1] - hy - ly],
    [p.pos[0] + hx - lx, p.pos[1] + hy - ly],
    [p.pos[0] + hx + lx, p.pos[1] + hy + ly],
    [p.pos[0] - hx + lx, p.pos[1] - hy + ly],
  ];
  for (let k = 0; k < 4; k++) {
    const a = c[k], b = c[(k + 1) % 4];
    const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1;
    const n: Vec3 = [ey / el, -ex / el, 0.3];
    const i = mb.vertexCount;
    mb.vertex([a[0], a[1], z], 0, 1);
    mb.vertex([b[0], b[1], z], 1, 1);
    mb.vertex([b[0], b[1], z + 0.02], 1, 0);
    mb.vertex([a[0], a[1], z + 0.02], 0, 0);
    for (let j = 0; j < 4; j++) mb.normals!.push(...n);
    mb.quad(i, i + 1, i + 2, i + 3);
  }
  const i = mb.vertexCount;
  for (const q of c) {
    mb.vertex([q[0], q[1], z + 0.02], 0, 0);
    mb.normals!.push(0, 0, 1);
  }
  mb.quad(i, i + 1, i + 2, i + 3);
}
