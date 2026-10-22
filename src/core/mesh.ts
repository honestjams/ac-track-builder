// Mesh accumulation in the local ENU frame (x east, y north, z up), with the
// conversion to AC space (X east, Y up, Z south) at the end. The conversion
// is a proper rotation, so counter-clockwise-from-above stays front-facing.

import type { Kn5MeshNode } from "./kn5";
import { MAX_MESH_VERTICES } from "./kn5";

export type Vec3 = [number, number, number];

export const toAc = (x: number, y: number, z: number): Vec3 => [x, z, -y];

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];
  /** Optional explicit normals (ENU). Computed from faces when absent. */
  normals: number[] | null = null;

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: Vec3, u: number, v: number): number {
    this.positions.push(p[0], p[1], p[2]);
    this.uvs.push(u, v);
    return this.vertexCount - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Quad a-b-c-d, counter-clockwise seen from its front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  private faceNormals(): Float32Array {
    const n = new Float32Array(this.positions.length);
    const p = this.positions;
    for (let i = 0; i < this.indices.length; i += 3) {
      const a = this.indices[i] * 3, b = this.indices[i + 1] * 3, c = this.indices[i + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        n[v] += nx;
        n[v + 1] += ny;
        n[v + 2] += nz;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
    return n;
  }

  toKn5(name: string, material: string, extra: Partial<Kn5MeshNode> = {}): Kn5MeshNode {
    if (this.vertexCount > MAX_MESH_VERTICES) throw new Error(`${name}: ${this.vertexCount} vertices exceeds kn5 limit`);
    const enuNormals = this.normals ? Float32Array.from(this.normals) : this.faceNormals();
    const count = this.vertexCount;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const p = toAc(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      const nn = toAc(enuNormals[i * 3], enuNormals[i * 3 + 1], enuNormals[i * 3 + 2]);
      positions.set(p, i * 3);
      normals.set(nn, i * 3);
    }
    return {
      kind: "mesh",
      name,
      positions,
      normals,
      uvs: Float32Array.from(this.uvs),
      indices: Uint16Array.from(this.indices),
      material,
      ...extra,
    };
  }
}
