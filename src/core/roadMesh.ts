// Road surface, verges and invisible walls, built as ribbons along the samples
// and split into chunks along the road (kn5 meshes hold at most 65535
// vertices, and smaller meshes cull better in game).

import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { surfaceHeight, type RoadPlan, type RoadSample, SegmentIndex } from "./road";
import type { HeightFn } from "./elevation";

/** Road texture repeats every this many metres along the road. */
export const ROAD_TEXTURE_LENGTH = 12;
const VERGE_DROP = 0.2;
const SKIRT_DEPTH = 0.8;
const CHUNK_SECTIONS = 120;

function point(s: RoadSample, t: number, z: number): Vec3 {
  return [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t, z];
}

/** Section index ranges [start, end] (inclusive) for each chunk. */
function chunkRanges(plan: RoadPlan): [number, number][] {
  const n = plan.samples.length;
  const last = plan.closed ? n : n - 1; // closed roads wrap back to sample 0
  const out: [number, number][] = [];
  for (let a = 0; a < last; a += CHUNK_SECTIONS) out.push([a, Math.min(last, a + CHUNK_SECTIONS)]);
  return out;
}

export interface RoadMeshes {
  road: { mesh: Kn5MeshNode; twoLane: boolean }[];
  verge: Kn5MeshNode[];
}

export function buildRoadMeshes(plan: RoadPlan, opts: BuildOptions): RoadMeshes {
  const samples = plan.samples;
  const n = samples.length;
  const at = (i: number) => samples[i % n];
  const road: RoadMeshes["road"] = [];
  const verge: Kn5MeshNode[] = [];
  // Distance along the road for UVs; loops keep counting past the end.
  const sAt = (i: number) => (i >= n ? plan.length : samples[i].s);

  chunkRanges(plan).forEach(([a, b], ci) => {
    const rb = new MeshBuilder();
    const lanes = [0.5, 0.25, 0, -0.25, -0.5];
    let widthSum = 0;
    for (let i = a; i <= b; i++) {
      const s = at(i);
      widthSum += s.width;
      const v = sAt(i) / ROAD_TEXTURE_LENGTH;
      lanes.forEach((f, j) => {
        const t = f * s.width;
        rb.vertex(point(s, t, surfaceHeight(s, t, opts.crown)), j / (lanes.length - 1), v);
      });
    }
    const cols = lanes.length;
    for (let r = 0; r < b - a; r++) {
      for (let j = 0; j < cols - 1; j++) {
        const p = r * cols + j;
        // back-left, back-right, front-right, front-left
        rb.quad(p, p + 1, p + cols + 1, p + cols);
      }
    }
    const meanWidth = widthSum / (b - a + 1);
    road.push({ mesh: rb.toKn5(`1ROAD_${pad(ci)}`, meanWidth >= 5.5 ? "road_2lane" : "road_1lane"), twoLane: meanWidth >= 5.5 });

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
        const p = r * 6, q = p + 6;
        vb.quad(p, p + 1, q + 1, q);
        vb.quad(p + 1, p + 2, q + 2, q + 1);
        vb.quad(p + 3, p + 4, q + 4, q + 3);
        vb.quad(p + 4, p + 5, q + 5, q + 4);
      }
      verge.push(vb.toKn5(`1GRASS_VERGE_${pad(ci)}`, "verge"));
    }
  });
  return { road, verge };
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
      for (let r = 0; r < b - a; r++) {
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
