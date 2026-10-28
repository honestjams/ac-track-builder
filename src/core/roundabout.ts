// Roundabouts. The router says where the route goes round one (OSRM
// "roundabout"/"rotary" steps). The circle comes from the OSM ring way when
// Overpass answers, else from a fit to the arc the route drives.
//
// The route's arc is snapped onto that exact circle before smoothing, so it
// stays a circle rather than collapsing into a hairpin. The full circulating
// carriageway (including the part not driven) is built as an annulus, with
// a mountable kerb and a grassed island in the middle. The road ribbon stops
// at the ring and short connector pieces join the two.

import type { LngLat, LocalProjection, Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder } from "./mesh";
import type { BuildOptions } from "./options";
import { SEAL_LENGTH } from "./textures";
import { STRIP_EXTRA } from "./kerbs";

/** What the router reports for one roundabout manoeuvre. */
export interface RoundaboutHint {
  location: LngLat;
  /** The route's path round the ring, from entry to exit. */
  arc: LngLat[];
}

export interface Circle {
  c: Vec2;
  r: number;
}

export interface Roundabout extends Circle {
  /** Circulating carriageway width, metres. */
  w: number;
  /** Ring surface height at the centreline radius, metres. */
  hc: number;
  /** Distance range along the route spent on the ring. */
  sIn: number;
  sOut: number;
  /** Angles (radians, from +x) where the route crosses the outer edge. */
  crossings: number[];
  /** Kerb and gutter round the outside instead of a gravel verge (in town). */
  kerbed?: boolean;
  /**
   * Where roads join the ring, as angle ranges (radians from +x, counter-
   * clockwise from the first to the second), taken from the connectors'
   * actual edges. The verge and kerb stay out of these.
   */
  openings?: [number, number][];
}

/** Metres round a ring of radius r from angle a to the nearest opening (0 inside one). */
export function toOpening(rb: Roundabout, r: number, a: number): number {
  const wrap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const open = rb.openings?.length
    ? rb.openings
    // No connector edges known: the ring's own width either side of each crossing.
    : rb.crossings.map((x): [number, number] => [x - (rb.w / 2 + 2) / r, x + (rb.w / 2 + 2) / r]);
  let best = Infinity;
  for (const [a0, a1] of open) {
    const span = wrap(a1 - a0), off = wrap(a - a0);
    if (off <= span) return 0;
    best = Math.min(best, (off - span) * r, (2 * Math.PI - off) * r);
  }
  return best;
}

export const RING_FALL = 0.02;
const KERB = 0.15;
const MIN_R = 5;
const MAX_R = 60;

export const outerRadius = (rb: Roundabout) => rb.r + rb.w / 2;
/**
 * Outer edge of the ring's verge. Behind a kerb the grass strip runs as wide as a kerbed road's
 * (verge plus strip), and at least far enough that the ground's ramp up to it starts behind the
 * gutter and kerb.
 */
export const vergeOuterRadius = (rb: Roundabout, opts: BuildOptions) =>
  outerRadius(rb) + (rb.kerbed ? Math.max(opts.vergeWidth + STRIP_EXTRA, 0.35 + 2 * opts.terrainStep) : opts.vergeWidth);
export const innerRadius = (rb: Roundabout) => Math.max(1.5, rb.r - rb.w / 2);

/** Ring surface height at radius rho: flat, falling 2% outward. */
export function ringHeight(rb: Roundabout, rho: number): number {
  return rb.hc + RING_FALL * (rb.r - rho);
}

/** Least-squares circle (Kasa fit). Null if the points are (nearly) collinear. */
export function fitCircle(pts: Vec2[]): (Circle & { rms: number }) | null {
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, y] of pts) {
    const u = x - mx, v = y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = (suuu + suvv) / 2, b2 = (svvv + svuu) / 2;
  const uc = (b1 * svv - b2 * suv) / det, vc = (b2 * suu - b1 * suv) / det;
  const c: Vec2 = [uc + mx, vc + my];
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length);
  const rms = Math.sqrt(pts.reduce((a, p) => a + (Math.hypot(p[0] - c[0], p[1] - c[1]) - r) ** 2, 0) / pts.length);
  return { c, r, rms };
}

