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
      const base = ringHeight(rb, outerRadius(rb)) - BELOW_VERGE + (rb.kerbed ? BELOW_VERGE + KERB_H - 0.03 : 0);
      if (d <= edge) return { h: underRoad(ringHeight(rb, Math.min(d, outerRadius(rb))), base, edge - d, opts), dist: Math.min(fromRoad.dist, 0) };
      if (fromRoad.dist <= fromRoad.inner) return fromRoad;
      const f = smoothstep((d - edge) / opts.terrainBlend);
      const h = base + (dem(x, y) - base) * f;
      // Blend toward whichever feature pulls the ground further from the DEM.
      const ground = dem(x, y);
      return Math.abs(h - ground) > Math.abs(fromRoad.h - ground) ? { h, dist: Math.min(fromRoad.dist, d) } : fromRoad;
    }
    return fromRoad;
  };
}

/**
 * Ground under the road, verges and kerbs: dropped below them so it never
 * pokes through, rising in a straight line over the last two grid cells to meet
 * the ground beyond. A full drop right up to the edge would drag the grid's
 * next cell down with it, a ditch along the road; a straight ramp is exactly
 * what the grid draws, so the ground lands where it is meant to.
 */
function underRoad(surface: number, beyond: number, fromEdge: number, opts: BuildOptions): number {
  const k = Math.min(1, Math.max(0, fromEdge) / (2 * opts.terrainStep));
  return beyond + (surface - opts.terrainUnderRoad - beyond) * k;
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
    const base = edge - BELOW_VERGE + (BELOW_VERGE + KERB_H - 0.03) * v.kerb;
    if (!beyondEnd && n.dist <= inner) return { h: underRoad(edge, base, inner - n.dist, opts), dist: n.dist, inner };
    const f = smoothstep((n.dist - inner) / opts.terrainBlend);
    return { h: base + (ground - base) * f, dist: n.dist, inner };
  };
}

