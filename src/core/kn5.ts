// Writer (and reader, for tests) for Kunos' .kn5 model container.
//
// Layout, as written by Kunos' ksEditor and read by the game (cross-checked
// against Content Manager's AcTools Kn5Writer and the GPL Blender exporter by
// Thomas Hagnhofer):
//
//   "sc6969"  u32 version (5; version > 5 adds one extra u32)
//   u32 textureCount   { i32 active, string name, blob imageBytes (PNG/DDS) }
//   u32 materialCount  { string name, string shader, u8 blendMode,
//                        bool alphaTested, i32 depthMode,
//                        u32 propCount { string name, f32 a, f32[2] b,
//                                        f32[3] c, f32[4] d },
//                        u32 mappingCount { string slot, u32 index,
//                                           string textureName } }
//   node tree, depth first. Every node: u32 class, string name,
//   u32 childCount, bool active, then
//     class 1 (Node): f32[16] transform (row-major, translation in 12..14)
//     class 2 (Mesh): bool castShadows, bool visible, bool transparent,
//                     u32 vertexCount { f32[3] pos, f32[3] normal,
//                                       f32[2] uv, f32[3] tangent },
//                     u32 indexCount { u16 }, u32 materialIndex,
//                     u32 layer, f32 lodIn, f32 lodOut,
//                     f32[3] sphereCenter, f32 sphereRadius, bool renderable
//
// Coordinates are AC world space: X east, Y up, Z south (-north), metres.
// Triangles wind counter-clockwise seen from the side the normal faces.
// UV v runs down the image (v = 0 is the top row).

import { BinaryReader, BinaryWriter } from "./binary";

export const KN5_MAGIC = "sc6969";
export const KN5_VERSION = 5;
export const MAX_MESH_VERTICES = 65535;

export interface Kn5Texture {
  name: string;
  data: Uint8Array;
}

export interface Kn5ShaderProperty {
  name: string;
  a?: number;
  b?: [number, number];
  c?: [number, number, number];
  d?: [number, number, number, number];
}

/**
 * The shader register each texture slot is bound to, as the game's shaders
 * declare them (see CSP's recreated Kunos shaders, base/textures_ps.fx).
 */
export const TEXTURE_REGISTER: Record<string, number> = {
  txDiffuse: 0,
  txNormal: 1, txMask: 1, txVariation: 1,
  txMaps: 2, txDetailR: 2,
  txDetail: 3, txDetailG: 3,
  txNormalDetail: 4, txDetailB: 4,
  txDetailA: 5,
  txDetailNM: 6,
};

export const BlendMode = { Opaque: 0, AlphaBlend: 1, AlphaToCoverage: 2 } as const;
export const DepthMode = { Normal: 0, NoWrite: 1, Off: 2 } as const;

export interface Kn5Material {
  name: string;
  shader: string;
  blendMode?: number;
  alphaTested?: boolean;
  depthMode?: number;
  properties: Kn5ShaderProperty[];
  /** Shader slot (e.g. "txDiffuse") -> texture name. */
  textures: Record<string, string>;
  /** Read back only: the register each slot was written with. */
  registers?: Record<string, number>;
}

export interface Kn5GroupNode {
  kind: "node";
  name: string;
  /** 16 floats, row-major, translation in [12], [13], [14]. */
  transform: number[];
  children: Kn5Node[];
}

export interface Kn5MeshNode {
  kind: "mesh";
  name: string;
  /** xyz per vertex, AC world space. */
  positions: Float32Array;
  normals: Float32Array;
  /** uv per vertex. */
  uvs: Float32Array;
  /** xyz per vertex; computed from UVs when omitted. */
  tangents?: Float32Array;
  indices: Uint16Array;
  material: string;
  castShadows?: boolean;
  visible?: boolean;
  transparent?: boolean;
  renderable?: boolean;
  layer?: number;
  lodIn?: number;
  lodOut?: number;
}

export type Kn5Node = Kn5GroupNode | Kn5MeshNode;

export interface Kn5Model {
  textures: Kn5Texture[];
  materials: Kn5Material[];
  root: Kn5GroupNode;
}

export const IDENTITY: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * A transform whose local Z axis points along `forward` and Y along `up`,
 * placed at `position`. This is how AC reads spawn and timing dummies
 * (AC_START_0, AC_PIT_0, ...): Z is the driving direction, Y is up.
 */
export function frameTransform(
  position: [number, number, number],
  forward: [number, number, number],
  up: [number, number, number] = [0, 1, 0],
): number[] {
  const z = normalize(forward);
  let x = normalize(cross(up, z));
  const y = cross(z, x);
  if (!Number.isFinite(x[0])) x = [1, 0, 0];
  return [
    x[0], x[1], x[2], 0,
    y[0], y[1], y[2], 0,
    z[0], z[1], z[2], 0,
    position[0], position[1], position[2], 1,
  ];
}