/** Angle swept by points round a centre, radians. */
function sweep(pts: Vec2[], c: Vec2): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i - 1][1] - c[1], pts[i - 1][0] - c[0]);
    const b = Math.atan2(pts[i][1] - c[1], pts[i][0] - c[0]);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return Math.abs(total);
}

/**
 * Turns router hints into circles in local metres. Prefers OSM ring nodes
 * near the manoeuvre (a full circle fits well); falls back to the driven
 * arc when it covers enough of the ring; else assumes a 12 m roundabout
 * whose centre lies to the right of the entry (traffic keeps left and
 * circulates clockwise).
 */
export function resolveRoundabouts(hints: RoundaboutHint[], rings: LngLat[][], proj: LocalProjection): Circle[] {
  const localRings = rings.map((r) => r.map((p) => proj.toLocal(p)));
  const out: Circle[] = [];
  for (const h of hints) {
    const loc = proj.toLocal(h.location);
    const arc = h.arc.map((p) => proj.toLocal(p));
    let circle: Circle | null = null;

    const near = localRings.filter((ring) => ring.some((p) => Math.hypot(p[0] - loc[0], p[1] - loc[1]) < 40));
    const nodes = near.flat().filter((p) => Math.hypot(p[0] - loc[0], p[1] - loc[1]) < 2 * MAX_R);
    const fromRing = nodes.length >= 5 ? fitCircle(nodes) : null;
    if (fromRing && fromRing.r >= MIN_R && fromRing.r <= MAX_R && fromRing.rms < 2) circle = fromRing;

    if (!circle && arc.length >= 4) {
      const f = fitCircle(arc);
      if (f && f.r >= MIN_R && f.r <= MAX_R && f.rms < 1.5 && sweep(arc, f.c) > Math.PI / 3) circle = f;
    }

    if (!circle && arc.length >= 2) {
      const [a, b] = arc;
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const r = 12;
      circle = { c: [a[0] + (dy / l) * r, a[1] - (dx / l) * r], r };
    }
    if (circle && !out.some((o) => Math.hypot(o.c[0] - circle!.c[0], o.c[1] - circle!.c[1]) < 8)) out.push(circle);
  }
  return out;
}

/**
 * Projects the stretches of a dense (1 m) path that run round a roundabout
 * onto its circle. Returns which points were snapped, so smoothing can
 * leave them be.
 */
export function snapToCircles(path: Vec2[], circles: Circle[]): boolean[] {
  const pinned = new Array<boolean>(path.length).fill(false);
  for (const { c, r } of circles) {
    const band = Math.max(4, r * 0.35);
    const original = path.slice();
    path.forEach((p, i) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      // Only points travelling round the ring, not approaches crossing the band.
      const a = original[Math.max(0, i - 2)], b = original[Math.min(original.length - 1, i + 2)];
      const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
      const radial = Math.abs((tx * (p[0] - c[0]) + ty * (p[1] - c[1])) / (tl * (d || 1)));
      if (Math.abs(d - r) < band && d > 1e-6 && radial < 0.5) {
        path[i] = [c[0] + ((p[0] - c[0]) / d) * r, c[1] + ((p[1] - c[1]) / d) * r];
        pinned[i] = true;
      }
    });
  }
  return pinned;
}

export interface RingMeshes {
  road: Kn5MeshNode;
  island: Kn5MeshNode;
  verge: Kn5MeshNode;
  /** Gutter and kerb, when the ring is kerbed. */
  kerb: Kn5MeshNode[];
}

