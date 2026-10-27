import { describe, expect, it } from "vitest";
import { planRoad, SegmentIndex } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { clearOfRoute, keepOffRoute, onRoute } from "../src/core/clearance";
import type { Kn5MeshNode } from "../src/core/kn5";
import type { Vec2 } from "../src/core/geo";

/** A flat mesh of one quad (two triangles) per centre given, 1 m square, in local x/y. */
function patches(name: string, centres: Vec2[]): Kn5MeshNode {
  const pos: number[] = [], idx: number[] = [];
  centres.forEach(([x, y], k) => {
    for (const [dx, dy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) pos.push(x + dx, 0, -(y + dy));
    idx.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
  });
  const n = pos.length / 3;
  return { kind: "mesh", name, positions: Float32Array.from(pos), normals: new Float32Array(n * 3), uvs: new Float32Array(n * 2), indices: Uint16Array.from(idx), material: "concrete" };
}

describe("keeping kerbs off the driving line", () => {
  // An 8 m road along y = 0.
  const plan = planRoad(Array.from({ length: 11 }, (_, i) => [i * 20, 0] as Vec2), withDefaults({ widthOverride: 8 }));
  const on = onRoute(plan, new SegmentIndex(plan));

  it("drops the triangles on the asphalt and keeps the rest", () => {
    // One patch in the middle of the road, one at the kerb line, one on the verge.
    const r = clearOfRoute(patches("1KERB_000", [[100, 0], [100, 4.6], [100, 7]]), on);
    expect(r.dropped).toBe(2);
    expect(r.node!.indices.length).toBe(12);
  });

  it("only touches kerbs, strips, gutters and rails, and removes meshes left empty", () => {
    const { nodes, dropped } = keepOffRoute([
      patches("1KERB_RET", [[50, 1]]),
      patches("1GRASS_STRIP_000", [[60, -6]]),
      patches("1ROAD_000", [[70, 0]]),
      patches("1WALL_RAIL_L_000", [[80, 0.5]]),
    ], on);
    expect(dropped).toBe(4);
    expect(nodes.map((n) => n.name)).toEqual(["1GRASS_STRIP_000", "1ROAD_000"]);
  });
});
