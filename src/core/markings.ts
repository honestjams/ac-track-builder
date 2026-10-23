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
