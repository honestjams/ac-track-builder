// Road surface, verges and invisible walls, built as ribbons along the samples
// and split into chunks along the road (kn5 meshes hold at most 65535
// vertices, and smaller meshes cull better in game).

import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { inRoundabout, surfaceHeight, type RoadPlan, type RoadSample, SegmentIndex } from "./road";
import { outerRadius, ringHeight } from "./roundabout";
import earcut from "earcut";
import type { HeightFn } from "./elevation";

import { SEAL_LENGTH } from "./textures";
const VERGE_DROP = 0.2;
const SKIRT_DEPTH = 0.8;
const CHUNK_SECTIONS = 120;

function point(s: RoadSample, t: number, z: number): Vec3 {
  return [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t, z];
}

/** Section index ranges [start, end] (inclusive) for each chunk. */
export function chunkRanges(plan: RoadPlan): [number, number][] {
  const n = plan.samples.length;
  const last = plan.closed ? n : n - 1; // closed roads wrap back to sample 0
  const out: [number, number][] = [];
  for (let a = 0; a < last; a += CHUNK_SECTIONS) out.push([a, Math.min(last, a + CHUNK_SECTIONS)]);
  return out;
}

export interface RoadMeshes {
  road: Kn5MeshNode[];
  verge: Kn5MeshNode[];
  /** Per roundabout, the angle ranges its connectors cover (see Roundabout.openings). */
  openings: [number, number][][];
}

/** Picks the road material for chunk `ci` (mean width, middle sample). */
/**
 * Picks the road material for chunk `ci` (sections a..b). A plain name tiles
 * its texture along the road; `{ material, perChunk: true }` stretches one
 * texture over the whole chunk (the photo surface).
 */
export type RoadMaterialFn = (ci: number, meanWidth: number, mid: RoadSample, a: number, b: number) => string | { material: string; perChunk: true };

