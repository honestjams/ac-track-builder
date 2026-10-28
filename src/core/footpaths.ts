// Footpaths and driveway crossovers: the concrete in an Australian nature
// strip. From the driver's seat the aerial photo on the strip is a blur;
// these are crisp concrete slabs where the photo shows them.
//
// Behind each kerbed edge the photo is read across the strip, out to 7 m
// past the kerb, in 10 cm steps. Concrete is pale, grey and not green. A
// footpath is a band of it 0.9-2.4 m wide that holds its place along the
// street (gaps for a driveway, a tree's shadow or a parked car are
// bridged); a crossover is concrete right across from the kerb to the
// property line, for the width of a driveway.
//
// Both are off the road for the physics (STREET: concrete, but not track),
// and stand a few centimetres proud of the grass with a small edge.

import type { Piece } from "./furniture";
import type { Kn5MeshNode } from "./kn5";
import { KERB_BACK, KERB_H, LAYBACK } from "./kerbs";
import { MeshBuilder } from "./mesh";
import type { RoadPlan, RoadSample } from "./road";
import { chunkRanges, pad } from "./roadMesh";
import type { RasterSampler } from "./trace";

const DU = 0.1;
/** How far past the road edge the photo is read, metres. */
const REACH = 7;
const PATH_MIN = 0.9, PATH_MAX = 2.4;
/** A footpath run must be at least this long, metres, and gaps up to GAP are bridged. */
const RUN = 20, GAP = 8;
/** A crossover is concrete over at least this share of the strip... */
const ACROSS = 0.75;
/** ...for this long along the street, metres. */
const DRIVE_MIN = 2.5, DRIVE_MAX = 9;
const PROUD = 0.04;

export interface Band {
  /** Offsets from the road edge, metres. */
  d0: number;
  d1: number;
}

export interface VergeConcrete {
  /** Footpath band per sample, [left, right]; null where there is none. */
  paths: [(Band | null)[], (Band | null)[]];
  /** Crossovers: sample range and side, reaching from the kerb to `d1`. */
  drives: { i0: number; i1: number; side: 1 | -1; d1: number }[];
}

function isConcrete(c: [number, number, number] | null): boolean {
  if (!c) return false;
  const [r, g, b] = c;
  const l = (r + g + b) / 3, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  return l > 0.5 && sat < 0.16 && (2 * g - r - b) / (r + g + b + 1e-4) < 0.02;
}

/** Concrete or not at each step across the verge (offsets from the road edge), averaged over 1 m along. */
function profile(s: RoadSample, side: 1 | -1, raster: RasterSampler): boolean[] {
  const half = s.width / 2;
  const n = Math.round(REACH / DU);
  const out: boolean[] = [];
  for (let j = 0; j < n; j++) {
    const t = (half + j * DU) * side;
    let hits = 0;
    for (const a of [-0.5, 0, 0.5]) {
      const x = s.pos[0] + s.left[0] * t + s.tan[0] * a, y = s.pos[1] + s.left[1] * t + s.tan[1] * a;
      if (isConcrete(raster(x, y))) hits++;
    }
    out.push(hits >= 2);
  }
  return out;
}

/**
 * Reads footpaths and crossovers off the photo along kerbed edges.
 * `blocked` rules out spots on another street.
 */
