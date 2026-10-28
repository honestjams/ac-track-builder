// Keeping the frame rate steady. The game skips drawing a mesh whose
// bounding sphere is off screen, and (with lodOut set) one that is far away,
// but only whole meshes: a batch of trees or signs that stretches the length
// of the road is drawn in full from anywhere on it. So meshes that spread
// wide are split into tiles by area, and small detail is given a draw
// distance.

import type { Kn5MeshNode, Kn5Node } from "./kn5";

/** Tile size for splitting, metres. */
export const CELL = 120;
/** Meshes with fewer triangles than this aren't worth splitting. */
const MIN_TRIS = 1500;

/** Draw distances for small detail, by mesh name. Physics meshes (named 1...) are left alone. */
const DRAW_DISTANCE: [RegExp, number][] = [
  [/^(MARKINGS|RRPM)/, 450],
  [/^FURNITURE/, 600],
  [/^(GUIDEPOSTS|RAILPOSTS)/, 500],
  [/^WIRES/, 350], // a few centimetres thick: they only shimmer further off
];

/** Half the diagonal of a mesh's bounding box, metres. */
export function spread(node: Kn5MeshNode): number {
  const p = node.positions;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], p[i + k]);
      mx[k] = Math.max(mx[k], p[i + k]);
    }
  }
  return p.length ? Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2 : 0;
}

/**
 * Splits a mesh into square tiles by where each triangle's middle falls.
 * A mesh that already fits in a couple of tiles comes back as it was.
 */
export function splitByArea(node: Kn5MeshNode, cell = CELL): Kn5MeshNode[] {
  // A few hundred triangles cost less to draw than the extra draw calls of splitting them.
  if (node.indices.length / 3 < MIN_TRIS || spread(node) <= cell * 2) return [node];
  const p = node.positions, idx = node.indices;
  const tiles = new Map<string, number[]>();
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const key = `${Math.floor((p[a] + p[b] + p[c]) / 3 / cell)},${Math.floor((p[a + 2] + p[b + 2] + p[c + 2]) / 3 / cell)}`;
    let list = tiles.get(key);
    if (!list) tiles.set(key, (list = []));
    list.push(t);
  }
  if (tiles.size < 2) return [node];
  const out: Kn5MeshNode[] = [];
  let k = 0;
  for (const tris of tiles.values()) {
    // Only the vertices this tile uses, renumbered.
    const remap = new Map<number, number>();
    const indices = new Uint16Array(tris.length * 3);
    tris.forEach((t, j) => {
      for (let v = 0; v < 3; v++) {
        const old = idx[t + v];
        let nu = remap.get(old);
        if (nu === undefined) remap.set(old, (nu = remap.size));
        indices[j * 3 + v] = nu;
      }
    });
    const pick = (src: Float32Array, size: number) => {
      const dst = new Float32Array(remap.size * size);
      for (const [old, nu] of remap) for (let c = 0; c < size; c++) dst[nu * size + c] = src[old * size + c];
      return dst;
    };
    out.push({
      ...node,
      name: `${node.name}_T${k++}`,
      positions: pick(node.positions, 3),
      normals: pick(node.normals, 3),
      uvs: pick(node.uvs, 2),
      tangents: node.tangents ? pick(node.tangents, 3) : undefined,
      indices,
    });
  }
  return out;
}

/** Draw distance for a mesh, or undefined to always draw it. */
export function drawDistance(name: string): number | undefined {
  return DRAW_DISTANCE.find(([re]) => re.test(name))?.[1];
}

/**
 * Splits wide meshes in a list into tiles and sets draw distances on small
 * detail. Invisible walls (never drawn) and group nodes pass through.
 */
export function cullable(nodes: Kn5Node[], cell = CELL): Kn5Node[] {
  return nodes.flatMap((n): Kn5Node[] => {
    if (n.kind !== "mesh") return [{ ...n, children: cullable(n.children, cell) }];
    if (n.renderable === false) return [n];
    return splitByArea(n, cell).map((m) => {
      // The game measures the draw distance to the middle of the mesh, so
      // only a compact mesh gets one: a long one would vanish under the car.
      const d = drawDistance(m.name);
      return d && !m.lodOut && spread(m) < d / 4 ? { ...m, lodOut: d } : m;
    });
  });
}