export function buildRoadMeshes(
  plan: RoadPlan,
  opts: BuildOptions,
  materialFor: RoadMaterialFn,
  /** Leave the verge out here (a side street's mouth). Side 1 = left. */
  vergeGap: (i: number, side: 1 | -1) => boolean = () => false,
): RoadMeshes {
  const samples = plan.samples;
  const n = samples.length;
  const at = (i: number) => samples[i % n];
  const road: RoadMeshes["road"] = [];
  const verge: Kn5MeshNode[] = [];
  const openings: [number, number][][] = plan.roundabouts.map(() => []);
  // Distance along the road for UVs; loops keep counting past the end.
  const sAt = (i: number) => (i >= n ? plan.length : samples[i].s);
  // Sections on a roundabout: the ring mesh covers those, so the ribbon stops.
  const onRing = (i: number) => !!inRoundabout(plan, at(i).pos[0], at(i).pos[1], 0.3);

  chunkRanges(plan).forEach(([a, b], ci) => {
    const rb = new MeshBuilder();
    const lanes = [0.5, 0.25, 0, -0.25, -0.5];
    let widthSum = 0;
    for (let i = a; i <= b; i++) widthSum += at(i).width;
    const meanWidth = widthSum / (b - a + 1);
    const choice = materialFor(ci, meanWidth, at(Math.floor((a + b) / 2)), a, b);
    const perChunk = typeof choice !== "string";
    const sa = sAt(a), sb = sAt(b);
    for (let i = a; i <= b; i++) {
      const s = at(i);
      const v = perChunk ? (sAt(i) - sa) / Math.max(1e-6, sb - sa) : sAt(i) / SEAL_LENGTH;
      lanes.forEach((f, j) => {
        const t = f * s.width;
        rb.vertex(point(s, t, surfaceHeight(s, t, opts.crown)), j / (lanes.length - 1), v);
      });
    }
    const cols = lanes.length;
    for (let r = 0; r < b - a; r++) {
      for (let j = 0; j < cols - 1; j++) {
        const p = r * cols + j;
        if (onRing(a + r) || onRing(a + r + 1)) continue;
        // back-left, back-right, front-right, front-left
        rb.quad(p, p + 1, p + cols + 1, p + cols);
      }
    }
    road.push(rb.toKn5(`1ROAD_${pad(ci)}`, typeof choice === "string" ? choice : choice.material));

    if (opts.vergeWidth > 0) {
      const vb = new MeshBuilder();
      // Left verge, laid out left to right: skirt bottom, outer edge, road edge.
      // Then the right verge: road edge, outer edge, skirt bottom.
      for (let i = a; i <= b; i++) {
        const s = at(i);
        const half = s.width / 2;
        const v = sAt(i) / 4;
        const eL = surfaceHeight(s, half, opts.crown), eR = surfaceHeight(s, -half, opts.crown);
        const oL = half + opts.vergeWidth, oR = -half - opts.vergeWidth;
        vb.vertex(point(s, oL, eL - VERGE_DROP - SKIRT_DEPTH), 0, v);
        vb.vertex(point(s, oL, eL - VERGE_DROP), 0.1, v);
        vb.vertex(point(s, half, eL), 1, v);
        vb.vertex(point(s, -half, eR), 1, v);
        vb.vertex(point(s, oR, eR - VERGE_DROP), 0.1, v);
        vb.vertex(point(s, oR, eR - VERGE_DROP - SKIRT_DEPTH), 0, v);
      }
      for (let r = 0; r < b - a; r++) {
        if (onRing(a + r) || onRing(a + r + 1)) continue;
        const p = r * 6, q = p + 6;
        if (!vergeGap(a + r, 1) && !vergeGap(a + r + 1, 1)) {
          vb.quad(p, p + 1, q + 1, q);
          vb.quad(p + 1, p + 2, q + 2, q + 1);
        }
        if (!vergeGap(a + r, -1) && !vergeGap(a + r + 1, -1)) {
          vb.quad(p + 3, p + 4, q + 4, q + 3);
          vb.quad(p + 4, p + 5, q + 5, q + 4);
        }
      }
      if (vb.indices.length) verge.push(vb.toKn5(`1GRASS_VERGE_${pad(ci)}`, "verge"));
    }
  });

  // Join the ribbon's last section before each ring to the ring's outer edge.
  plan.roundabouts.forEach((ring, k) => {
    const Ro = outerRadius(ring);
    const last = plan.closed ? n : n - 1;
    let j = 0;
    for (let i = 0; i < last; i++) {
      const a = onRing(i), b = onRing(i + 1);
      if (a === b) continue;
      const end = a ? i + 1 : i;
      const s = at(end);
      if (Math.hypot(s.pos[0] - ring.c[0], s.pos[1] - ring.c[1]) > Ro + 6) continue; // another ring's
      const half = s.width / 2;
      const L = point(s, half, surfaceHeight(s, half, opts.crown)), R = point(s, -half, surfaceHeight(s, -half, opts.crown));
      const ang = (p: Vec3) => Math.atan2(p[1] - ring.c[1], p[0] - ring.c[0]);
      const aL = ang(L);
      let dA = ang(R) - aL;
      while (dA > Math.PI) dA -= 2 * Math.PI;
      while (dA < -Math.PI) dA += 2 * Math.PI;
      // The ring's verge and kerb stay out of this, plus 2.5 m either side.
      const padA = 2.5 / Ro;
      openings[k].push(dA >= 0 ? [aL - padA, aL + dA + padA] : [aL + dA - padA, aL + padA]);
      const steps = Math.max(2, Math.ceil(Math.abs(dA) * Ro / 1.5));
      const arc: Vec3[] = [];
      for (let k2 = 0; k2 <= steps; k2++) {
        const t = aL + (dA * k2) / steps;
        arc.push([ring.c[0] + Math.cos(t) * Ro, ring.c[1] + Math.sin(t) * Ro, ringHeight(ring, Ro)]);
      }
      // L, the ring edge from L's side round to R's, then R, and back across the
      // road's end to L through points on its crown. Without those the patch
      // spans edge to edge and sags below the crowned road in the middle,
      // a 10-20 cm dip at every roundabout entry and exit.
      const across: Vec3[] = [-0.5, 0, 0.5].map((f) => point(s, f * half, surfaceHeight(s, f * half, opts.crown)));
      let poly: Vec3[] = [L, ...arc, R, ...across];
      let area = 0;
      for (let q = 0; q < poly.length; q++) {
        const p0 = poly[q], p1 = poly[(q + 1) % poly.length];
        area += p0[0] * p1[1] - p1[0] * p0[1];
      }
      if (area < 0) poly = poly.reverse();
      const mb = new MeshBuilder();
      for (const p of poly) mb.vertex(p, Math.hypot(p[0] - R[0], p[1] - R[1]) / s.width, sAt(end) / SEAL_LENGTH);
      const tris = earcut(poly.flatMap((p) => [p[0], p[1]]));
      for (let t = 0; t < tris.length; t += 3) {
        const [p0, p1, p2] = [poly[tris[t]], poly[tris[t + 1]], poly[tris[t + 2]]];
        const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        if (cross >= 0) mb.tri(tris[t], tris[t + 1], tris[t + 2]);
        else mb.tri(tris[t], tris[t + 2], tris[t + 1]);
      }
      const ci = Math.floor(end / CHUNK_SECTIONS);
      const m = materialFor(ci, s.width, s, -1, -1);
      if (mb.indices.length) road.push(mb.toKn5(`1ROAD_RBC${k}_${j++}`, typeof m === "string" ? m : m.material));
    }
  });
  return { road, verge, openings };
}

/**
 * Invisible walls each side of the road. The wall pulls in where another
 * stretch of the same road passes close by (switchbacks) and on the inside
 * of tight hairpins, so it never cuts across drivable road.
 */