export function readVerge(
  plan: RoadPlan,
  raster: RasterSampler,
  kerbs: [number[], number[]],
  stripOuter: number,
  blocked: (x: number, y: number) => boolean = () => false,
): VergeConcrete {
  const n = plan.samples.length;
  const spacing = n > 1 ? plan.samples[1].s - plan.samples[0].s : 2;
  const paths: [(Band | null)[], (Band | null)[]] = [new Array(n).fill(null), new Array(n).fill(null)];
  const drives: VergeConcrete["drives"] = [];
  const j0 = Math.ceil((KERB_BACK + 0.2) / DU);
  for (const [k, side] of [[0, 1], [1, -1]] as const) {
    const cand: (Band | null)[] = new Array(n).fill(null);
    const across: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (!kerbs[k][i]) continue;
      const s = plan.samples[i];
      const far = s.pos[0] + s.left[0] * (s.width / 2 + REACH) * side, farY = s.pos[1] + s.left[1] * (s.width / 2 + REACH) * side;
      if (blocked(far, farY)) continue;
      const p = profile(s, side, raster);
      // Concrete right across the strip: a crossover.
      const strip = p.slice(j0, Math.round(stripOuter / DU));
      across[i] = strip.length > 4 && strip.filter(Boolean).length / strip.length >= ACROSS;
      // The first band of path width past the kerb.
      for (let j = j0; j < p.length;) {
        if (!p[j]) { j++; continue; }
        let e = j;
        while (e < p.length && (p[e] || (e + 1 < p.length && p[e + 1]))) e++;
        const w = (e - j) * DU;
        if (w >= PATH_MIN && w <= PATH_MAX && e < p.length) {
          cand[i] = { d0: j * DU, d1: e * DU };
          break;
        }
        j = e;
      }
    }

    // Crossovers: short runs of concrete across the strip.
    for (let i = 0; i < n;) {
      if (!across[i]) { i++; continue; }
      let e = i;
      while (e < n && across[e]) e++;
      const len = (e - i) * spacing;
      if (len >= DRIVE_MIN && len <= DRIVE_MAX) drives.push({ i0: i, i1: e - 1, side, d1: stripOuter });
      i = e;
    }

    // Footpath: candidates that agree with their neighbours, in long runs.
    const win = Math.round(RUN / 2 / spacing);
    const steady = cand.map((c, i) => {
      if (!c) return null;
      const near = cand.slice(Math.max(0, i - win), i + win + 1).filter((q): q is Band => !!q);
      if (near.length < win) return null;
      const mid = median(near.map((q) => (q.d0 + q.d1) / 2));
      return Math.abs((c.d0 + c.d1) / 2 - mid) < 0.5 ? c : null;
    });
    const gap = Math.round(GAP / spacing), min = Math.round(RUN / spacing);
    for (let i = 0; i < n;) {
      if (!steady[i]) { i++; continue; }
      // Extend over short gaps.
      let e = i, last = i;
      while (e < n && (steady[e] || (e - last <= gap && kerbs[k][e]))) {
        if (steady[e]) last = e;
        e++;
      }
      if (last - i + 1 >= min) {
        const run = steady.slice(i, last + 1).filter((q): q is Band => !!q);
        const d0 = median(run.map((q) => q.d0)), d1 = median(run.map((q) => q.d1));
        for (let q = i; q <= last; q++) paths[k][q] = { d0, d1 };
      }
      i = last + 1;
    }
  }
  return { paths, drives };
}

