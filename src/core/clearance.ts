// A last check that nothing solid stands on the driving line. Kerbs, nature
// strips, gutters and guard rails are each placed with care, but they come
// from several builders (road edges, kerb returns, side streets, roundabout
// rings) and real road networks are full of odd corners; any triangle of
// theirs whose middle lands on the route's asphalt is dropped here.

import type { Kn5MeshNode } from "./kn5";
import { innerRadius, outerRadius } from "./roundabout";
import type { RoadPlan, SegmentIndex } from "./road";

/** Meshes that must never stand on the route: kerbs, their strips and gutters, guard rails. */
export const KEEP_OFF = /^1(KERB|GRASS_STRIP|ROAD_GUTTER|STREET_GUTTER|STREET_PATH|STREET_DRIVE|WALL_RAIL|WALL_FENCE)/;

/** Is this local point (x east, y north) on the route's asphalt or a roundabout's carriageway? */
export function onRoute(plan: RoadPlan, index: SegmentIndex, margin = 0.15): (x: number, y: number) => boolean {
  return (x, y) => {
    const n = index.nearest(x, y, 25);
    if (n && n.dist < index.at(n).width / 2 - margin) return true;
    return plan.roundabouts.some((rb) => {
      const d = Math.hypot(x - rb.c[0], y - rb.c[1]);
      return d > innerRadius(rb) && d < outerRadius(rb) - margin;
    });
  };
}

/**
 * Drops the triangles whose centre is on the route. Returns the mesh with
 * the rest (vertices untouched), or null when nothing is left.
 */
export function clearOfRoute(node: Kn5MeshNode, on: (x: number, y: number) => boolean): { node: Kn5MeshNode | null; dropped: number } {
  const p = node.positions, idx = node.indices;
  const keep: number[] = [];
  let dropped = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    // AC space: x east, y up, z south.
    const x = (p[a] + p[b] + p[c]) / 3, y = -(p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    if (on(x, y)) dropped++;
    else keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!dropped) return { node, dropped };
  if (!keep.length) return { node: null, dropped };
  return { node: { ...node, indices: Uint16Array.from(keep) }, dropped };
}

/** Applies clearOfRoute to every KEEP_OFF mesh in a list. */
export function keepOffRoute(nodes: Kn5MeshNode[], on: (x: number, y: number) => boolean): { nodes: Kn5MeshNode[]; dropped: number } {
  let dropped = 0;
  const out: Kn5MeshNode[] = [];
  for (const n of nodes) {
    if (!KEEP_OFF.test(n.name)) {
      out.push(n);
      continue;
    }
    const r = clearOfRoute(n, on);
    dropped += r.dropped;
    if (r.node) out.push(r.node);
  }
  return { nodes: out, dropped };
}
