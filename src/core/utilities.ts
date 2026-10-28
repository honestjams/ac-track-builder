// Power poles, overhead wires and street lights: the things that line an
// Australian street above head height, and most of what makes it read as a
// street rather than a road through a field.
//
// Where they are comes from, best first: street-level imagery (Mapillary)
// and OpenStreetMap (power poles, power lines and street lamps, where
// they're mapped). Poles are pulled onto the nature strip if a sighting
// puts them on the road. Wires run along each mapped power line and between
// neighbouring poles on the same side of the street. A lamp beside a pole
// is mounted on it, on an outreach arm over the road.
//
// Built-up streets with no lights known get them anyway, at a typical
// spacing, on poles of their own (or on a known power pole nearby). Power
// poles are never invented: newer estates have their power underground.

import type { Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import { KERB_H } from "./kerbs";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { inRoundabout, type RoadPlan, type SegmentIndex } from "./road";
import { pad } from "./roadMesh";
import { ChunkedMesh } from "./scenery";
import { off, vergeZ, type Piece } from "./furniture";

/** Behind the kerb, on the nature strip or verge, metres from the road edge. */
const SET_BACK = 1.0;
const POLE_H = 11;
const ARM_H = 10.3; // crossarm, carrying the high-voltage conductors
const LV_H = 8.4; // the low-voltage bundle, below
const LAMP_H = 8.2;
/** Default street light spacing in town, metres. */
const LIGHT_SPACING = 50;

export interface UtilityInput {
  /** Power poles: sightings and mapped poles, local metres. */
  poles: Vec2[];
  /** Street lights. */
  lamps: Vec2[];
  /** Mapped power lines (their vertices are the poles). */
  lines: Vec2[][];
}

interface Spot {
  at: Vec2;
  /** Sample index and side of the road it stands by. */
  i: number;
  side: 1 | -1;
  /** Ground height at its foot. */
  z: number;
  /** Unit vector across the road, away from it. */
  out: Vec2;
}

export interface Utilities {
  pieces: Piece[];
  wires: Kn5MeshNode[];
  /** Lamp heads (local x, y, height), for night lighting. */
  lights: Vec3[];
  poles: number;
}

export function placeUtilities(
  input: UtilityInput,
  plan: RoadPlan,
  index: SegmentIndex,
  opts: BuildOptions,
  /** How built-up it is at each sample: 0 country, 1 edge of town, 2 town. */
  town: (i: number) => number,
  /** No pole here (a side street, a driveway, a building). */
  blocked: (x: number, y: number) => boolean = () => false,
): Utilities {
  const snap = (p: Vec2): Spot | null => {
    const n = index.nearest(p[0], p[1], opts.corridor - 2);
    if (!n || inRoundabout(plan, p[0], p[1], 2)) return null;
    const s = plan.samples[n.seg];
    const side: 1 | -1 = n.t >= 0 ? 1 : -1;
    const half = s.width / 2;
    // A sighting is a few metres out; on the road or its edge means the verge.
    const t = n.dist < half + SET_BACK + 1.5 ? side * (half + SET_BACK) : n.t;
    if (Math.abs(t) > half + 25) return null;
    // Straight across onto the verge, keeping its place along the street.
    const at: Vec2 = [p[0] + s.left[0] * (t - n.t), p[1] + s.left[1] * (t - n.t)];
    return { at, i: n.seg, side, z: groundAt(plan, opts, n.seg, side, t), out: [s.left[0] * side, s.left[1] * side] };
  };
  const dedupe = (spots: Spot[], r: number) => {
    const out: Spot[] = [];
    for (const p of spots) if (!out.some((q) => Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1]) < r)) out.push(p);
    return out;
  };

  // Poles: sightings and mapped poles, then any line vertex not already one.
  const lineVerts = input.lines.flat();
  const poles = dedupe([...input.poles, ...lineVerts].map(snap).filter((p): p is Spot => !!p), 4);
  const lamps = dedupe(input.lamps.map(snap).filter((p): p is Spot => !!p), 4);

  // Default lights along the route in town, where nothing is known nearby.
  const known = [...lamps];
  const near = (list: Spot[], p: Vec2, r: number) => list.find((q) => Math.hypot(q.at[0] - p[0], q.at[1] - p[1]) < r);
  let k = 0;
  for (let sd = LIGHT_SPACING / 2; sd < plan.length; sd += LIGHT_SPACING, k++) {
    const i = sampleAt(plan, sd);
    if (town(i) < 1) continue;
    const s = plan.samples[i];
    // One side on a narrow street; staggered on a wide one.
    const side: 1 | -1 = s.width >= 10 && k % 2 ? -1 : 1;
    const t = side * (s.width / 2 + SET_BACK);
    const at = off(s, t);
    if (near(known, at, LIGHT_SPACING * 0.6) || blocked(at[0], at[1]) || inRoundabout(plan, at[0], at[1], 3)) continue;
    // On a power pole if there's one close by.
    const pole = near(poles, at, 18);
    const spot: Spot = pole ?? { at, i, side, z: groundAt(plan, opts, i, side, t), out: [s.left[0] * side, s.left[1] * side] };
    known.push(spot);
    lamps.push(spot);
  }

  const pieces: Piece[] = [];
  const lights: Vec3[] = [];
  for (const p of poles) {
    const s = plan.samples[p.i];
    pieces.push({ kind: "box", at: p.at, along: s.tan, length: 0.28, depth: 0.28, z0: p.z - 1, z1: p.z + POLE_H, material: "timber" });
    // Crossarm across the line (the line runs along the street).
    pieces.push({ kind: "box", at: p.at, along: p.out, length: 2.2, depth: 0.1, z0: p.z + ARM_H, z1: p.z + ARM_H + 0.12, material: "timber" });
  }
  for (const l of lamps) {
    const s = plan.samples[l.i];
    const onPole = poles.find((p) => Math.hypot(p.at[0] - l.at[0], p.at[1] - l.at[1]) < 3);
    const base = onPole ?? l;
    const toRoad: Vec2 = [-base.out[0], -base.out[1]];
    if (!onPole) pieces.push({ kind: "box", at: base.at, along: s.tan, length: 0.16, depth: 0.16, z0: base.z - 0.6, z1: base.z + LAMP_H + 0.3, material: "steel" });
    // Outreach arm over the road, the lantern on its end.
    const reach = 2.2;
    const mid: Vec2 = [base.at[0] + toRoad[0] * reach / 2, base.at[1] + toRoad[1] * reach / 2];
    const tip: Vec2 = [base.at[0] + toRoad[0] * reach, base.at[1] + toRoad[1] * reach];
    pieces.push({ kind: "box", at: mid, along: toRoad, length: reach, depth: 0.07, z0: base.z + LAMP_H + 0.15, z1: base.z + LAMP_H + 0.24, material: "steel" });
    pieces.push({ kind: "box", at: tip, along: toRoad, length: 0.7, depth: 0.32, z0: base.z + LAMP_H, z1: base.z + LAMP_H + 0.16, material: "lamp" });
    lights.push([tip[0], tip[1], base.z + LAMP_H - 0.02]);
  }

  return { pieces, wires: buildWires(spans(poles, input.lines, plan)), lights, poles: poles.length };
}

