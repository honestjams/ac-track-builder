// Line markings read off the aerial photo.
//
// At 10-15 cm per pixel a 100 mm painted line is about one blurred pixel,
// so single detections are unreliable. They are used as evidence instead:
// over each 60 m window, lateral positions where narrow bright paint keeps
// recurring are real lines. How much of the window a line covers says
// whether it is dashed or continuous, and the detections give the dash
// phase. The result is drawn as clean geometry at those positions.

import type { RoadPlan } from "./road";
import type { RasterSampler } from "./trace";

export interface ImageLine {
  /** Sample index range covered (inclusive). */
  i0: number;
  i1: number;
  /** Lateral offset from the centreline per sample in range, metres (+ left). */
  t: number[];
  kind: "solid" | "dash";
  /** For dashes: where in the 12 m cycle the 3 m line starts, metres. */
  phase: number;
  colour: "white" | "yellow";
}

const DS = 0.25;
const DT = 0.05;
const WINDOW = 60;
const STEP = 20;

interface Cand {
  s: number;
  t: number;
  yellow: boolean;
}

/** Narrow bright runs across the road, every 0.25 m along it. */
export function paintCandidates(plan: RoadPlan, raster: RasterSampler, trusted: (i: number) => boolean): Cand[] {
  const out: Cand[] = [];
  const samples = plan.samples;
  const end = samples[samples.length - 1].s;
  let i = 0;
  for (let s = 0; s <= end; s += DS) {
    while (i < samples.length - 1 && samples[i + 1].s <= s) i++;
    if (!trusted(i)) continue;
    const a = samples[i], b = samples[Math.min(samples.length - 1, i + 1)];
    const f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    const px = a.pos[0] + (b.pos[0] - a.pos[0]) * f, py = a.pos[1] + (b.pos[1] - a.pos[1]) * f;
    const lx = a.left[0], ly = a.left[1];
    const half = a.width / 2;
    const reach = half + 1;
    const n = Math.round((2 * reach) / DT) + 1;
    const L = new Float32Array(n), Y = new Uint8Array(n), S = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const t = -reach + j * DT;
      const c = raster(px + lx * t, py + ly * t);
      if (!c) {
        L[j] = NaN;
        continue;
      }
      const [r, g, bl] = c;
      L[j] = (r + g + bl) / 3;
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      S[j] = mx > 0 ? (mx - mn) / mx : 0;
      Y[j] = r > 0.45 && g > 0.38 && bl < g * 0.7 ? 1 : 0;
    }
    // Local asphalt brightness: 40th percentile over +-1 m.
    const ref = new Float32Array(n);
    const k = Math.round(1 / DT);
    for (let j = 0; j < n; j++) {
      const w: number[] = [];
      for (let q = Math.max(0, j - k); q <= Math.min(n - 1, j + k); q += 2) if (!Number.isNaN(L[q])) w.push(L[q]);
      w.sort((x, y) => x - y);
      ref[j] = w.length ? w[Math.floor(w.length * 0.4)] : NaN;
    }
    const paint = (j: number) => !Number.isNaN(L[j]) && ((L[j] > ref[j] * 1.18 + 0.03 && S[j] < 0.3) || (Y[j] === 1 && L[j] > ref[j] * 1.2));
    for (let j = 8; j < n - 8;) {
      if (!paint(j)) { j++; continue; }
      let e = j;
      while (e < n - 8 && paint(e)) e++;
      const w = (e - j) * DT;
      const t = -reach + ((j + e - 1) / 2) * DT;
      let peak = 0;
      for (let q = j; q < e; q++) peak = Math.max(peak, L[q]);
      const lo = L[j - 6], hi = L[e + 5];
      // Narrow, darker road both sides at similar brightness (not a shadow edge), inside the seal.
      if (w >= 0.05 && w <= 0.45 && lo < peak * 0.85 && hi < peak * 0.85 && Math.abs(lo - hi) < 0.08 && Math.abs(t) < half - 0.15) {
        let ys = 0;
        for (let q = j; q < e; q++) ys += Y[q];
        out.push({ s, t, yellow: ys > (e - j) / 2 });
      }
      j = e;
    }
  }
  return out;
}