export function translation(position: [number, number, number]): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, position[0], position[1], position[2], 1];
}

function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Per-vertex tangents along +u, the usual input for normal-mapped shaders. */
export function computeTangents(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  indices: Uint16Array,
): Float32Array {
  const n = positions.length / 3;
  const acc = new Float32Array(n * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const e1 = [0, 1, 2].map((k) => positions[i1 * 3 + k] - positions[i0 * 3 + k]);
    const e2 = [0, 1, 2].map((k) => positions[i2 * 3 + k] - positions[i0 * 3 + k]);
    const du1 = uvs[i1 * 2] - uvs[i0 * 2], dv1 = uvs[i1 * 2 + 1] - uvs[i0 * 2 + 1];
    const du2 = uvs[i2 * 2] - uvs[i0 * 2], dv2 = uvs[i2 * 2 + 1] - uvs[i0 * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    for (let k = 0; k < 3; k++) {
      const tk = (e1[k] * dv2 - e2[k] * dv1) * r;
      acc[i0 * 3 + k] += tk;
      acc[i1 * 3 + k] += tk;
      acc[i2 * 3 + k] += tk;
    }
  }
  for (let i = 0; i < n; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    let tx = acc[i * 3], ty = acc[i * 3 + 1], tz = acc[i * 3 + 2];
    // Gram-Schmidt against the normal.
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-9) {
      // Degenerate UVs: any vector perpendicular to the normal.
      [tx, ty, tz] = Math.abs(nx) < 0.9 ? [0, -nz, ny] : [nz, 0, -nx];
      l = Math.hypot(tx, ty, tz);
    }
    acc[i * 3] = tx / l;
    acc[i * 3 + 1] = ty / l;
    acc[i * 3 + 2] = tz / l;
  }
  return acc;
}