/** Ground height at the foot of something at lateral offset t: verge, or nature strip behind a kerb. */
function groundAt(plan: RoadPlan, opts: BuildOptions, i: number, side: 1 | -1, t: number): number {
  const s = plan.samples[i];
  const kerbed = (s.kerb?.[side === 1 ? 0 : 1] ?? 0) > 0;
  return vergeZ(s, t, opts) + (kerbed ? KERB_H + 0.2 * Math.min(1, (Math.abs(t) - s.width / 2) / Math.max(0.1, opts.vergeWidth)) : 0);
}

function sampleAt(plan: RoadPlan, s: number): number {
  let lo = 0, hi = plan.samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (plan.samples[mid].s < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Span = [Spot, Spot];

/**
 * Pairs of poles a wire runs between: consecutive vertices of each mapped
 * line, and neighbouring poles along the same side of the street.
 */
function spans(poles: Spot[], lines: Vec2[][], plan: RoadPlan): Span[] {
  const out: Span[] = [];
  const has = (a: Spot, b: Spot) => out.some(([p, q]) => (p === a && q === b) || (p === b && q === a));
  const poleAt = (v: Vec2) => poles.find((p) => Math.hypot(p.at[0] - v[0], p.at[1] - v[1]) < 6);
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const a = poleAt(line[k - 1]), b = poleAt(line[k]);
      if (a && b && a !== b && !has(a, b)) out.push([a, b]);
    }
  }
  for (const side of [1, -1] as const) {
    const row = poles.filter((p) => p.side === side).sort((a, b) => plan.samples[a.i].s - plan.samples[b.i].s);
    for (let k = 1; k < row.length; k++) {
      const a = row[k - 1], b = row[k];
      const ds = plan.samples[b.i].s - plan.samples[a.i].s;
      const d = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
      // Neighbours a span apart, roughly along the street (not across a bend's chord).
      if (ds >= 15 && ds <= 75 && d > ds * 0.85 && !has(a, b)) out.push([a, b]);
    }
  }
  return out.filter(([a, b]) => {
    const d = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
    return d >= 8 && d <= 90;
  });
}