/** Largest height error a level-of-detail block may make, metres: tighter near the road, where kerbs, paths and driveways sit a few centimetres up. */
const LOD_TOL = 0.02, LOD_TOL_FAR = 0.05, LOD_FAR = 40;

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
  const dists = new Float32Array(P * P);
  for (let j = 0; j < P; j++) {
    for (let i = 0; i < P; i++) {
      const x = chunk.minX + (i - 1) * step, y = chunk.minY + (j - 1) * step;
      const s = terrain(x, y);
      hs[j * P + i] = s.h;
      inside[j * P + i] = s.dist <= opts.corridor ? 1 : 0;
      dists[j * P + i] = s.dist;
    }
  }
  const id = (i: number, j: number) => (j + 1) * P + (i + 1);

  const quadIn = (i: number, j: number) => inside[id(i, j)] && inside[id(i + 1, j)] && inside[id(i, j + 1)] && inside[id(i + 1, j + 1)];

  // Level of detail: away from the road, a K x K block of cells that is flat
  // enough (every node within LOD_TOL of the plane through its corners) is
  // drawn as one fan from its centre node instead of 2 K^2 triangles. Its
  // boundary keeps the in-between nodes along any edge it shares with fine
  // cells or another chunk, so there are no T-junctions and no cracks.
  const K = 4;
  const B = opts.terrainLod ? Math.floor(cells / K) : 0;
  const coarse = new Uint8Array(B * B);
  for (let bj = 0; bj < B; bj++) {
    for (let bi = 0; bi < B; bi++) {
      const i0 = bi * K, j0 = bj * K;
      let ok = true;
      const h00 = hs[id(i0, j0)], h10 = hs[id(i0 + K, j0)], h01 = hs[id(i0, j0 + K)], h11 = hs[id(i0 + K, j0 + K)];
      for (let j = j0; ok && j <= j0 + K; j++) {
        for (let i = i0; ok && i <= i0 + K; i++) {
          if (i < i0 + K && j < j0 + K && !quadIn(i, j)) ok = false;
          else if (dists[id(i, j)] < opts.terrainLodNear) ok = false;
          else {
            const u = (i - i0) / K, v = (j - j0) / K;
            const flat = h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
            if (Math.abs(hs[id(i, j)] - flat) > (dists[id(i, j)] < LOD_FAR ? LOD_TOL : (opts.terrainLodFarTol ?? LOD_TOL_FAR))) ok = false;
          }
        }
      }
      coarse[bj * B + bi] = ok ? 1 : 0;
    }
  }
  const isCoarse = (bi: number, bj: number) => bi >= 0 && bj >= 0 && bi < B && bj < B && coarse[bj * B + bi] === 1;
  const inCoarse = (i: number, j: number) => isCoarse(Math.floor(i / K), Math.floor(j / K)) && i < B * K && j < B * K;

  // A second level. Well away from the road, a 4 x 4 group of coarse blocks that is
  // flat as a whole (every node within the far tolerance of the plane through the group's corners)
  // is one fan too: big flat back yards and paddocks were most of a wide build's triangles.
  const S = 4, KS = K * S;
  const B2 = opts.terrainLod ? Math.floor(B / S) : 0;
  const sup = new Uint8Array(B2 * B2);
  for (let sj = 0; sj < B2; sj++) {
    for (let si = 0; si < B2; si++) {
      let ok = true;
      for (let bj = sj * S; ok && bj < sj * S + S; bj++) for (let bi = si * S; ok && bi < si * S + S; bi++) if (!isCoarse(bi, bj)) ok = false;
      const i0 = si * KS, j0 = sj * KS;
      const h00 = hs[id(i0, j0)], h10 = hs[id(i0 + KS, j0)], h01 = hs[id(i0, j0 + KS)], h11 = hs[id(i0 + KS, j0 + KS)];
      for (let j = j0; ok && j <= j0 + KS; j++) {
        for (let i = i0; ok && i <= i0 + KS; i++) {
          if (dists[id(i, j)] < LOD_FAR) { ok = false; break; }
          const u = (i - i0) / KS, v = (j - j0) / KS;
          const flat = h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
          if (Math.abs(hs[id(i, j)] - flat) > (opts.terrainLodFarTol ?? LOD_TOL_FAR)) ok = false;
        }
      }
      sup[sj * B2 + si] = ok ? 1 : 0;
    }
  }
  const isSuper = (si: number, sj: number) => si >= 0 && sj >= 0 && si < B2 && sj < B2 && sup[sj * B2 + si] === 1;
  const inSuper = (bi: number, bj: number) => isSuper(Math.floor(bi / S), Math.floor(bj / S)) && bi < B2 * S && bj < B2 * S;

  const used = new Uint8Array(N * N);
  const quads: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (inCoarse(i, j) || !quadIn(i, j)) continue;
      quads.push(i, j);
      used[j * N + i] = used[j * N + i + 1] = used[(j + 1) * N + i] = used[(j + 1) * N + i + 1] = 1;
    }
  }
  // Each coarse block's boundary loop (counter-clockwise from above) and centre.
  const fans: number[][] = [];
  for (let bj = 0; bj < B; bj++) {
    for (let bi = 0; bi < B; bi++) {
      if (!isCoarse(bi, bj) || inSuper(bi, bj)) continue;
      const i0 = bi * K, j0 = bj * K;
      const loop: [number, number][] = [];
      // Edges: south (j0, i rising), east (i0+K, j rising), north (j0+K, i falling), west (i0, j falling).
      const edges: [number, number, number, number, boolean][] = [
        [i0, j0, 1, 0, isCoarse(bi, bj - 1)],
        [i0 + K, j0, 0, 1, isCoarse(bi + 1, bj)],
        [i0 + K, j0 + K, -1, 0, isCoarse(bi, bj + 1)],
        [i0, j0 + K, 0, -1, isCoarse(bi - 1, bj)],
      ];
      for (const [si, sj, di, dj, both] of edges) {
        for (let k = 0; k < K; k++) {
          if (k > 0 && both) continue; // a coarse neighbour: corners only
          loop.push([si + di * k, sj + dj * k]);
        }
      }
      const c: [number, number] = [i0 + K / 2, j0 + K / 2];
      for (const [i, j] of [...loop, c]) used[j * N + i] = 1;
      fans.push([c[0], c[1], ...loop.flat()]);
    }
  }
  // The second level's fans. Along each edge a node is kept wherever the block beside it has one:
  // every node beside fine cells, every K beside a coarse block, only the corners beside another
  // second-level block (whose coarse blocks aren't drawn, so they don't count as coarse there).
  const kind = (bi: number, bj: number) => (inSuper(bi, bj) ? 2 : isCoarse(bi, bj) ? 1 : 0);
  for (let sj = 0; sj < B2; sj++) {
    for (let si = 0; si < B2; si++) {
      if (!isSuper(si, sj)) continue;
      const i0 = si * KS, j0 = sj * KS;
      const loop: [number, number][] = [];
      // [start i, start j, di, dj, the neighbouring block row/column across this edge]
      const edges: [number, number, number, number][] = [[i0, j0, 1, 0], [i0 + KS, j0, 0, 1], [i0 + KS, j0 + KS, -1, 0], [i0, j0 + KS, 0, -1]];
      edges.forEach(([sI, sJ, di, dj], e) => {
        // The neighbour's kind beside the segment from node k to node k + 1.
        const beside = (k: number) => {
          if (k < 0 || k >= KS) return 2;
          const ci = Math.min(sI + di * k, sI + di * (k + 1)), cj = Math.min(sJ + dj * k, sJ + dj * (k + 1));
          const bi = e === 1 ? si * S + S : e === 3 ? si * S - 1 : Math.floor(ci / K);
          const bj = e === 0 ? sj * S - 1 : e === 2 ? sj * S + S : Math.floor(cj / K);
          return kind(bi, bj);
        };
        const needs = (t: number, k: number) => t === 0 || (t === 1 && k % K === 0);
        for (let k = 0; k < KS; k++) {
          if (k > 0 && !needs(beside(k), k) && !needs(beside(k - 1), k)) continue;
          loop.push([sI + di * k, sJ + dj * k]);
        }
      });
      const c: [number, number] = [i0 + KS / 2, j0 + KS / 2];
      for (const [i, j] of [...loop, c]) used[j * N + i] = 1;
      fans.push([c[0], c[1], ...loop.flat()]);
    }
  }
  if (!quads.length && !fans.length) return null;

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
  for (const f of fans) {
    const c = vi[f[1] * N + f[0]];
    const n = (f.length - 2) / 2;
    for (let k = 0; k < n; k++) {
      const a = vi[f[3 + k * 2] * N + f[2 + k * 2]], b = vi[f[3 + ((k + 1) % n) * 2] * N + f[2 + ((k + 1) % n) * 2]];
      mb.tri(c, a, b);
    }
  }
  const material = textured ? `terrain_${chunk.key}` : "grass";
  return mb.toKn5(`1GRASS_${chunk.key}`, material);
}