/** Per-sample kerb laybacks ([left, right]): 1 across each crossover. */
export function laybacks(n: number, vc: VergeConcrete): [number[], number[]] {
  const out: [number[], number[]] = [new Array(n).fill(0), new Array(n).fill(0)];
  for (const d of vc.drives) for (let i = d.i0; i <= d.i1; i++) out[d.side === 1 ? 0 : 1][i] = 1;
  return out;
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Concrete slabs for the footpaths and crossovers. `groundAt` is the height
 * of whatever is underneath (nature strip or terrain) at a local point.
 */
export function buildVergeConcrete(
  plan: RoadPlan,
  vc: VergeConcrete,
  groundAt: (x: number, y: number, fromEdge: number, s: RoadSample, side: 1 | -1) => number,
): Kn5MeshNode[] {
  const out: Kn5MeshNode[] = [];
  const at = (s: RoadSample, side: 1 | -1, d: number): [number, number, number] => {
    const t = (s.width / 2 + d) * side;
    const x = s.pos[0] + s.left[0] * t, y = s.pos[1] + s.left[1] * t;
    return [x, y, groundAt(x, y, d, s, side) + PROUD];
  };
  // Footpaths, chunked along the road like the rest of it.
  for (const [c0, c1] of chunkRanges(plan)) {
    const mb = new MeshBuilder();
    for (const [k, side] of [[0, 1], [1, -1]] as const) {
      let prev: number | null = null;
      for (let i = c0; i <= c1 && i < plan.samples.length; i++) {
        const band = vc.paths[k][i];
        if (!band || prev === null || !vc.paths[k][prev]) {
          prev = band ? i : null;
          continue;
        }
        slab(mb, at(plan.samples[prev], side, band.d0), at(plan.samples[prev], side, band.d1), at(plan.samples[i], side, band.d0), at(plan.samples[i], side, band.d1), plan.samples[prev].s, plan.samples[i].s, side);
        prev = i;
      }
    }
    if (mb.indices.length) out.push(mb.toKn5(`1STREET_PATH_${pad(out.length)}`, "concrete"));
  }
  // Crossovers, from the back of the kerb to the property line.
  const dm = new MeshBuilder();
  for (const d of vc.drives) {
    const k = d.side === 1 ? 0 : 1;
    for (let i = d.i0; i < d.i1; i++) {
      const a = plan.samples[i], b = plan.samples[i + 1];
      // Up to the footpath where there is one; it carries on past it.
      const reach = Math.max(d.d1, vc.paths[k][i]?.d0 ?? 0);
      // From the top of the laid-back kerb, up to the strip's level.
      const low = (s: RoadSample): [number, number, number] => {
        const p = at(s, d.side, KERB_BACK);
        return [p[0], p[1], p[2] - PROUD - KERB_H * LAYBACK + 0.005];
      };
      slab(dm, low(a), at(a, d.side, reach), low(b), at(b, d.side, reach), a.s, b.s, d.side);
    }
  }
  if (dm.indices.length) out.push(dm.toKn5("1STREET_DRIVE_000", "concrete"));
  return out;
}

/** A flat concrete quad between two cross-sections, with a small edge each side. */
function slab(
  mb: MeshBuilder,
  a0: [number, number, number], a1: [number, number, number],
  b0: [number, number, number], b1: [number, number, number],
  sa: number, sb: number, side: 1 | -1,
): void {
  const va = sa / 3, vb = sb / 3; // one pour between joints every 3 m
  // Corners listed inner edge first; on the left of the road that runs
  // counter-clockwise seen from above, on the right clockwise.
  const quad = (p: [number, number, number][], uv: [number, number][], ccw: boolean) => {
    const i = mb.vertexCount;
    p.forEach((q, j) => mb.vertex(q, uv[j][0], uv[j][1]));
    if (ccw) mb.quad(i, i + 1, i + 2, i + 3);
    else mb.quad(i, i + 3, i + 2, i + 1);
  };
  const left = side === 1;
  quad([a0, b0, b1, a1], [[0, va], [0, vb], [1, vb], [1, va]], left);
  // Its sides, down to the ground: the outer one faces away from the road, the inner one toward it.
  const down = (p: [number, number, number]): [number, number, number] => [p[0], p[1], p[2] - PROUD - 0.03];
  quad([down(a1), down(b1), b1, a1], [[1, va], [1, vb], [1, vb], [1, va]], !left);
  quad([a0, b0, down(b0), down(a0)], [[0, va], [0, vb], [0, vb], [0, va]], !left);
}

/**
 * A letterbox beside each driveway, at the property line on the side the
 * traffic comes from: a post and a box, the way nearly every house has one.
 */
export function letterboxes(
  plan: RoadPlan,
  vc: VergeConcrete,
  groundAt: (x: number, y: number, fromEdge: number, s: RoadSample, side: 1 | -1) => number,
): Piece[] {
  const out: Piece[] = [];
  for (const d of vc.drives) {
    const k = d.side === 1 ? 0 : 1;
    // Just before the driveway, as you drive along this side.
    const i = d.side === 1 ? Math.max(0, d.i0 - 1) : Math.min(plan.samples.length - 1, d.i1 + 1);
    const s = plan.samples[i];
    const fromEdge = Math.max(d.d1, vc.paths[k][i]?.d1 ?? 0) + 0.4;
    const t = (s.width / 2 + fromEdge) * d.side;
    const at: [number, number] = [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t];
    const z = groundAt(at[0], at[1], fromEdge, s, d.side);
    out.push({ kind: "box", at, along: s.tan, length: 0.09, depth: 0.09, z0: z - 0.3, z1: z + 0.95, material: "timber" });
    out.push({ kind: "box", at, along: s.tan, length: 0.3, depth: 0.42, z0: z + 0.95, z1: z + 1.22, material: "letterbox" });
  }
  return out;
}
