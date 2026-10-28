import { describe, expect, it } from "vitest";
import { buildTerrainChunk } from "../src/core/terrain";
import { withDefaults } from "../src/core/options";

const chunk = { key: "t0_0", minX: 0, minY: 0, maxX: 60, maxY: 60 };
// The road runs along x = 0; everything here is inside the corridor.
const opts = (lod: boolean) => withDefaults({ terrainStep: 1.5, terrainLod: lod, terrainLodNear: 25, corridor: 200 });
const flat = (x: number, y: number) => ({ h: 2 + 0.001 * y, dist: x });
const hill = (x: number, y: number) => ({ h: 2 + Math.sin(x / 3) * Math.cos(y / 4), dist: x });

/** Edges used by exactly one triangle, as "x,y|x,y" in AC coordinates. */
function openEdges(m: NonNullable<ReturnType<typeof buildTerrainChunk>>): [number, number][][] {
  const key = (i: number) => `${m.positions[i * 3].toFixed(3)},${m.positions[i * 3 + 2].toFixed(3)}`;
  const count = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = key(m.indices[t + k]), b = key(m.indices[t + ((k + 1) % 3)]);
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(e, (count.get(e) ?? 0) + 1);
    }
  }
  return [...count].filter(([, n]) => n === 1).map(([e]) => e.split("|").map((p) => p.split(",").map(Number) as [number, number]));
}

describe("terrain level of detail", () => {
  it("draws flat ground away from the road with far fewer triangles", () => {
    const fine = buildTerrainChunk(chunk, flat, opts(false), true)!;
    const lod = buildTerrainChunk(chunk, flat, opts(true), true)!;
    expect(lod.indices.length).toBeLessThan(fine.indices.length * 0.6);
  });

  it("keeps every cell fine near the road and on bumpy ground", () => {
    const fine = buildTerrainChunk(chunk, hill, opts(false), true)!;
    const lod = buildTerrainChunk(chunk, hill, opts(true), true)!;
    expect(lod.indices.length).toBe(fine.indices.length);
  });

  it("leaves no cracks: the only open edges are on the chunk's border", () => {
    const lod = buildTerrainChunk(chunk, flat, opts(true), true)!;
    for (const [[x0, z0], [x1, z1]] of openEdges(lod)) {
      const onBorder = (a: number, b: number) => (Math.abs(a - b) < 1e-3) && [0, 60].some((v) => Math.abs(Math.abs(a) - v) < 1e-3);
      expect(onBorder(x0, x1) || onBorder(z0, z1)).toBe(true);
    }
  });

  it("faces up everywhere", () => {
    const lod = buildTerrainChunk(chunk, flat, opts(true), true)!;
    const p = lod.positions;
    for (let t = 0; t < lod.indices.length; t += 3) {
      const [a, b, c] = [lod.indices[t], lod.indices[t + 1], lod.indices[t + 2]];
      const ux = p[b * 3] - p[a * 3], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vz = p[c * 3 + 2] - p[a * 3 + 2];
      // AC space (x east, y up, z south): the normal's y is uz*vx - ux*vz.
      expect(uz * vx - ux * vz).toBeGreaterThan(0);
    }
  });
});
