// U-turn spurs. A pin that snaps to the far carriageway of a divided road
// (or into a side street or car park) makes the router drive past it, turn
// round and come back: an out-and-back stretch that builds as a hairpin
// spike, two roads side by side, or the same road twice. The router says
// where it turned round, so each U-turn it reports is cut out: from where
// the route first runs alongside itself (either direction, within a divided
// road's width) to where it last does, joined with a gentle diagonal.
//
// Only spurs with a reported U-turn are cut. A mountain hairpin's two arms
// can run as close together, but the router doesn't call a bend a U-turn.

import { haversine, type LngLat } from "./geo";

const STEP = 2; // resample spacing, metres
const SEP = 36; // arms within this distance run alongside each other (a divided road's two carriageways, light rail between them included)
const MIN_SPAN = 30; // a cut is at least this long, or it's just a bend
const MAX_CUT = 1500; // and at most this long...
const MAX_SHARE = 0.5; // ...and never more than this share of the route

export interface Trimmed {
  coords: LngLat[];
  /** Where each U-turn that was cut out was. */
  cut: LngLat[];
  /** U-turns left in (the spur couldn't be found, or was too long to cut). */
  kept: LngLat[];
  /** Arc-length ranges removed, metres along the original route. */
  ranges: [number, number][];
}

interface Sample {
  p: [number, number];
  s: number;
  dir: [number, number];
}

export function trimSpurs(coords: LngLat[], uturns: LngLat[]): Trimmed {
  if (coords.length < 3 || !uturns.length) return { coords, cut: [], kept: uturns, ranges: [] };
  const o = coords[0];
  const kx = Math.cos((o[1] * Math.PI) / 180) * 111320, ky = 110574;
  const local = (c: LngLat): [number, number] => [(c[0] - o[0]) * kx, (c[1] - o[1]) * ky];
  const pts = coords.map(local);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const samples = resample(pts, cum, total);

  const ranges: [number, number][] = [];
  const cut: LngLat[] = [], kept: LngLat[] = [];
  for (const u of uturns) {
    const up = local(u);
    // The U-turn's place on the route: the nearest sample.
    let k = 0, best = Infinity;
    samples.forEach((q, i) => {
      const d = Math.hypot(q.p[0] - up[0], q.p[1] - up[1]);
      if (d < best) [best, k] = [d, i];
    });
    if (best > 30 || ranges.some(([a, b]) => samples[k].s >= a && samples[k].s <= b)) {
      if (best > 30) kept.push(u);
      continue;
    }
    const span = spurAround(samples, k, total);
    if (!span) {
      kept.push(u);
      continue;
    }
    ranges.push(span);
    cut.push(u);
  }
  if (!ranges.length) return { coords, cut, kept, ranges };
  ranges.sort((a, b) => a[0] - b[0]);
  return { coords: removeRanges(coords, cum, total, ranges), cut, kept, ranges };
}

function resample(pts: [number, number][], cum: number[], total: number): Sample[] {
  const out: Sample[] = [];
  let seg = 1;
  for (let s = 0; s <= total; s += STEP) {
    while (seg < pts.length - 1 && cum[seg] < s) seg++;
    const a = pts[seg - 1], b = pts[seg];
    const L = cum[seg] - cum[seg - 1] || 1;
    const f = Math.max(0, Math.min(1, (s - cum[seg - 1]) / L));
    out.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], s, dir: [0, 0] });
  }
  // Direction over ±6 m, so a kink in the line doesn't count.
  const w = Math.max(1, Math.round(6 / STEP));
  out.forEach((q, i) => {
    const a = out[Math.max(0, i - w)].p, b = out[Math.min(out.length - 1, i + w)].p;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    q.dir = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  });
  return out;
}

/**
 * The longest stretch [s0, s1] around sample k whose ends run alongside each
 * other (or the route's own start or end, for a spur at a pin at either end).
 */
function spurAround(samples: Sample[], k: number, total: number): [number, number] | null {
  // Search a little past the limit: a spur whose arms still run alongside
  // there is longer than the limit, and is left alone rather than cut short.
  const limit = Math.min(MAX_CUT, total * MAX_SHARE);
  const reach = limit + 60;
  const sk = samples[k].s;
  let found: [number, number] | null = null;
  for (let i = k; i >= 0 && sk - samples[i].s <= reach; i--) {
    const a = samples[i];
    for (let j = samples.length - 1; j > k; j--) {
      const b = samples[j];
      if (b.s - a.s > reach) continue;
      if (b.s - a.s < MIN_SPAN) break;
      if (found && b.s - a.s <= found[1] - found[0]) break;
      const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]);
      const par = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1]);
      if (d <= SEP && par > 0.8) {
        found = [a.s, b.s];
        break;
      }
    }
  }
  if (!found || found[1] - found[0] > limit) return null;
  // At either end of the route the spur is the route's own beginning or end,
  // and the route now begins (or ends) beside the pin.
  const nearest = (to: Sample, from: number, until: number) => {
    let best = from, bd = Infinity;
    for (const q of samples) {
      if (q.s < from || q.s > until) continue;
      const d = Math.hypot(q.p[0] - to.p[0], q.p[1] - to.p[1]);
      if (d < bd) [bd, best] = [d, q.s];
    }
    return best;
  };
  if (found[0] <= 2 * STEP + SEP) {
    found[0] = 0;
    found[1] = nearest(samples[0], found[1] - 2 * SEP, found[1]);
  }
  if (found[1] >= total - 2 * STEP - SEP) {
    found[1] = total;
    found[0] = nearest(samples[samples.length - 1], found[0], found[0] + 2 * SEP);
  }
  return found;
}

/** The route without the given stretches, each gap bridged by a straight run. */
function removeRanges(coords: LngLat[], cum: number[], total: number, ranges: [number, number][]): LngLat[] {
  const at = (s: number): LngLat => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = Math.max(0, Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
    return [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f];
  };
  // Merge overlaps, then widen each middle gap so the sideways step between
  // the two carriageways becomes a gentle diagonal.
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: LngLat[] = [];
  let from = 0;
  for (const [a0, b0] of merged) {
    const step = haversine(at(a0), at(b0));
    const J = a0 > 0 && b0 < total ? Math.max(10, 3 * step) : 0;
    const a = Math.max(from, a0 - J), b = Math.min(total, b0 + J);
    coords.forEach((c, i) => {
      if (cum[i] >= from && cum[i] < a) out.push(c);
    });
    if (a > 0) out.push(at(a));
    from = b;
    if (b < total) out.push(at(b));
  }
  coords.forEach((c, i) => {
    if (cum[i] > from) out.push(c);
  });
  // Drop repeats.
  return out.filter((c, i) => i === 0 || c[0] !== out[i - 1][0] || c[1] !== out[i - 1][1]);
}