/** Circulating carriageway, island (kerb + grassed mound) and outer verge. */
export function buildRingMeshes(rb: Roundabout, k: number, opts: BuildOptions, roadMaterial: string): RingMeshes {
  const Ro = outerRadius(rb), Ri = innerRadius(rb);
  const N = Math.max(48, Math.ceil((2 * Math.PI * Ro) / 1.5));
  const at = (rho: number, a: number, z: number): [number, number, number] =>
    [rb.c[0] + Math.cos(a) * rho, rb.c[1] + Math.sin(a) * rho, z];
  const circumference = 2 * Math.PI * rb.r;

  // Carriageway: three rings of vertices (inner edge, centre, outer edge).
  const road = new MeshBuilder();
  const radii = [Ri, rb.r, Ro];
  for (let s = 0; s <= N; s++) {
    const a = (s / N) * 2 * Math.PI;
    radii.forEach((rho, j) => road.vertex(at(rho, a, ringHeight(rb, rho)), j / 2, (s / N) * circumference / SEAL_LENGTH));
  }
  for (let s = 0; s < N; s++) {
    for (let j = 0; j < 2; j++) {
      const p = s * 3 + j, q = p + 3;
      // Counter-clockwise seen from above: outward, then on round.
      road.quad(p, p + 1, q + 1, q);
    }
  }

  // Island: a sloped mountable kerb, then a gently domed lawn.
  const island = new MeshBuilder();
  const zEdge = ringHeight(rb, Ri);
  const kerbIn = Math.max(0.5, Ri - 0.3);
  const rings: [number, number][] = [
    [Ri, zEdge],
    [kerbIn, zEdge + KERB],
    [kerbIn * 0.5, zEdge + KERB + Math.min(0.8, Ri * 0.08)],
  ];
  const centre = island.vertex([rb.c[0], rb.c[1], zEdge + KERB + Math.min(1, Ri * 0.1)], 0.5, 0.5);
  for (let s = 0; s <= N; s++) {
    const a = (s / N) * 2 * Math.PI;
    for (const [rho, z] of rings) {
      const p = at(rho, a, z);
      island.vertex(p, p[0] / 8, -p[1] / 8);
    }
  }
  for (let s = 0; s < N; s++) {
    const p = 1 + s * 3, q = p + 3;
    for (let j = 0; j < 2; j++) island.quad(p + j, q + j, q + j + 1, p + j + 1);
    island.tri(p + 2, q + 2, centre);
  }

  // Outer verge, except where roads join the ring.
  const verge = new MeshBuilder();
  const gapM = 0.5;
  /** Metres round the outer edge from angle a to the nearest road joining the ring. */
  const toGap = (a: number) => toOpening(rb, Ro, a);
  const vo = vergeOuterRadius(rb, opts);
  const zi = ringHeight(rb, Ro);
  const kerb: Kn5MeshNode[] = [];
  if (!rb.kerbed) {
    for (let s = 0; s < N; s++) {
      const a0 = (s / N) * 2 * Math.PI, a1 = ((s + 1) / N) * 2 * Math.PI;
      if (toGap(a0) < gapM || toGap(a1) < gapM) continue;
      const zo = zi - 0.2;
      const i = verge.vertexCount;
      verge.vertex(at(Ro, a0, zi), 1, 0);
      verge.vertex(at(vo, a0, zo), 0.1, 0);
      verge.vertex(at(vo, a1, zo), 0.1, 1);
      verge.vertex(at(Ro, a1, zi), 1, 1);
      verge.vertex(at(vo, a0, zo - 0.8), 0, 0);
      verge.vertex(at(vo, a1, zo - 0.8), 0, 1);
      verge.quad(i, i + 1, i + 2, i + 3);
      verge.quad(i + 1, i + 4, i + 5, i + 2);
    }
  } else {
    // Gutter, kerb and a grass strip, sloping down to nothing over 2 m either side of each road joining.
    const gutter = new MeshBuilder(), kb = new MeshBuilder();
    const profile = (k: number): { mb: MeshBuilder; p: [number, number]; q: [number, number] }[] => [
      { mb: gutter, p: [Ro, zi], q: [Ro + 0.3 * k, zi - 0.03 * k] },
      { mb: kb, p: [Ro + 0.3 * k, zi - 0.03 * k], q: [Ro + 0.35 * k, zi + KERB * k] },
      { mb: kb, p: [Ro + 0.35 * k, zi + KERB * k], q: [Ro + 0.5 * k, zi + KERB * k] },
      { mb: verge, p: [Ro + 0.5 * k, zi + KERB * k], q: [vo, zi + (KERB + 0.02) * k - 0.2 * (1 - k)] },
      { mb: verge, p: [vo, zi + (KERB + 0.02) * k - 0.2 * (1 - k)], q: [vo, zi + (KERB + 0.02) * k - 1] },
    ];
    for (let s = 0; s < N; s++) {
      const a0 = (s / N) * 2 * Math.PI, a1 = ((s + 1) / N) * 2 * Math.PI;
      const k0 = Math.max(0, Math.min(1, (toGap(a0) - gapM) / 2)), k1 = Math.max(0, Math.min(1, (toGap(a1) - gapM) / 2));
      if (k0 === 0 && k1 === 0) continue;
      const P0 = profile(k0), P1 = profile(k1);
      P0.forEach((g, j) => {
        const h = P1[j];
        const v0 = (a0 * Ro) / 3, v1 = (a1 * Ro) / 3;
        const i = g.mb.vertexCount;
        g.mb.vertex(at(g.p[0], a0, g.p[1]), 0, v0);
        g.mb.vertex(at(g.q[0], a0, g.q[1]), 1, v0);
        g.mb.vertex(at(h.q[0], a1, h.q[1]), 1, v1);
        g.mb.vertex(at(h.p[0], a1, h.p[1]), 0, v1);
        g.mb.quad(i, i + 1, i + 2, i + 3);
      });
    }
    if (gutter.indices.length) kerb.push(gutter.toKn5(`1ROAD_RBGUTTER${k}`, "concrete"));
    if (kb.indices.length) kerb.push(kb.toKn5(`1KERB_RB${k}`, "concrete"));
  }

  return {
    road: road.toKn5(`1ROAD_RB${k}`, roadMaterial),
    island: island.toKn5(`1GRASS_RBISLAND${k}`, "grass"),
    verge: verge.toKn5(`1GRASS_RBVERGE${k}`, rb.kerbed ? "grass" : "verge"),
    kerb,
  };
}