export function buildWalls(plan: RoadPlan, opts: BuildOptions, terrain: HeightFn, index: SegmentIndex): Kn5MeshNode[] {
  if (opts.wallOffset <= 0) return [];
  const samples = plan.samples;
  const n = samples.length;
  const segs = index.segmentCount;
  const want = (s: RoadSample) => s.width / 2 + Math.max(opts.vergeWidth + 1, opts.wallOffset);

  // Clearance per side: half the gap to any other part of the road.
  const offsets = samples.map((s, i) => {
    const out: [number, number] = [want(s), want(s)];
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const reach = want(s) * 2 + 10;
      const skipNear = Math.ceil((reach * 2) / opts.spacing);
      const away = (seg: number) => {
        const d = Math.abs(seg - i);
        return Math.min(d, plan.closed ? segs - d : d) <= skipNear;
      };
      // Probe outward: the nearest other road on this side.
      const probe = index.nearest(s.pos[0] + s.left[0] * sign * reach * 0.5, s.pos[1] + s.left[1] * sign * reach * 0.5, reach, away);
      if (probe) {
        const o = samples[probe.seg].pos;
        const lateral = ((o[0] - s.pos[0]) * s.left[0] + (o[1] - s.pos[1]) * s.left[1]) * sign;
        if (lateral > 0) out[side] = Math.min(out[side], Math.max(s.width / 2 + 0.5, lateral / 2));
      }
      // Inside of a corner: stay within the turning radius.
      const k = s.curvature * sign;
      if (k > 1e-4) out[side] = Math.min(out[side], Math.max(s.width / 2 + 0.5, 0.85 / k));
    }
    return out;
  });

  const walls: Kn5MeshNode[] = [];
  for (const side of [0, 1] as const) {
    const sign = side === 0 ? 1 : -1;
    const last = plan.closed ? n : n - 1;
    for (let a = 0, ci = 0; a < last; a += CHUNK_SECTIONS, ci++) {
      const b = Math.min(last, a + CHUNK_SECTIONS);
      const wb = new MeshBuilder();
      for (let i = a; i <= b; i++) {
        const s = samples[i % n];
        const t = offsets[i % n][side] * sign;
        const p = point(s, t, 0);
        const ground = Math.min(terrain(p[0], p[1]), s.h);
        const top = Math.max(terrain(p[0], p[1]), s.h) + 4;
        // Front and back copies of each vertex, so each face gets its own normal.
        for (let k = 0; k < 2; k++) {
          wb.vertex([p[0], p[1], ground - 5], 0, 1);
          wb.vertex([p[0], p[1], top], 0, 0);
        }
      }
      // Near a roundabout the ring's own wall takes over.
      const nearRing = (i: number) => {
        const p = samples[i % n].pos;
        return !!inRoundabout(plan, p[0], p[1], Math.max(opts.vergeWidth + 1, opts.wallOffset) + 4);
      };
      for (let r = 0; r < b - a; r++) {
        if (nearRing(a + r) || nearRing(a + r + 1)) continue;
        const p = r * 4, q = p + 4;
        // Both windings, so the wall collides from either side.
        wb.quad(p, q, q + 1, p + 1);
        wb.quad(p + 2, p + 3, q + 3, q + 2);
      }
      walls.push(wb.toKn5(`1WALL_${side === 0 ? "L" : "R"}_${pad(ci)}`, "wall", { renderable: false, castShadows: false }));
    }
  }

  // Close off both ends of an open road just past the first and last sample.
  if (!plan.closed) {
    for (const [i, dir, label] of [[0, -1, "A"], [n - 1, 1, "B"]] as const) {
      const s = samples[i];
      const wb = new MeshBuilder();
      const cx = s.pos[0] + s.tan[0] * dir * 6, cy = s.pos[1] + s.tan[1] * dir * 6;
      const L = offsets[i][0] + 2, R = offsets[i][1] + 2;
      const left: Vec3 = [cx + s.left[0] * L, cy + s.left[1] * L, 0];
      const right: Vec3 = [cx - s.left[0] * R, cy - s.left[1] * R, 0];
      const lo = s.h - 6, hi = s.h + 5;
      for (let k = 0; k < 2; k++) {
        const a = wb.vertex([left[0], left[1], lo], 0, 1), b = wb.vertex([left[0], left[1], hi], 0, 0);
        const c = wb.vertex([right[0], right[1], lo], 1, 1), d = wb.vertex([right[0], right[1], hi], 1, 0);
        if (k === 0) wb.quad(a, c, d, b);
        else wb.quad(a, b, d, c);
      }
      walls.push(wb.toKn5(`1WALL_END_${label}`, "wall", { renderable: false, castShadows: false }));
    }
  }
  return walls;
}

export function pad(i: number): string {
  return String(i).padStart(3, "0");
}
