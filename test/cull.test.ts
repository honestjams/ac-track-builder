import { describe, expect, it } from "vitest";
import { cullable, splitByArea, spread } from "../src/core/cull";
import type { Kn5MeshNode } from "../src/core/kn5";

/** A row of small upright quads along x, one every `gap` metres. */
function row(name: string, count: number, gap: number): Kn5MeshNode {
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = i * gap, b = i * 4;
    pos.push(x, 0, 0, x + 1, 0, 0, x + 1, 2, 0, x, 2, 0);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const n = pos.length / 3;
  return {
    kind: "mesh", name, material: "steel",
    positions: Float32Array.from(pos), normals: new Float32Array(n * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    uvs: new Float32Array(n * 2), indices: Uint16Array.from(idx),
  };
}

describe("culling", () => {
  it("splits a mesh strung along the road into compact tiles, keeping every triangle", () => {
    const long = row("FURNITURE_STEEL_000", 1000, 2); // 2 km of posts, one every 2 m
    const tiles = splitByArea(long);
    expect(tiles.length).toBeGreaterThan(10);
    expect(tiles.reduce((s, t) => s + t.indices.length, 0)).toBe(long.indices.length);
    for (const t of tiles) {
      expect(spread(t)).toBeLessThan(120);
      expect(t.name).toMatch(/^FURNITURE_STEEL_000_T\d+$/);
      expect(Math.max(...t.indices)).toBe(t.positions.length / 3 - 1); // only its own vertices
    }
  });

  it("leaves compact meshes, and small ones, as they are", () => {
    const short = row("FURNITURE_STEEL_000", 5, 20);
    expect(splitByArea(short)).toEqual([short]);
    const sparse = row("FURNITURE_STEEL_000", 100, 20); // 2 km long but only 200 triangles
    expect(splitByArea(sparse)).toEqual([sparse]);
  });

  it("never gives a long mesh a draw distance (it would vanish with the car on it)", () => {
    const [long] = cullable([row("MARKINGS_000", 100, 20)]) as Kn5MeshNode[];
    expect(long.lodOut).toBeUndefined();
  });

  it("gives small detail a draw distance, but not physics meshes or invisible walls", () => {
    const out = cullable([
      { kind: "node", name: "G", transform: [], children: [row("MARKINGS_000", 3, 10), row("1KERB_000", 3, 10), { ...row("1WALL_L_000", 200, 20), renderable: false }] },
    ]);
    const kids = (out[0] as { children: Kn5MeshNode[] }).children;
    expect(kids.find((k) => k.name === "MARKINGS_000")!.lodOut).toBe(450);
    expect(kids.find((k) => k.name === "1KERB_000")!.lodOut).toBeUndefined();
    expect(kids.filter((k) => k.name.startsWith("1WALL"))).toHaveLength(1); // never drawn: not split
  });
});
