// Roadside scenery: trees found in the aerial imagery, guard rails where the
// ground falls away (or where OSM maps one), and guide posts. Buildings
// live in buildings.ts.
//
// Trees and posts are visual only. Guard rails are collidable (their names
// start with 1WALL_).

import type { HeightFn } from "./elevation";
import type { Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import { MAX_MESH_VERTICES } from "./kn5";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { surfaceHeight, type RoadPlan, type SegmentIndex } from "./road";
import type { TerrainChunk } from "./terrain";
import { TREE_VARIANTS } from "./textures";
import { pad } from "./roadMesh";

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits mesh output into kn5-sized pieces as it grows. */
export class ChunkedMesh {
  private current = new MeshBuilder();
  readonly done: MeshBuilder[] = [];
  constructor(private readonly perItem: number) {}

  next(perItem = this.perItem): MeshBuilder {
    if (this.current.vertexCount + perItem > MAX_MESH_VERTICES) {
      this.done.push(this.current);
      this.current = new MeshBuilder();
      this.current.normals = [];
    }
    if (!this.current.normals) this.current.normals = [];
    return this.current;
  }

  all(): MeshBuilder[] {
    return [...this.done, this.current].filter((m) => m.indices.length > 0);
  }
}

/* ---------------- trees ---------------- */

export interface TreeSpot {
  x: number;
  y: number;
  scale: number;
  variant: number;
}

/**
 * Finds tree canopy in an aerial texture covering `chunk` (RGBA, north up).
 * Per cell: canopy is green-dominant (excess-green index), darker than open
 * grass, and textured (crowns and their shadows), where lawns and paddocks
 * are smooth.
 */
export function treeSpotsFromImagery(
  rgba: Uint8Array | Uint8ClampedArray,
  size: number,
  chunk: TerrainChunk,
  density: number,
): TreeSpot[] {
  if (density <= 0) return [];
  const span = chunk.maxX - chunk.minX;
  const cell = density >= 2 ? 4.5 : 6.5;
  const pxPerM = size / span;
  const cellPx = Math.max(2, Math.round(cell * pxPerM));
  const cells = Math.floor(size / cellPx);
  const rand = rng(Math.round(chunk.minX * 7 + chunk.minY * 13) | 0);
  const out: TreeSpot[] = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0, n = 0;
      for (let y = cy * cellPx; y < (cy + 1) * cellPx; y++) {
        for (let x = cx * cellPx; x < (cx + 1) * cellPx; x++) {
          const i = (y * size + x) * 4;
          const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255;
          const l = (r + g + b) / 3;
          sr += r; sg += g; sb += b; sl += l; sl2 += l * l; n++;
        }
      }
      const r = sr / n, g = sg / n, b = sb / n, l = sl / n;
      const std = Math.sqrt(Math.max(0, sl2 / n - l * l));
      const exg = (2 * g - r - b) / (r + g + b + 1e-6);
      const canopy = exg > 0.05 && l < 0.42 && l > 0.04 && std > 0.025;
      if (!canopy) continue;
      // Stronger signal, more likely a tree; keeps sparse scrub sparse.
      if (rand() > Math.min(1, 0.35 + (exg - 0.05) * 6)) continue;
      const px = (cx + 0.5 + (rand() - 0.5) * 0.95) * cellPx, py = (cy + 0.5 + (rand() - 0.5) * 0.95) * cellPx;
      out.push({
        x: chunk.minX + px / pxPerM,
        y: chunk.maxY - py / pxPerM,
        scale: 0.75 + rand() * 0.6,
        variant: rand() < 0.2 ? 1 : 0,
      });
    }
  }
  return out;
}

/** Crown radius of a tree sprite at scale 1, metres (half the quad width). */
export const CROWN_RADIUS = [12 * 0.85 / 2, 15 * 0.55 / 2];

/**
 * Keeps trunks off the road and verges and inside the terrain corridor.
 * Trees close to the road are scaled down so their crowns stop at the verge
 * instead of hanging over the asphalt. Caps the total for frame rate.
 */
export function filterTrees(spots: TreeSpot[], index: SegmentIndex, opts: BuildOptions, max: number): TreeSpot[] {
  const kept: TreeSpot[] = [];
  for (const t of spots) {
    const n = index.nearest(t.x, t.y, opts.corridor);
    if (!n || n.dist > opts.corridor - 3) continue;
    const room = n.dist - (index.at(n).width / 2 + opts.vergeWidth + 1.5);
    if (room <= 0) continue;
    const crown = CROWN_RADIUS[t.variant] * t.scale;
    if (crown * 0.6 <= room) kept.push(t);
    else if (room / (CROWN_RADIUS[t.variant] * 0.6) >= 0.5) kept.push({ ...t, scale: room / (CROWN_RADIUS[t.variant] * 0.6) });
  }
  if (kept.length <= max) return kept;
  // Thin evenly rather than cutting off whole areas.
  const step = kept.length / max;
  return Array.from({ length: max }, (_, i) => kept[Math.floor(i * step)]);
}