/** Invisible wall round the roundabout, open where the route enters and leaves. */
export function buildRingWall(rb: Roundabout, k: number, opts: BuildOptions, ground: (x: number, y: number) => number): Kn5MeshNode | null {
  if (opts.wallOffset <= 0) return null;
  const R = outerRadius(rb) + Math.max(opts.vergeWidth + 1, opts.wallOffset);
  const N = Math.max(32, Math.ceil((2 * Math.PI * R) / 3));
  const halfGap = (rb.w / 2 + Math.max(opts.vergeWidth + 1, opts.wallOffset)) / R;
  const open = (a: number) => rb.crossings.some((x) => {
    let d = Math.abs(a - x) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d < halfGap;
  });
  const mb = new MeshBuilder();
  for (let s = 0; s < N; s++) {
    const a0 = (s / N) * 2 * Math.PI, a1 = ((s + 1) / N) * 2 * Math.PI;
    if (open(a0) || open(a1)) continue;
    const p0: Vec2 = [rb.c[0] + Math.cos(a0) * R, rb.c[1] + Math.sin(a0) * R];
    const p1: Vec2 = [rb.c[0] + Math.cos(a1) * R, rb.c[1] + Math.sin(a1) * R];
    const lo = Math.min(rb.hc, ground(...p0), ground(...p1)) - 5, hi = Math.max(rb.hc, ground(...p0), ground(...p1)) + 4;
    for (const flip of [false, true]) {
      const i = mb.vertexCount;
      mb.vertex([p0[0], p0[1], lo], 0, 1);
      mb.vertex([p1[0], p1[1], lo], 1, 1);
      mb.vertex([p1[0], p1[1], hi], 1, 0);
      mb.vertex([p0[0], p0[1], hi], 0, 0);
      if (flip) mb.quad(i, i + 3, i + 2, i + 1);
      else mb.quad(i, i + 1, i + 2, i + 3);
    }
  }
  if (!mb.indices.length) return null;
  return mb.toKn5(`1WALL_RB${k}`, "wall", { renderable: false, castShadows: false });
}
