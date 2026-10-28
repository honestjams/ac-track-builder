// Fences, garden walls and hedges along property lines, where OpenStreetMap
// maps them (barrier=fence|wall|hedge|retaining_wall). In an Australian
// suburb that's mostly Colorbond panels and timber palings down the sides
// and backs of lots, low brick walls and hedges along the front.
//
// They follow the ground, stand on it (a little below, so no gap shows),
// and are solid. Nothing is built within reach of the route's asphalt,
// verge or nature strip, or across a side street: a mapping error must never
// put a wall on the racing line.

import type { HeightFn } from "./elevation";
import type { Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import type { SegmentIndex } from "./road";
import { pad } from "./roadMesh";
import { BARRIERS } from "./textures";

export interface Barrier {
  pts: Vec2[];
  /** OSM barrier value. */
  kind: "fence" | "wall" | "hedge" | "retaining_wall";
  /** OSM fence_type, material, height where tagged. */
  fenceType?: string;
  material?: string;
  height?: number;
}

type Look = (typeof BARRIERS)[number];

/** How a barrier looks, how tall and how thick it is. */
export function barrierStyle(b: Barrier): { look: Look; height: number; thick: number } {
  const tagged = b.height && b.height > 0.3 && b.height < 4 ? b.height : undefined;
  if (b.kind === "hedge") return { look: "hedge", height: tagged ?? 1.5, thick: 0.8 };
  if (b.kind === "wall" || b.kind === "retaining_wall") {
    return { look: "brickwall", height: tagged ?? (b.kind === "retaining_wall" ? 0.8 : 1.2), thick: 0.23 };
  }
  const t = `${b.fenceType ?? ""} ${b.material ?? ""}`;
  if (/wood|paling|timber|picket/.test(t)) return { look: "paling", height: tagged ?? 1.8, thick: 0.05 };
  return { look: "colorbond", height: tagged ?? 1.8, thick: 0.05 };
}

const STEP = 2; // follow the ground every 2 m

/**
 * Solid barriers, one mesh set per look. `clear` says a point is fine to
 * build on (off the road, its verges and other streets).
 */
export function buildBarriers(
  barriers: Barrier[],
  index: SegmentIndex,
  opts: BuildOptions,
  ground: HeightFn,
  clear: (x: number, y: number) => boolean,
): Kn5MeshNode[] {
  const meshes = new Map<Look, MeshBuilder[]>();
  const mesh = (look: Look, verts: number) => {
    const list = meshes.get(look) ?? [];
    if (!list.length || list[list.length - 1].vertexCount + verts > 60000) list.push(new MeshBuilder());
    meshes.set(look, list);
    return list[list.length - 1];
  };
  // Keep well back from the route: asphalt, verge, nature strip and a margin.
  const offRoute = (x: number, y: number) => {
    const n = index.nearest(x, y, 30);
    return !n || n.dist > index.at(n).width / 2 + opts.vergeWidth + 2.5;
  };
  const near = (x: number, y: number) => !!index.nearest(x, y, opts.corridor - 2);

  for (const b of barriers) {
    const st = barrierStyle(b);
    // Walk the line in short steps, building only the runs that are clear.
    for (let k = 1; k < b.pts.length; k++) {
      const a = b.pts[k - 1], c = b.pts[k];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 0.2) continue;
      const n = Math.max(1, Math.ceil(len / STEP));
      for (let j = 0; j < n; j++) {
        const p = lerp(a, c, j / n), q = lerp(a, c, (j + 1) / n);
        const mid = lerp(p, q, 0.5);
        if (![p, q, mid].every(([x, y]) => clear(x, y) && offRoute(x, y) && near(x, y))) continue;
        slab(mesh(st.look, 24), p, q, st.thick, st.height, ground, len, j / n, (j + 1) / n);
      }
    }
  }
  const out: Kn5MeshNode[] = [];
  for (const [look, list] of meshes) {
    list.forEach((mb, i) => {
      if (mb.indices.length) out.push(mb.toKn5(`1WALL_FENCE_${look.toUpperCase()}_${pad(i)}`, `barrier_${look}`));
    });
  }
  return out;
}

function lerp(a: Vec2, b: Vec2, f: number): Vec2 {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** One stretch of barrier: both faces and the top, following the ground at each end. */
function slab(mb: MeshBuilder, p: Vec2, q: Vec2, thick: number, height: number, ground: HeightFn, segLen: number, f0: number, f1: number): void {
  const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
  const nx = (dy / l) * thick / 2, ny = (-dx / l) * thick / 2; // right of p->q
  const zp = ground(p[0], p[1]), zq = ground(q[0], q[1]);
  const u0 = (f0 * segLen) / 2, u1 = (f1 * segLen) / 2, vTop = 1 - height / 2; // texture: 2 m by 2 m, bottom at the ground
  const quad = (c: Vec3[], uv: [number, number][]) => {
    const i = mb.vertexCount;
    c.forEach((v, k) => mb.vertex(v, uv[k][0], uv[k][1]));
    mb.quad(i, i + 1, i + 2, i + 3);
  };
  const R = (v: Vec2, z: number): Vec3 => [v[0] + nx, v[1] + ny, z];
  const L = (v: Vec2, z: number): Vec3 => [v[0] - nx, v[1] - ny, z];
  // Right face (outward to the right of p->q), then the left face, then the top.
  quad([R(p, zp - 0.2), R(q, zq - 0.2), R(q, zq + height), R(p, zp + height)], [[u0, 1.1], [u1, 1.1], [u1, vTop], [u0, vTop]]);
  quad([L(q, zq - 0.2), L(p, zp - 0.2), L(p, zp + height), L(q, zq + height)], [[u1, 1.1], [u0, 1.1], [u0, vTop], [u1, vTop]]);
  if (thick > 0.1) quad([R(p, zp + height), R(q, zq + height), L(q, zq + height), L(p, zp + height)], [[u0, 0], [u1, 0], [u1, 0.05], [u0, 0.05]]);
}