const TREE_PLANES = 3;
const TREE_VERTS = TREE_PLANES * 8;

/** Crossed-quad trees (three planes, both faces), alpha-tested. */
export function buildTrees(spots: TreeSpot[], ground: HeightFn): Kn5MeshNode[] {
  const rand = rng(99);
  const out = new ChunkedMesh(TREE_VERTS);
  for (const t of spots) {
    const mb = out.next();
    const v = TREE_VARIANTS[t.variant];
    const H = (v.kind === "conifer" ? 15 : 12) * t.scale;
    const W = CROWN_RADIUS[t.variant] * 2 * t.scale;
    const z = ground(t.x, t.y) - 0.3;
    const rot = rand() * Math.PI;
    for (let p = 0; p < TREE_PLANES; p++) {
      const a = rot + (p * Math.PI) / TREE_PLANES;
      const dx = Math.cos(a) * W / 2, dy = Math.sin(a) * W / 2;
      // Face normal, tilted strongly upward so foliage lights like a canopy.
      const fx = Math.sin(a), fy = -Math.cos(a);
      for (const side of [1, -1]) {
        const nx = fx * side * 0.35, ny = fy * side * 0.35, l = Math.hypot(nx, ny, 1);
        const base = mb.vertexCount;
        const corners: [Vec3, number, number][] = [
          [[t.x - dx, t.y - dy, z], v.u0, 1],
          [[t.x + dx, t.y + dy, z], v.u1, 1],
          [[t.x + dx, t.y + dy, z + H], v.u1, 0],
          [[t.x - dx, t.y - dy, z + H], v.u0, 0],
        ];
        for (const [pos, u, vv] of corners) {
          mb.vertex(pos, u, vv);
          mb.normals!.push(nx / l, ny / l, 1 / l);
        }
        if (side === 1) mb.quad(base, base + 1, base + 2, base + 3);
        else mb.quad(base, base + 3, base + 2, base + 1);
      }
    }
  }
  return out.all().map((mb, i) => mb.toKn5(`TREES_${pad(i)}`, "trees", { castShadows: true }));
}

/* ---------------- boxes ---------------- */

/**
 * Axis-aligned-to-the-road box: `along` is the unit direction of its length.
 * Faces wind counter-clockwise from outside.
 */
function box(mb: MeshBuilder, c: Vec2, along: Vec2, length: number, depth: number, z0: number, z1: number): void {
  const ax = along[0] * length / 2, ay = along[1] * length / 2;
  const bx = -along[1] * depth / 2, by = along[0] * depth / 2;
  const corners: Vec2[] = [
    [c[0] - ax - bx, c[1] - ay - by],
    [c[0] + ax - bx, c[1] + ay - by],
    [c[0] + ax + bx, c[1] + ay + by],
    [c[0] - ax + bx, c[1] - ay + by],
  ];
  // Sides: corners run counter-clockwise from above, so each edge's outside is to its right.
  for (let k = 0; k < 4; k++) {
    const p = corners[k], q = corners[(k + 1) % 4];
    const ex = q[0] - p[0], ey = q[1] - p[1], el = Math.hypot(ex, ey) || 1;
    const n: Vec3 = [ey / el, -ex / el, 0];
    const i = mb.vertexCount;
    mb.vertex([p[0], p[1], z0], 0, 1);
    mb.vertex([q[0], q[1], z0], 1, 1);
    mb.vertex([q[0], q[1], z1], 1, 0);
    mb.vertex([p[0], p[1], z1], 0, 0);
    for (let j = 0; j < 4; j++) mb.normals!.push(...n);
    mb.quad(i, i + 1, i + 2, i + 3);
  }
  const i = mb.vertexCount;
  for (const p of corners) {
    mb.vertex([p[0], p[1], z1], 0, 0);
    mb.normals!.push(0, 0, 1);
  }
  mb.quad(i, i + 1, i + 2, i + 3);
}

/* ---------------- guard rails and guide posts ---------------- */

const RAIL_BOTTOM = 0.45;
const RAIL_TOP = 0.8;