/** Turns candidates into persistent lines. */
export function findLines(plan: RoadPlan, cands: Cand[], trusted: (i: number) => boolean): ImageLine[] {
  const samples = plan.samples;
  const end = samples[samples.length - 1].s;
  const idxAt = (s: number) => {
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].s <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  cands.sort((a, b) => a.s - b.s);

  // Per window: peaks of the lateral histogram with enough coverage.
  interface Seg { s0: number; s1: number; t: number; cover: number; yellow: boolean; phase: number }
  const segs: Seg[] = [];
  let c0 = 0;
  for (let w0 = 0; w0 < end; w0 += STEP) {
    const w1 = Math.min(end, w0 + WINDOW);
    if (w1 - w0 < 20) break;
    while (c0 < cands.length && cands[c0].s < w0) c0++;
    const inWin: Cand[] = [];
    for (let q = c0; q < cands.length && cands[q].s < w1; q++) inWin.push(cands[q]);
    // Rows the photo could be read in (trusted samples), for coverage.
    let rows = 0;
    for (let s = w0; s < w1; s += DS) if (trusted(idxAt(s))) rows++;
    if (rows < (w1 - w0) / DS * 0.6) continue;
    const bins = new Map<number, number>();
    for (const c of inWin) {
      const b = Math.round(c.t / 0.1);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    const taken: number[] = [];
    for (const [b] of [...bins].sort((x, y) => y[1] - x[1])) {
      if (taken.some((t) => Math.abs(t - b) <= 3)) continue;
      const near = inWin.filter((c) => Math.abs(c.t - b * 0.1) <= 0.15);
      const hitRows = new Set(near.map((c) => Math.round(c.s / DS))).size;
      const cover = hitRows / rows;
      if (cover < 0.12) continue;
      taken.push(b);
      // Dash phase: the 3 m slot in the 12 m cycle holding the most detections.
      const slots = new Array(48).fill(0);
      for (const c of near) slots[Math.floor((((c.s % 12) + 12) % 12) / DS)]++;
      let best = 0, bestN = -1;
      for (let p = 0; p < 48; p++) {
        let sum = 0;
        for (let q = 0; q < 12; q++) sum += slots[(p + q) % 48];
        if (sum > bestN) {
          bestN = sum;
          best = p;
        }
      }
      const t = near.reduce((a, c) => a + c.t, 0) / near.length;
      segs.push({ s0: w0, s1: w1, t, cover, yellow: near.filter((c) => c.yellow).length > near.length / 2, phase: best * DS });
    }
  }

  // Chain overlapping windows into lines (same lateral position within 0.3 m).
  segs.sort((a, b) => a.s0 - b.s0);
  const chains: Seg[][] = [];
  for (const sg of segs) {
    const prev = chains.find((ch) => {
      const last = ch[ch.length - 1];
      return sg.s0 <= last.s1 && sg.s0 > last.s0 && Math.abs(last.t - sg.t) < 0.3;
    });
    if (prev) prev.push(sg);
    else chains.push([sg]);
  }
  const lines: ImageLine[] = [];
  for (const ch of chains) {
    const s0 = ch[0].s0 + (ch.length > 1 ? 0 : 10), s1 = ch[ch.length - 1].s1 - (ch.length > 1 ? 0 : 10);
    if (s1 - s0 < 20) continue;
    const i0 = idxAt(s0), i1 = idxAt(s1);
    const t: number[] = [];
    for (let i = i0; i <= i1; i++) {
      // Interpolate the window centres' offsets along the chain.
      const s = samples[i].s;
      let a = ch[0], b = ch[ch.length - 1];
      for (let q = 0; q < ch.length - 1; q++) {
        const ca = (ch[q].s0 + ch[q].s1) / 2, cb = (ch[q + 1].s0 + ch[q + 1].s1) / 2;
        if (s >= ca && s <= cb) {
          a = ch[q];
          b = ch[q + 1];
        }
      }
      const ca = (a.s0 + a.s1) / 2, cb = (b.s0 + b.s1) / 2;
      const f = cb > ca ? Math.max(0, Math.min(1, (s - ca) / (cb - ca))) : 0;
      t.push(a.t + (b.t - a.t) * f);
    }
    const cover = ch.reduce((x, c) => x + c.cover, 0) / ch.length;
    const phases = ch.map((c) => c.phase).sort((x, y) => x - y);
    lines.push({
      i0, i1, t,
      kind: cover > 0.5 ? "solid" : "dash",
      phase: phases[phases.length >> 1],
      colour: ch.filter((c) => c.yellow).length > ch.length / 2 ? "yellow" : "white",
    });
  }
  return lines;
}