function boundingSphere(positions: Float32Array): { center: [number, number, number]; radius: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const center: [number, number, number] = [0, 1, 2].map((k) => (min[k] + max[k]) / 2) as [number, number, number];
  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - center[0], dy = positions[i + 1] - center[1], dz = positions[i + 2] - center[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { center, radius: Math.sqrt(r2) };
}

function validateMesh(m: Kn5MeshNode): void {
  const n = m.positions.length / 3;
  if (n > MAX_MESH_VERTICES) throw new Error(`Mesh ${m.name} has ${n} vertices (max ${MAX_MESH_VERTICES})`);
  if (m.normals.length !== n * 3 || m.uvs.length !== n * 2) {
    throw new Error(`Mesh ${m.name}: attribute lengths do not match vertex count`);
  }
  if (m.indices.length % 3 !== 0) throw new Error(`Mesh ${m.name}: index count not a multiple of 3`);
  for (let i = 0; i < m.indices.length; i++) {
    if (m.indices[i] >= n) throw new Error(`Mesh ${m.name}: index ${m.indices[i]} out of range`);
  }
}

export function writeKn5(model: Kn5Model): Uint8Array {
  const w = new BinaryWriter(1 << 20);
  w.magic(KN5_MAGIC).u32(KN5_VERSION);

  const textureNames = new Set<string>();
  w.u32(model.textures.length);
  for (const t of model.textures) {
    if (textureNames.has(t.name)) throw new Error(`Duplicate texture ${t.name}`);
    textureNames.add(t.name);
    w.i32(1).string(t.name).blob(t.data);
  }

  const materialIndex = new Map<string, number>();
  w.u32(model.materials.length);
  model.materials.forEach((m, i) => {
    if (materialIndex.has(m.name)) throw new Error(`Duplicate material ${m.name}`);
    materialIndex.set(m.name, i);
    w.string(m.name).string(m.shader);
    w.u8(m.blendMode ?? BlendMode.Opaque).bool(m.alphaTested ?? false).i32(m.depthMode ?? DepthMode.Normal);
    w.u32(m.properties.length);
    for (const p of m.properties) {
      w.string(p.name).f32(p.a ?? 0).f32s(p.b ?? [0, 0]).f32s(p.c ?? [0, 0, 0]).f32s(p.d ?? [0, 0, 0, 0]);
    }
    const slots = Object.entries(m.textures);
    w.u32(slots.length);
    slots.forEach(([slot, tex], slotIndex) => {
      if (!textureNames.has(tex)) throw new Error(`Material ${m.name} uses missing texture ${tex}`);
      w.string(slot).u32(TEXTURE_REGISTER[slot] ?? slotIndex).string(tex);
    });
  });

  const writeNode = (node: Kn5Node): void => {
    if (node.kind === "node") {
      if (node.transform.length !== 16) throw new Error(`Node ${node.name}: transform needs 16 floats`);
      w.u32(1).string(node.name).u32(node.children.length).bool(true).f32s(node.transform);
      node.children.forEach(writeNode);
      return;
    }
    validateMesh(node);
    const mat = materialIndex.get(node.material);
    if (mat === undefined) throw new Error(`Mesh ${node.name} uses missing material ${node.material}`);
    const tangents = node.tangents ?? computeTangents(node.positions, node.normals, node.uvs, node.indices);
    w.u32(2).string(node.name).u32(0).bool(true);
    w.bool(node.castShadows ?? true).bool(node.visible ?? true).bool(node.transparent ?? false);
    const n = node.positions.length / 3;
    w.u32(n);
    for (let i = 0; i < n; i++) {
      w.f32(node.positions[i * 3]).f32(node.positions[i * 3 + 1]).f32(node.positions[i * 3 + 2]);
      w.f32(node.normals[i * 3]).f32(node.normals[i * 3 + 1]).f32(node.normals[i * 3 + 2]);
      w.f32(node.uvs[i * 2]).f32(node.uvs[i * 2 + 1]);
      w.f32(tangents[i * 3]).f32(tangents[i * 3 + 1]).f32(tangents[i * 3 + 2]);
    }
    w.u32(node.indices.length);
    for (let i = 0; i < node.indices.length; i++) w.u16(node.indices[i]);
    const sphere = boundingSphere(node.positions);
    w.u32(mat).u32(node.layer ?? 0).f32(node.lodIn ?? 0).f32(node.lodOut ?? 0);
    w.f32s(sphere.center).f32(sphere.radius).bool(node.renderable ?? true);
  };
  writeNode(model.root);
  return w.finish();
}

/** Parses a kn5 back into a model. Used by the tests to round-trip output. */
export function readKn5(data: Uint8Array): Kn5Model & { version: number } {
  const r = new BinaryReader(data);
  const magic = r.magic(6);
  if (magic !== KN5_MAGIC) throw new Error(`Not a kn5 file (magic ${magic})`);
  const version = r.u32();
  if (version > 5) r.u32();

  const textures: Kn5Texture[] = [];
  for (let i = 0, n = r.u32(); i < n; i++) {
    r.i32();
    textures.push({ name: r.string(), data: r.blob().slice() });
  }

  const materials: Kn5Material[] = [];
  for (let i = 0, n = r.u32(); i < n; i++) {
    const m: Kn5Material = { name: r.string(), shader: r.string(), properties: [], textures: {} };
    m.blendMode = r.u8();
    m.alphaTested = r.bool();
    m.depthMode = r.i32();
    for (let j = 0, pc = r.u32(); j < pc; j++) {
      m.properties.push({
        name: r.string(), a: r.f32(),
        b: r.f32s(2) as [number, number],
        c: r.f32s(3) as [number, number, number],
        d: r.f32s(4) as [number, number, number, number],
      });
    }
    m.registers = {};
    for (let j = 0, tc = r.u32(); j < tc; j++) {
      const slot = r.string();
      m.registers[slot] = r.u32();
      m.textures[slot] = r.string();
    }
    materials.push(m);
  }

  const readNode = (): Kn5Node => {
    const cls = r.u32();
    const name = r.string();
    const childCount = r.u32();
    r.bool();
    if (cls === 1) {
      const transform = r.f32s(16);
      const children: Kn5Node[] = [];
      for (let i = 0; i < childCount; i++) children.push(readNode());
      return { kind: "node", name, transform, children };
    }
    if (cls !== 2) throw new Error(`Unsupported node class ${cls} (${name})`);
    const castShadows = r.bool(), visible = r.bool(), transparent = r.bool();
    const n = r.u32();
    const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
    const uvs = new Float32Array(n * 2), tangents = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions.set(r.f32s(3), i * 3);
      normals.set(r.f32s(3), i * 3);
      uvs.set(r.f32s(2), i * 2);
      tangents.set(r.f32s(3), i * 3);
    }
    const indices = new Uint16Array(r.u32());
    for (let i = 0; i < indices.length; i++) indices[i] = r.u16();
    const material = materials[r.u32()]?.name ?? "";
    const layer = r.u32(), lodIn = r.f32(), lodOut = r.f32();
    r.f32s(4);
    const renderable = r.bool();
    return {
      kind: "mesh", name, positions, normals, uvs, tangents, indices, material,
      castShadows, visible, transparent, renderable, layer, lodIn, lodOut,
    };
  };
  const root = readNode();
  if (root.kind !== "node") throw new Error("kn5 root is not a node");
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes after node tree`);
  return { version, textures, materials, root };
}