/** Conductors: three on the crossarm, the low-voltage bundle below. */
const CONDUCTORS: { across: number; h: number; w: number }[] = [
  { across: -0.9, h: ARM_H + 0.18, w: 0.025 },
  { across: 0, h: ARM_H + 0.18, w: 0.025 },
  { across: 0.9, h: ARM_H + 0.18, w: 0.025 },
  { across: 0.25, h: LV_H, w: 0.05 },
];

/** Sagging wires between each pair of poles: crossed thin ribbons, both faces. */
function buildWires(list: Span[]): Kn5MeshNode[] {
  const cm = new ChunkedMesh(0);
  const SEG = 10;
  for (const [a, b] of list) {
    const L = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
    const sag = Math.min(1.2, 0.0005 * L * L);
    for (const c of CONDUCTORS) {
      const pa: Vec3 = [a.at[0] + a.out[0] * c.across, a.at[1] + a.out[1] * c.across, a.z + c.h];
      // The far pole's arm faces the same way as this one's, whichever side it's on.
      const flip = a.out[0] * b.out[0] + a.out[1] * b.out[1] < 0 ? -1 : 1;
      const pb: Vec3 = [b.at[0] + b.out[0] * c.across * flip, b.at[1] + b.out[1] * c.across * flip, b.z + c.h];
      const pts: Vec3[] = [];
      for (let k = 0; k <= SEG; k++) {
        const f = k / SEG;
        pts.push([pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f - 4 * sag * f * (1 - f)]);
      }
      ribbon(cm.next(SEG * 16), pts, c.w);
    }
  }
  return cm.all().map((mb, i) => mb.toKn5(`WIRES_${pad(i)}`, "wire", { castShadows: false }));
}

function ribbon(mb: MeshBuilder, pts: Vec3[], w: number): void {
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1], q = pts[k];
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    const side: Vec3 = [(-dy / l) * w / 2, (dx / l) * w / 2, 0];
    // A flat ribbon seen from above and below, and an upright one seen from either side.
    const flat: [Vec3, Vec3, Vec3, Vec3] = [
      [p[0] - side[0], p[1] - side[1], p[2]], [q[0] - side[0], q[1] - side[1], q[2]],
      [q[0] + side[0], q[1] + side[1], q[2]], [p[0] + side[0], p[1] + side[1], p[2]],
    ];
    const upright: [Vec3, Vec3, Vec3, Vec3] = [
      [p[0], p[1], p[2] - w / 2], [q[0], q[1], q[2] - w / 2], [q[0], q[1], q[2] + w / 2], [p[0], p[1], p[2] + w / 2],
    ];
    twoSided(mb, flat, [0, 0, 1]);
    twoSided(mb, upright, [dy / l, -dx / l, 0]); // counter-clockwise seen from the right of the wire
  }
}

function twoSided(mb: MeshBuilder, c: [Vec3, Vec3, Vec3, Vec3], n: Vec3): void {
  for (const sign of [1, -1]) {
    const i = mb.vertexCount;
    c.forEach((p, j) => {
      mb.vertex(p, j === 1 || j === 2 ? 1 : 0, j >= 2 ? 0 : 1);
      mb.normals!.push(n[0] * sign, n[1] * sign, n[2] * sign);
    });
    if (sign > 0) mb.quad(i, i + 1, i + 2, i + 3);
    else mb.quad(i, i + 3, i + 2, i + 1);
  }
}
