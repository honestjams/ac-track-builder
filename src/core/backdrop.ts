// Horizon scenery: a coarse, non-collidable terrain out to `horizon` metres,
// so the world doesn't end where the drivable corridor does. It sits a little
// below the real ground near the corridor, so the detailed terrain always
// covers it where the two overlap, and rises to the true height further out.

import type { HeightFn } from "./elevation";
import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder } from "./mesh";
import type { BuildOptions } from "./options";
import type { RoadPlan, SegmentIndex } from "./road";
import type { TerrainChunk } from "./terrain";

export const BACKDROP_CHUNK = 1000;
const STEP = 20;
const SINK = 3;

export function planBackdrop(plan: RoadPlan, index: SegmentIndex, opts: BuildOptions): TerrainChunk[] {
  if (opts.horizon <= 0) return [];
  const size = BACKDROP_CHUNK;
  const xs = plan.samples.map((s) => s.pos[0]), ys = plan.samples.map((s) => s.pos[1]);
  const x0 = Math.floor((Math.min(...xs) - opts.horizon) / size), x1 = Math.floor((Math.max(...xs) + opts.horizon) / size);
  const y0 = Math.floor((Math.min(...ys) - opts.horizon) / size), y1 = Math.floor((Math.max(...ys) + opts.horizon) / size);
  const out: TerrainChunk[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const minX = cx * size, minY = cy * size;
      if (!index.nearest(minX + size / 2, minY + size / 2, opts.horizon + size * 0.71)) continue;
      out.push({ key: `b${String(out.length).padStart(3, "0")}`, minX, minY, maxX: minX + size, maxY: minY + size });
    }
  }
  return out;
}

export function buildBackdropChunk(
  chunk: TerrainChunk,
  dem: HeightFn,
  index: SegmentIndex,
  opts: BuildOptions,
  textured: boolean,
): Kn5MeshNode | null {
  const cells = Math.round((chunk.maxX - chunk.minX) / STEP);
  const N = cells + 1;
  // Leave a hole well inside the detailed corridor; the overlap ring hides the seam.
  const hole = Math.max(0, opts.corridor - 2 * STEP);
  const keep = new Uint8Array(N * N);
  const hs = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = chunk.minX + i * STEP, y = chunk.minY + j * STEP;
      const near = index.nearest(x, y, opts.corridor + 300);
      const d = near ? near.dist : Infinity;
      keep[j * N + i] = d > hole ? 1 : 0;
      const t = Math.min(1, Math.max(0, (d - opts.corridor) / 300));
      hs[j * N + i] = dem(x, y) - SINK * (1 - t * t * (3 - 2 * t));
    }
  }
  const mb = new MeshBuilder();
  const vi = new Int32Array(N * N).fill(-1);
  const vert = (i: number, j: number) => {
    const k = j * N + i;
    if (vi[k] < 0) {
      const x = chunk.minX + i * STEP, y = chunk.minY + j * STEP;
      vi[k] = mb.vertex([x, y, hs[k]], textured ? i / cells : x / 40, textured ? 1 - j / cells : -y / 40);
    }
    return vi[k];
  };
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (!(keep[j * N + i] && keep[j * N + i + 1] && keep[(j + 1) * N + i] && keep[(j + 1) * N + i + 1])) continue;
      mb.quad(vert(i, j), vert(i + 1, j), vert(i + 1, j + 1), vert(i, j + 1));
    }
  }
  if (!mb.indices.length) return null;
  return mb.toKn5(`BACKDROP_${chunk.key}`, textured ? `backdrop_${chunk.key}` : "grass", { castShadows: false });
}
