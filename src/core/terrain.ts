// Terrain: a regular grid in square chunks, kept only within `corridor`
// metres of the road. Heights come from the DEM, pulled down to the road
// level near the road so it sits on an embankment or in a cutting the way a
// real road does, and dropped just below the asphalt and verges so they never
// z-fight or poke through.

import type { HeightFn } from "./elevation";
import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder } from "./mesh";
import type { BuildOptions } from "./options";
import type { RoadPlan, SegmentIndex } from "./road";
import { outerRadius, ringHeight } from "./roundabout";
import { KERB_H, STRIP_EXTRA } from "./kerbs";

export interface TerrainChunk {
  key: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const BELOW_VERGE = 0.25;

export function planTerrainChunks(plan: RoadPlan, index: SegmentIndex, opts: BuildOptions): TerrainChunk[] {
  const size = opts.chunkSize;
  const reach = opts.corridor + size * 0.75;
  const xs = plan.samples.map((s) => s.pos[0]), ys = plan.samples.map((s) => s.pos[1]);
  const x0 = Math.floor((Math.min(...xs) - opts.corridor) / size), x1 = Math.floor((Math.max(...xs) + opts.corridor) / size);
  const y0 = Math.floor((Math.min(...ys) - opts.corridor) / size), y1 = Math.floor((Math.max(...ys) + opts.corridor) / size);
  const chunks: TerrainChunk[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const minX = cx * size, minY = cy * size;
      if (!index.nearest(minX + size / 2, minY + size / 2, reach)) continue;
      chunks.push({ key: `t${String(chunks.length).padStart(3, "0")}`, minX, minY, maxX: minX + size, maxY: minY + size });
    }
  }
  return chunks;
}

const smoothstep = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

export interface TerrainSample {
  h: number;
  /** Distance to the road centreline (Infinity when beyond the corridor). */
  dist: number;
}

/** The finished ground height anywhere: DEM blended into the road. */
export function makeTerrainFn(plan: RoadPlan, index: SegmentIndex, dem: HeightFn, opts: BuildOptions): (x: number, y: number) => TerrainSample {
  const lastSeg = index.segmentCount - 1;
  const road = roadTerrain(plan, index, dem, opts, lastSeg);
  return (x, y) => {
    const fromRoad = road(x, y);
    // A roundabout is a level disc; near one, whichever edge is closer wins.
    for (const rb of plan.roundabouts) {
      const d = Math.hypot(x - rb.c[0], y - rb.c[1]);
      const edge = outerRadius(rb) + opts.vergeWidth;
      if (d > edge + opts.terrainBlend) continue;
      if (d <= edge) return { h: ringHeight(rb, Math.min(d, outerRadius(rb))) - opts.terrainUnderRoad, dist: Math.min(fromRoad.dist, 0) };
      if (fromRoad.dist <= fromRoad.inner) return fromRoad;
      const base = ringHeight(rb, outerRadius(rb)) - BELOW_VERGE + (rb.kerbed ? BELOW_VERGE + KERB_H - 0.03 : 0);
      const f = smoothstep((d - edge) / opts.terrainBlend);
      const h = base + (dem(x, y) - base) * f;
      // Blend toward whichever feature pulls the ground further from the DEM.
      const ground = dem(x, y);
      return Math.abs(h - ground) > Math.abs(fromRoad.h - ground) ? { h, dist: Math.min(fromRoad.dist, d) } : fromRoad;
    }
    return fromRoad;
  };
}

function roadTerrain(plan: RoadPlan, index: SegmentIndex, dem: HeightFn, opts: BuildOptions, lastSeg: number) {
  return (x: number, y: number): TerrainSample & { inner: number } => {
    const ground = dem(x, y);
    const n = index.nearest(x, y, opts.corridor + opts.terrainBlend + 10);
    if (!n) return { h: ground, dist: Infinity, inner: 0 };
    const v = index.at(n);
    const half = v.width / 2;
    // Behind a kerb the ground starts at nature strip height, past the strip.
    const inner = half + opts.vergeWidth + (v.kerb > 0 ? STRIP_EXTRA : 0);
    const tc = Math.max(-half, Math.min(half, n.t));
    const edge = v.h + v.bank * tc - opts.crown * Math.abs(tc);
    const beyondEnd = !plan.closed && ((n.seg === 0 && n.frac === 0) || (n.seg === lastSeg && n.frac === 1));
    if (!beyondEnd && n.dist <= inner) return { h: edge - opts.terrainUnderRoad, dist: n.dist, inner };
    const base = edge - BELOW_VERGE + (BELOW_VERGE + KERB_H - 0.03) * v.kerb;
    const f = smoothstep((n.dist - inner) / opts.terrainBlend);
    return { h: base + (ground - base) * f, dist: n.dist, inner };
  };
}

export function buildTerrainChunk(
  chunk: TerrainChunk,
  terrain: (x: number, y: number) => TerrainSample,
  opts: BuildOptions,
  textured: boolean,
): Kn5MeshNode | null {
  const size = chunk.maxX - chunk.minX;
  const cells = Math.max(1, Math.round(size / opts.terrainStep));
  const step = size / cells;
  const N = cells + 1;
  // Heights on a grid padded by one node each side, for seamless normals.
  const P = N + 2;
  const hs = new Float32Array(P * P);
  const inside = new Uint8Array(P * P);
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      const x = chunk.minX + (i - 1) * step, y = chunk.minY + (j - 1) * step;
      const s = terrain(x, y);
      hs[j * P + i] = s.h;
      inside[j * P + i] = s.dist <= opts.corridor ? 1 : 0;
    }
  }
  const id = (i: number, j: number) => (j + 1) * P + (i + 1);

  const used = new Uint8Array(N * N);
  const quads: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (inside[id(i, j)] && inside[id(i + 1, j)] && inside[id(i, j + 1)] && inside[id(i + 1, j + 1)]) {
        quads.push(i, j);
        used[j * N + i] = used[j * N + i + 1] = used[(j + 1) * N + i] = used[(j + 1) * N + i + 1] = 1;
      }
    }
  }
  if (!quads.length) return null;

  const mb = new MeshBuilder();
  mb.normals = [];
  const vi = new Int32Array(N * N).fill(-1);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!used[j * N + i]) continue;
      const x = chunk.minX + i * step, y = chunk.minY + j * step;
      const u = textured ? i / cells : x / 10;
      const v = textured ? 1 - j / cells : -y / 10;
      vi[j * N + i] = mb.vertex([x, y, hs[id(i, j)]], u, v);
      const dx = (hs[id(i + 1, j)] - hs[id(i - 1, j)]) / (2 * step);
      const dy = (hs[id(i, j + 1)] - hs[id(i, j - 1)]) / (2 * step);
      const l = Math.hypot(dx, dy, 1);
      mb.normals.push(-dx / l, -dy / l, 1 / l);
    }
  }
  for (let q = 0; q < quads.length; q += 2) {
    const i = quads[q], j = quads[q + 1];
    const a = vi[j * N + i], b = vi[j * N + i + 1], c = vi[(j + 1) * N + i + 1], d = vi[(j + 1) * N + i];
    // y grows north, so a-b-c-d runs counter-clockwise seen from above.
    if ((i + j) % 2 === 0) mb.quad(a, b, c, d);
    else mb.quad(b, c, d, a);
  }
  const material = textured ? `terrain_${chunk.key}` : "grass";
  return mb.toKn5(`1GRASS_${chunk.key}`, material);
}