/** Which samples need a rail, per side [left, right]. */
export function railNeeds(
  plan: RoadPlan,
  opts: BuildOptions,
  ground: HeightFn,
  osmRails: Vec2[][],
  index: SegmentIndex,
): [boolean[], boolean[]] {
  const n = plan.samples.length;
  const needs: [boolean[], boolean[]] = [new Array(n).fill(false), new Array(n).fill(false)];
  plan.samples.forEach((s, i) => {
    const half = s.width / 2;
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      const edge = surfaceHeight(s, sign * half, opts.crown);
      let low = Infinity;
      for (const d of [3, 7]) {
        const t = sign * (half + opts.vergeWidth + d);
        low = Math.min(low, ground(s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t));
      }
      if (edge - low > 1.8) needs[side][i] = true;
    }
  });
  for (const line of osmRails) {
    for (const p of line) {
      const near = index.nearest(p[0], p[1], 12);
      if (!near) continue;
      const side = near.t >= 0 ? 0 : 1;
      for (let k = -3; k <= 3; k++) {
        const i = near.seg + k;
        if (i >= 0 && i < n) needs[side][i] = true;
      }
    }
  }
  // Bridge short gaps, then drop runs too short to be worth a rail.
  for (const need of needs) {
    const gap = Math.round(10 / opts.spacing), minRun = Math.round(24 / opts.spacing);
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!need[i]) continue;
      if (last >= 0 && i - last > 1 && i - last <= gap) for (let k = last; k < i; k++) need[k] = true;
      last = i;
    }
    for (let i = 0; i < n;) {
      if (!need[i]) { i++; continue; }
      let j = i;
      while (j < n && need[j]) j++;
      if (j - i < minRun) for (let k = i; k < j; k++) need[k] = false;
      i = j;
    }
  }
  return needs;
}

export function buildGuardRails(
  plan: RoadPlan,
  opts: BuildOptions,
  needs: [boolean[], boolean[]],
): { rails: Kn5MeshNode[]; posts: Kn5MeshNode[] } {
  const rails: Kn5MeshNode[] = [];
  const posts = new ChunkedMesh(20);
  const s = plan.samples;
  const postEvery = Math.max(1, Math.round(4 / opts.spacing));
  for (const side of [0, 1] as const) {
    const sign = side === 0 ? 1 : -1;
    const need = needs[side];
    let run = 0;
    for (let i = 0; i < s.length;) {
      if (!need[i]) { i++; continue; }
      let j = i;
      while (j < s.length && need[j]) j++;
      const mb = new MeshBuilder();
      mb.normals = [];
      for (let k = i; k < j; k++) {
        const p = s[k];
        const half = p.width / 2;
        const t = sign * (half + opts.vergeWidth * 0.55);
        const z = surfaceHeight(p, sign * half, opts.crown) - 0.2 * 0.55;
        const x = p.pos[0] + p.left[0] * t, y = p.pos[1] + p.left[1] * t;
        const u = p.s / 4;
        // Front (facing the road) and back faces, separate vertices for their normals.
        const nIn: Vec3 = [-p.left[0] * sign, -p.left[1] * sign, 0];
        for (const n of [nIn, [-nIn[0], -nIn[1], 0] as Vec3]) {
          mb.vertex([x, y, z + RAIL_BOTTOM], u, 1);
          mb.vertex([x, y, z + RAIL_TOP], u, 0);
          mb.normals.push(...n, ...n);
        }
        if ((k - i) % postEvery === 0) {
          const back = 0.08 * sign;
          box(posts.next(), [x + p.left[0] * back, y + p.left[1] * back], p.tan, 0.1, 0.1, z - 0.4, z + RAIL_TOP - 0.03);
        }
      }
      for (let k = 0; k < j - i - 1; k++) {
        const a = k * 4, b = a + 4;
        // Front face winds toward the road; the back face the other way.
        if (sign < 0) {
          mb.quad(a, a + 1, b + 1, b);
          mb.quad(a + 2, b + 2, b + 3, a + 3);
        } else {
          mb.quad(a, b, b + 1, a + 1);
          mb.quad(a + 2, a + 3, b + 3, b + 2);
        }
      }
      if (j - i > 1) rails.push(mb.toKn5(`1WALL_RAIL_${side === 0 ? "L" : "R"}_${pad(run++)}`, "rail", { castShadows: true }));
      i = j;
    }
  }
  return { rails, posts: posts.all().map((m, i) => m.toKn5(`RAILPOSTS_${pad(i)}`, "steel")) };
}

/** White guide posts every 50 m each side, except where a rail runs. */
export function buildGuidePosts(plan: RoadPlan, opts: BuildOptions, needs: [boolean[], boolean[]]): Kn5MeshNode[] {
  const out = new ChunkedMesh(20);
  const every = Math.max(1, Math.round(50 / opts.spacing));
  const skip = Math.round(30 / opts.spacing);
  const s = plan.samples;
  for (let i = skip; i < s.length - skip; i += every) {
    const p = s[i];
    for (const side of [0, 1] as const) {
      if (needs[side].slice(Math.max(0, i - 5), i + 6).some(Boolean)) continue;
      const sign = side === 0 ? 1 : -1;
      const half = p.width / 2;
      const t = sign * (half + opts.vergeWidth * 0.75);
      const z = surfaceHeight(p, sign * half, opts.crown) - 0.2 * 0.75;
      box(out.next(), [p.pos[0] + p.left[0] * t, p.pos[1] + p.left[1] * t], p.tan, 0.1, 0.05, z - 0.3, z + 1.0);
    }
  }
  return out.all().map((m, i) => m.toKn5(`GUIDEPOSTS_${pad(i)}`, "guidepost"));
}
