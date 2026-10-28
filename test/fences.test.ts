import { describe, expect, it } from "vitest";
import { planRoad, SegmentIndex } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { barrierStyle, buildBarriers } from "../src/core/fences";
import type { Vec2 } from "../src/core/geo";

// An 8 m street along y = 0.
const path: Vec2[] = Array.from({ length: 16 }, (_, i) => [i * 20, 0]);
const opts = withDefaults({ widthOverride: 8 });
const plan = planRoad(path, opts);
const index = new SegmentIndex(plan);
const verts = (n: { positions: Float32Array }) => Array.from({ length: n.positions.length / 3 }, (_, i) => [n.positions[i * 3], -n.positions[i * 3 + 2], n.positions[i * 3 + 1]]);

describe("fences, walls and hedges", () => {
  it("styles barriers the way Australian lots have them", () => {
    expect(barrierStyle({ pts: [], kind: "fence" }).look).toBe("colorbond");
    expect(barrierStyle({ pts: [], kind: "fence", fenceType: "wood" }).look).toBe("paling");
    expect(barrierStyle({ pts: [], kind: "wall" })).toMatchObject({ look: "brickwall", height: 1.2 });
    expect(barrierStyle({ pts: [], kind: "hedge", height: 2.2 })).toMatchObject({ look: "hedge", height: 2.2 });
  });

  it("builds a solid fence along a back boundary, following the ground", () => {
    const nodes = buildBarriers([{ pts: [[40, 30], [120, 30]], kind: "fence" }], index, opts, (x) => 10 + x * 0.05, () => true);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toMatch(/^1WALL_FENCE_COLORBOND_/);
    const v = verts(nodes[0]);
    // Top follows the slope: 1.8 m above the ground at each end.
    const top = (x: number) => Math.max(...v.filter((p) => Math.abs(p[0] - x) < 0.01).map((p) => p[2]));
    expect(top(40)).toBeCloseTo(10 + 2 + 1.8, 2);
    expect(top(120)).toBeCloseTo(10 + 6 + 1.8, 2);
  });

  it("never builds near the road, or where it isn't clear (a side street)", () => {
    // A front fence mapped right on the road edge, and one crossing a side street at x 100-120.
    const nodes = buildBarriers([
      { pts: [[20, 4.5], [200, 4.5]], kind: "wall" },
      { pts: [[60, 12], [180, 12]], kind: "fence" },
    ], index, opts, () => 10, (x) => x < 100 || x > 120);
    const all = nodes.flatMap(verts);
    for (const [x, y] of all) {
      expect(Math.abs(y)).toBeGreaterThan(4 + opts.vergeWidth + 2.5 - 0.1);
      expect(x < 100.5 || x > 119.5).toBe(true);
    }
    expect(all.length).toBeGreaterThan(0);
  });
});
