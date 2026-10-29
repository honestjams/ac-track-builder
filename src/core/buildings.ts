// Buildings, from two sources:
//
//  - OSM footprints (via OpenFreeMap vector tiles or Overpass), extruded to
//    their mapped height. Coverage is good in cities and thin in the bush.
//  - Placeholders detected from the aerial imagery: compact patches that
//    look like a roof (pale or dark grey metal, terracotta tile) become a
//    house with a hip or gable roof in the matching colour.
//
// Each is then dressed as a kind of building (buildingStyles.ts): houses of
// brick, weatherboard, fibro or render, Queenslanders on stumps, flats,
// apartments, towers, shops, offices, warehouses, sheds and halls. Pitched
// roofs get eaves (the roof overhangs the walls, with white soffits); houses
// along a street frontage often a roller door on the garage facing it.
//
// Walls are collidable (1WALL_BLD_*). Roofs are visual only.

import earcut from "earcut";
import type { HeightFn } from "./elevation";
import type { Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import type { MeshBuilder, Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import type { SegmentIndex } from "./road";
import { ChunkedMesh, rng } from "./scenery";
import type { TerrainChunk } from "./terrain";
import { FACADES, LAYOUTS, PITCHED, ROOF_COLOURS, type Dress, type Layout } from "./buildingStyles";
import { pad } from "./roadMesh";

export interface Building extends Dress {
  /** Footprint, local metres, first point not repeated. */
  ring: Vec2[];
  /** Mapped, a roof patch found in the photo, or a house found along a street frontage. */
  source: "osm" | "detected" | "frontage";
  /** OSM (or vector tile) tags, for mapped buildings. */
  tags?: Record<string, string>;
  /** The wall facing the street (its two corners), where known. */
  front?: [Vec2, Vec2];
  /** Distance from the road edge to the front wall, metres, where known. */
  setback?: number;
}

/** A plain house, before dressBuilding decides what it really is. */
export function plainHouse(roof: Building["roof"], roofColour: number, height: number): Dress {
  return { type: "house", facade: 0, roof, roofColour, pitch: 22, height };
}

/** Most Australian houses have a hip roof; about a third a gable. */
export function houseRoof(rand: () => number): "gable" | "hip" {
  return rand() < 0.68 ? "hip" : "gable";
}

/** Eave overhang beyond the walls, metres: wide on a Queenslander, tight on a shed. */
const eaveOf = (b: Building) => (b.type === "queenslander" ? 0.6 : b.type === "warehouse" || b.type === "shed" ? 0.2 : 0.45);

export function ringArea(r: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInRing(x: number, y: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(ring: Vec2[]): Vec2 {
  const n = ring.length;
  return [ring.reduce((a, p) => a + p[0], 0) / n, ring.reduce((a, p) => a + p[1], 0) / n];
}

/** Wall height from OSM tags (or a vector tile's render_height), metres. */
export function buildingHeight(tags: Record<string, string>): number {
  const h = parseFloat(tags.height ?? tags.render_height ?? "");
  if (h > 2) return Math.min(80, h);
  const levels = parseFloat(tags["building:levels"] ?? "");
  if (levels > 0) return Math.min(80, levels * 3 + 1);
  const kind = tags.building ?? "yes";
  if (/^(garage|garages|shed|carport|hut|cabin|roof)$/.test(kind)) return 3.5;
  if (/^(house|detached|residential|semidetached_house|bungalow|farm)$/.test(kind)) return 3;
  return 6;
}

export function nearestRoofColour(rgb: [number, number, number]): number {
  let best = 0, bestD = Infinity;
  ROOF_COLOURS.forEach((c, i) => {
    if (!PITCHED.includes(i)) return;
    // Aerial photos read a little dark and hazy; compare after a mild lift.
    const d = c.rgb.reduce((a, v, k) => a + (v - Math.min(255, rgb[k] * 1.12 + 8)) ** 2, 0);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Is this a near-rectangular quad (all corners within 15 degrees of square)? */
export function isRectangle(ring: Vec2[]): boolean {
  if (ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = ring[(i + 3) % 4], b = ring[i], c = ring[(i + 1) % 4];
    const ux = a[0] - b[0], uy = a[1] - b[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const cos = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
    if (Math.abs(cos) > 0.26) return false;
  }
  return true;
}

/** OSM footprint -> Building, with a gable roof on small rectangular houses. */
export function fromOsm(ring: Vec2[], tags: Record<string, string>, seed: number): Building {
  const rand = rng(seed);
  const height = buildingHeight(tags);
  const small = Math.abs(ringArea(ring)) < 400 && height <= 7;
  const roofTag = tags["roof:colour"] ? nearestRoofColour(hexColour(tags["roof:colour"])) : -1;
  return {
    ring,
    ...plainHouse(
      !small || !isRectangle(ring) ? "flat" : tags["roof:shape"] === "gabled" ? "gable" : tags["roof:shape"] === "hipped" ? "hip" : houseRoof(rand),
      roofTag >= 0 ? roofTag : PITCHED[Math.floor(rand() * PITCHED.length)],
      height,
    ),
    source: "osm",
    tags,
  };
}

function hexColour(s: string): [number, number, number] {
  const named: Record<string, [number, number, number]> = {
    red: [170, 70, 50], grey: [140, 140, 140], gray: [140, 140, 140], white: [230, 230, 225],
    black: [45, 45, 45], brown: [120, 80, 50], green: [70, 100, 70], blue: [70, 90, 120],
  };
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
  return named[s.trim().toLowerCase()] ?? [140, 140, 140];
}

/**
 * Roof detection in one terrain chunk's aerial texture (RGBA, north up).
 * Works on ~0.8 m cells: a cell is roof-like when it is unsaturated and
 * light (metal, concrete) or dark-grey-but-not-shadow, or saturated
 * red-orange (terracotta). Connected patches of 40-700 m^2 that fill most of
 * their oriented bounding box and aren't long and thin become buildings.
 */
export function detectBuildings(rgba: Uint8Array | Uint8ClampedArray, size: number, chunk: TerrainChunk): Building[] {
  const span = chunk.maxX - chunk.minX;
  const f = Math.max(1, Math.round((0.8 * size) / span));
  const n = Math.floor(size / f);
  const m = span / n; // metres per cell
  const cls = new Uint8Array(n * n); // 0 none, 1 roof
  const col = new Float32Array(n * n * 3);
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      let r = 0, g = 0, b = 0;
      for (let y = cy * f; y < (cy + 1) * f; y++) {
        for (let x = cx * f; x < (cx + 1) * f; x++) {
          const i = (y * size + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
        }
      }
      const k = f * f;
      r /= k * 255;
      g /= k * 255;
      b /= k * 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max > 0 ? (max - min) / max : 0;
      const l = (r + g + b) / 3;
      const exg = (2 * g - r - b) / (r + g + b + 1e-6);
      const metal = sat < 0.16 && l > 0.5 && exg < 0.03;
      const tile = r > g * 1.3 && r > b * 1.5 && sat > 0.35 && l > 0.25 && l < 0.65;
      const idx = cy * n + cx;
      if (metal || tile) cls[idx] = 1;
      col[idx * 3] = r * 255;
      col[idx * 3 + 1] = g * 255;
      col[idx * 3 + 2] = b * 255;
    }
  }
  // Opening (erode then dilate) removes fences, paths and road lines.
  const erode = new Uint8Array(n * n), open = new Uint8Array(n * n);
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      erode[i] = cls[i] & cls[i - 1] & cls[i + 1] & cls[i - n] & cls[i + n];
    }
  }
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      open[i] = cls[i] & (erode[i] | erode[i - 1] | erode[i + 1] | erode[i - n] | erode[i + n]);
    }
  }

  const label = new Int32Array(n * n).fill(-1);
  const out: Building[] = [];
  const rand = rng(Math.round(chunk.minX * 3 + chunk.minY * 5) | 0);
  for (let start = 0; start < n * n; start++) {
    if (!open[start] || label[start] >= 0) continue;
    const cells: number[] = [];
    const stack = [start];
    label[start] = start;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % n, y = (i / n) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < n - 1 ? i + 1 : -1, y > 0 ? i - n : -1, y < n - 1 ? i + n : -1]) {
        if (j >= 0 && open[j] && label[j] < 0) {
          label[j] = start;
          stack.push(j);
        }
      }
    }
    const area = cells.length * m * m;
    if (area < 40 || area > 700) continue;
    // Principal axes of the patch, in local metres (y north).
    let mx = 0, my = 0;
    const pts = cells.map((i) => {
      const x = chunk.minX + ((i % n) + 0.5) * m, y = chunk.maxY - (((i / n) | 0) + 0.5) * m;
      mx += x;
      my += y;
      return [x, y];
    });
    mx /= pts.length;
    my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) ** 2;
      syy += (y - my) ** 2;
      sxy += (x - mx) * (y - my);
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of pts) {
      const a = (x - mx) * ux + (y - my) * uy, b = -(x - mx) * uy + (y - my) * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const L = a1 - a0 + m, W = b1 - b0 + m;
    if (Math.min(L, W) < 4 || L / W > 4 || area / (L * W) < 0.55) continue;
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
    const cx = mx + ca * ux - cb * uy, cy = my + ca * uy + cb * ux;
    const hl = L / 2, hw = W / 2;
    const ring: Vec2[] = [
      [cx - ux * hl + uy * hw, cy - uy * hl - ux * hw],
      [cx + ux * hl + uy * hw, cy + uy * hl - ux * hw],
      [cx + ux * hl - uy * hw, cy + uy * hl + ux * hw],
      [cx - ux * hl - uy * hw, cy - uy * hl + ux * hw],
    ];
    let r = 0, g = 0, b = 0;
    for (const i of cells) {
      r += col[i * 3];
      g += col[i * 3 + 1];
      b += col[i * 3 + 2];
    }
    const rgb: [number, number, number] = [r / cells.length, g / cells.length, b / cells.length];
    out.push({ ring, ...plainHouse(houseRoof(rand), nearestRoofColour(rgb), area > 250 ? 3.6 : 2.8), source: "detected" });
  }
  return out;
}

/**
 * Keeps buildings clear of the road and verges and within `maxDist` of it,
 * and drops detected placeholders that overlap a mapped building.
 */
export function filterBuildings(buildings: Building[], index: SegmentIndex, opts: BuildOptions, maxDist: number): Building[] {
  const mapped = buildings.filter((b) => b.source === "osm");
  return buildings.filter((b) => {
    if (b.ring.length < 3 || Math.abs(ringArea(b.ring)) < 6) return false;
    if (b.source !== "osm") {
      const [cx, cy] = centroid(b.ring);
      if (mapped.some((o) => pointInRing(cx, cy, o.ring) || b.ring.some(([x, y]) => pointInRing(x, y, o.ring)))) return false;
    }
    let anyNear = false;
    for (const [x, y] of b.ring) {
      const n = index.nearest(x, y, maxDist);
      if (!n) continue;
      anyNear = true;
      if (n.dist < index.at(n).width / 2 + opts.vergeWidth + 2) return false;
    }
    return anyNear;
  });
}


/** One wall from p to q (outside on its right), z0 to z1, textured one period along and one storey up from `floor`. */
function wall(mb: MeshBuilder, p: Vec2, q: Vec2, z0: number, z1: number, u0: number, floor: number, L: Layout): number {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const n: Vec3 = [(q[1] - p[1]) / (len || 1), -(q[0] - p[0]) / (len || 1), 0];
  const i = mb.vertexCount;
  const u1 = u0 + len / L.period, v = (z: number) => 1 - (z - floor) / L.storey;
  mb.vertex([p[0], p[1], z0], u0, v(z0));
  mb.vertex([q[0], q[1], z0], u1, v(z0));
  mb.vertex([q[0], q[1], z1], u1, v(z1));
  mb.vertex([p[0], p[1], z1], u0, v(z1));
  for (let j = 0; j < 4; j++) mb.normals!.push(...n);
  mb.quad(i, i + 1, i + 2, i + 3);
  return u1;
}

const same = (a: Vec2, c: Vec2) => Math.hypot(a[0] - c[0], a[1] - c[1]) < 0.05;

/** Which edge of the (counter-clockwise) ring is the street front, or -1. */
function frontEdge(b: Building, ring: Vec2[]): number {
  if (!b.front) return -1;
  return ring.findIndex((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return (same(p, b.front![0]) && same(q, b.front![1])) || (same(p, b.front![1]) && same(q, b.front![0]));
  });
}

/** Houses show the street a garage door and a front door; warehouses a big roller door. */
const hasFrontDoors = (b: Building) => /^(house|townhouse|warehouse)$/.test(b.type) && !(b.stumps && b.stumps > 0);

/** Where along the front wall the garage and front door go (metres from its start). */
function doorPlan(b: Building, len: number): { garage?: [number, number, number]; door?: [number, number] } {
  if (b.type === "warehouse") return len >= 8 ? { garage: [len / 3, 4.5, 4.2] } : {};
  const garage = b.garage && len >= 6;
  return { ...(garage ? { garage: [0.6, 2.6, 2.1] as [number, number, number] } : {}), door: [garage ? Math.min(len - 1.4, 4.2) : len / 3, 0.85] };
}

/**
 * What a building shows the street: a roller door on the garage (with a
 * concrete driveway out to the nature strip) and the front door; on a
 * warehouse, one big roller door.
 */
function frontage(b: Building, ring: Vec2[], edge: number, ground: HeightFn, mesh: { garage: MeshBuilder; door: MeshBuilder; drive: MeshBuilder }): void {
  const p = ring[edge], q = ring[(edge + 1) % ring.length];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 5) return;
  const d: Vec2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
  const out: Vec2 = [d[1], -d[0]]; // right of p->q: outside, for a counter-clockwise ring
  const along = (m: number, proud = 0.02): Vec2 => [p[0] + d[0] * m + out[0] * proud, p[1] + d[1] * m + out[1] * proud];
  const panel = (mb: MeshBuilder, m0: number, w: number, h: number) => {
    const a = along(m0), c = along(m0 + w);
    const z = Math.min(ground(a[0], a[1]), ground(c[0], c[1]));
    face(mb, [[a[0], a[1], z], [c[0], c[1], z], [c[0], c[1], z + h], [a[0], a[1], z + h]], (v) => [Math.hypot(v[0] - a[0], v[1] - a[1]) / w, 1 - (v[2] - z) / h]);
  };
  const plan = doorPlan(b, len);
  if (plan.garage) {
    const [m0, w, h] = plan.garage;
    panel(mesh.garage, m0, w, h);
    // The driveway: from the door out to where the nature strip starts, about 3.5 m from the road.
    const run = (b.setback ?? 0) - 3.5;
    if (run > 1) {
      const pts: Vec3[] = [];
      for (const [m, o] of [[m0 - 0.2, 0.05], [m0 + w + 0.2, 0.05], [m0 + w + 0.2, run], [m0 - 0.2, run]] as const) {
        const v = along(m, o);
        pts.push([v[0], v[1], ground(v[0], v[1]) + 0.03]);
      }
      face(mesh.drive, pts.reverse(), (v) => [v[0] / 3, v[1] / 3]);
    }
  }
  if (plan.door) panel(mesh.door, plan.door[0], plan.door[1], 2.05);
}

/** Stretches of the front wall the garage and front door take, so no window goes behind them. */
function frontReserved(b: Building, ring: Vec2[], edge: number): [number, number][] {
  if (edge < 0 || !hasFrontDoors(b)) return [];
  const p = ring[edge], q = ring[(edge + 1) % ring.length];
  const plan = doorPlan(b, Math.hypot(q[0] - p[0], q[1] - p[1]));
  return [
    ...(plan.garage ? [[plan.garage[0] - 0.2, plan.garage[0] + plan.garage[1] + 0.2] as [number, number]] : []),
    ...(plan.door ? [[plan.door[0] - 0.3, plan.door[0] + plan.door[1] + 0.3] as [number, number]] : []),
  ];
}

/**
 * Glass panes over the facade's windows, a little proud of the wall, one
 * window = one texture repeat (so CSP can put a room behind each at night).
 */
function windowPanes(cm: ChunkedMesh, p: Vec2, q: Vec2, u0: number, floor: number, top: number, skip: [number, number][], L: Layout): void {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (len < 1) return;
  const d: Vec2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
  const out: Vec2 = [d[1], -d[0]]; // right of p->q: outside, for a counter-clockwise ring
  const start = u0 * L.period; // metres into the facade pattern where this wall begins
  for (let storey = floor; storey < top; storey += L.storey) {
    for (let period = Math.floor(start / L.period) * L.period; period < start + len; period += L.period) {
      for (const w of L.openings) {
        if (w.kind === "door") continue;
        const a = period + w.x0 - start, c = period + w.x1 - start;
        if (a < 0.15 || c > len - 0.15 || storey + w.z1 > top - 0.05) continue;
        if (skip.some(([s0, s1]) => a < s1 && c > s0)) continue;
        const at = (m: number, z: number): Vec3 => [p[0] + d[0] * m + out[0] * 0.015, p[1] + d[1] * m + out[1] * 0.015, z];
        face(cm.next(4), [at(a, storey + w.z0), at(c, storey + w.z0), at(c, storey + w.z1), at(a, storey + w.z1)],
          (v) => [Math.hypot(v[0] - p[0], v[1] - p[1]) - a > (c - a) / 2 ? 1 : 0, v[2] > storey + (w.z0 + w.z1) / 2 ? 0 : 1]);
      }
    }
  }
}

/** One flat polygon with an explicit normal. */
function face(mb: MeshBuilder, pts: Vec3[], uv: (p: Vec3) => [number, number]): void {
  const [a, b, c] = pts;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
  const l = Math.hypot(nx, ny, nz) || 1;
  const i0 = mb.vertexCount;
  for (const p of pts) {
    const [u, v] = uv(p);
    mb.vertex(p, u, v);
    mb.normals!.push(nx / l, ny / l, nz / l);
  }
  for (let k = 1; k < pts.length - 1; k++) mb.tri(i0, i0 + k, i0 + k + 1);
}

/** A square post from z0 to z1 at (x, y). */
function post(mb: MeshBuilder, x: number, y: number, z0: number, z1: number, half = 0.06): void {
  const c: Vec2[] = [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]];
  for (let k = 0; k < 4; k++) {
    const p = c[k], q = c[(k + 1) % 4];
    face(mb, [[p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]], (v) => [v[0] + v[1], v[2]]);
  }
}

/** Which facades and roof finishes these buildings wear (so only those textures ship). */
export function usedFinishes(buildings: Building[]): { facades: Set<number>; roofs: Set<number> } {
  const facades = new Set<number>(), roofs = new Set<number>();
  for (const b of buildings) {
    facades.add(b.facade);
    if (b.groundFacade !== undefined) facades.add(b.groundFacade);
    if (b.under !== undefined && b.stumps) facades.add(b.under);
    roofs.add(b.roofColour);
  }
  return { facades, roofs };
}

interface Band {
  facade: number;
  L: Layout;
  z0: number;
  z1: number;
  /** The floor the texture's storeys count from. */
  floor: number;
  panes: boolean;
  /** Where the garage and front door are kept clear of windows. */
  front: boolean;
}

/**
 * Walls (collidable, one mesh set per facade), roofs (one per finish), and
 * what hangs off them: soffits, verandahs on posts, shop awnings, garage
 * and front doors, driveways, window glass. Gable and skillion roofs run
 * along the long side.
 */
export function buildBuildings(buildings: Building[], ground: HeightFn): Kn5MeshNode[] {
  const walls = new Map<number, ChunkedMesh>(), roofs = new Map<number, ChunkedMesh>();
  const of = (m: Map<number, ChunkedMesh>, k: number) => {
    let c = m.get(k);
    if (!c) m.set(k, (c = new ChunkedMesh(0)));
    return c;
  };
  const soffits = new ChunkedMesh(0), garages = new ChunkedMesh(0), doors = new ChunkedMesh(0), drives = new ChunkedMesh(0);
  const panes = new ChunkedMesh(0), posts = new ChunkedMesh(0), decks = new ChunkedMesh(0), awnings = new ChunkedMesh(0);
  for (const b of buildings) {
    const ring = ringArea(b.ring) < 0 ? b.ring.slice().reverse() : b.ring;
    const hs = ring.map(([x, y]) => ground(x, y));
    const floor = Math.min(...hs);
    const base = floor - 0.4;
    const stumps = b.stumps ?? 0, floor0 = floor + stumps;
    const top = Math.max(...hs) + stumps + b.height;
    const pitched = b.roof !== "flat" && ring.length === 4;
    const wallTop = pitched ? top : top + (b.parapet ?? 0);
    const edge = frontEdge(b, ring);
    const F = FACADES[b.facade], L: Layout = LAYOUTS[F.layout];
    const G = b.groundFacade !== undefined ? FACADES[b.groundFacade] : null;
    const LG: Layout | null = G ? LAYOUTS[G.layout] : null;

    // Bands up the wall: lattice between the stumps, a shopfront ground floor, then the facade.
    const bands: Band[] = [];
    if (stumps > 0 && b.under !== undefined) bands.push({ facade: b.under, L: LAYOUTS.blank, z0: base, z1: floor0, floor, panes: false, front: false });
    let z = stumps > 0 ? floor0 : base;
    if (LG) {
      const gTop = Math.min(floor0 + LG.storey, wallTop);
      bands.push({ facade: b.groundFacade!, L: LG, z0: z, z1: gTop, floor: floor0, panes: LG.panes, front: true });
      z = gTop;
    }
    // (Up to the roof: a parapet above it is plain wall, done below.)
    if (z < top - 0.01) bands.push({ facade: b.facade, L, z0: z, z1: top, floor: LG ? floor0 + LG.storey : floor0, panes: L.panes, front: !LG });
    const reserved = frontReserved(b, ring, edge);
    for (const band of bands) {
      const wm = of(walls, band.facade).next(ring.length * 4 + 8);
      let u = 0;
      for (let k = 0; k < ring.length; k++) {
        const p = ring[k], q = ring[(k + 1) % ring.length];
        if (band.panes) windowPanes(panes, p, q, u, band.floor, Math.min(band.z1, top), band.front && k === edge ? reserved : [], band.L);
        u = wall(wm, p, q, band.z0, band.z1, u, band.floor, band.L);
      }
    }
    const at = (p: Vec2, h = top): Vec3 => [p[0], p[1], h];
    // Gable ends and the like: wall from the band below the windows, squeezed to fit.
    const plainWall = (zLo: number, zHi: number) => (p: Vec3): [number, number] =>
      [(p[0] + p[1]) / L.period, 1 - (L.plain[0] + ((p[2] - zLo) / Math.max(0.01, zHi - zLo)) * (L.plain[1] - L.plain[0])) / L.storey];
    const rm = of(roofs, b.roofColour).next(ring.length * 3 + 16);

    if (pitched) {
      const pitch = Math.tan((b.pitch * Math.PI) / 180), EAVE = eaveOf(b);
      // Rotate so r[0]->r[1] is a long side (an eave).
      const l0 = Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
      const l1 = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]);
      const r = l0 >= l1 ? ring : [ring[1], ring[2], ring[3], ring[0]];
      const span = Math.min(l0, l1), long = Math.max(l0, l1);
      const c = centroid(r);
      const e: Vec2 = [(r[1][0] - r[0][0]) / long, (r[1][1] - r[0][1]) / long], n: Vec2 = [-e[1], e[0]];
      const skillion = b.roof === "skillion";
      // Height of the roof plane at a point: a skillion rises from the r[2]-r[3] side to the r[0]-r[1] side.
      const across = (p: Vec2) => (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1]; // + toward r[2], r[3]
      const skillionZ = (p: Vec2) => top + (span / 2 - across(p)) * pitch;
      // The roof's edge: the footprint grown by the overhang, dropped to match the pitch.
      const grow = (p: Vec2): Vec3 => {
        const a = (p[0] - c[0]) * e[0] + (p[1] - c[1]) * e[1], b2 = across(p);
        const a2 = a + Math.sign(a) * EAVE, b3 = b2 + Math.sign(b2) * EAVE;
        const g: Vec2 = [c[0] + e[0] * a2 + n[0] * b3, c[1] + e[1] * a2 + n[1] * b3];
        return [g[0], g[1], skillion ? skillionZ(g) : top - EAVE * pitch];
      };
      const g = r.map(grow);
      const wallZ = r.map((p) => (skillion ? skillionZ(p) : top));
      const roofUv = (p: Vec3): [number, number] => [p[0] / 2, -p[1] / 2]; // 2 m texture repeat
      const wm = of(walls, b.facade).next(16);
      if (skillion) {
        face(rm, [g[0], g[1], g[2], g[3]], roofUv);
        // The high side's wall carries on up to the roof, and the ends are triangles.
        face(wm, [at(r[0]), at(r[1]), at(r[1], wallZ[1]), at(r[0], wallZ[0])], plainWall(top, wallZ[0]));
        face(wm, [at(r[1]), at(r[2]), at(r[1], wallZ[1])], plainWall(top, wallZ[1]));
        face(wm, [at(r[3]), at(r[0]), at(r[0], wallZ[0])], plainWall(top, wallZ[0]));
      } else {
        const ridgeZ = top + (span / 2) * pitch;
        // Ridge along the long axis: full length for a gable (to the eaves), shortened by half the span each end for a hip.
        const inset = b.roof === "hip" ? Math.min(long / 2, span / 2) : -EAVE;
        const ridge = (sign: -1 | 1): Vec3 => [c[0] + e[0] * sign * (long / 2 - inset), c[1] + e[1] * sign * (long / 2 - inset), ridgeZ];
        const ridgeA = ridge(-1), ridgeB = ridge(1);
        face(rm, [g[0], g[1], ridgeB, ridgeA], roofUv);
        face(rm, [g[2], g[3], ridgeA, ridgeB], roofUv);
        if (b.roof === "hip") {
          face(rm, [g[1], g[2], ridgeB], roofUv);
          face(rm, [g[3], g[0], ridgeA], roofUv);
        } else {
          // Gable ends: the wall carries on up to the ridge, in the wall's plane.
          const wallRidge = (sign: -1 | 1): Vec3 => [c[0] + e[0] * sign * long / 2, c[1] + e[1] * sign * long / 2, ridgeZ];
          face(wm, [at(r[1]), at(r[2]), wallRidge(1)], plainWall(top, ridgeZ));
          face(wm, [at(r[3]), at(r[0]), wallRidge(-1)], plainWall(top, ridgeZ));
        }
      }
      // Soffits: under the overhang, from the top of the wall out to the roof's edge, facing down.
      const sm = soffits.next(16);
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        face(sm, [at(r[k], wallZ[k]), at(r[k2], wallZ[k2]), g[k2], g[k]], (p) => [p[0] / 4, p[1] / 4]);
      }
    } else {
      const tris = earcut(ring.flatMap((p) => p));
      const i0 = rm.vertexCount;
      for (const [x, y] of ring) {
        rm.vertex([x, y, top], x / 2, -y / 2);
        rm.normals!.push(0, 0, 1);
      }
      for (let t = 0; t < tris.length; t += 3) {
        const [a, b2, c] = [tris[t], tris[t + 1], tris[t + 2]];
        const cross = (ring[b2][0] - ring[a][0]) * (ring[c][1] - ring[a][1]) - (ring[b2][1] - ring[a][1]) * (ring[c][0] - ring[a][0]);
        if (cross >= 0) rm.tri(i0 + a, i0 + b2, i0 + c);
        else rm.tri(i0 + a, i0 + c, i0 + b2);
      }
      // The parapet, outside and in (the inside seen from above or from higher ground).
      if (wallTop > top + 0.05) {
        const wm = of(walls, b.facade).next(ring.length * 8);
        for (let k = 0; k < ring.length; k++) {
          const p = ring[k], q = ring[(k + 1) % ring.length];
          face(wm, [at(p), at(q), at(q, wallTop), at(p, wallTop)], plainWall(top, wallTop));
          face(wm, [at(q), at(p), at(p, wallTop), at(q, wallTop)], plainWall(top, wallTop));
        }
      }
    }

    if (edge >= 0) {
      const p = ring[edge], q = ring[(edge + 1) % ring.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const d: Vec2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len], out: Vec2 = [d[1], -d[0]];
      const pt = (m: number, o: number): Vec2 => [p[0] + d[0] * m + out[0] * o, p[1] + d[1] * m + out[1] * o];
      if (hasFrontDoors(b)) frontage(b, ring, edge, ground, { garage: garages.next(8), door: doors.next(4), drive: drives.next(16) });
      // Verandah: a skillion of the roof's sheeting on posts, out from under the eaves; a deck at floor height on stumps.
      const depth = Math.min(2.6, (b.setback ?? 6) - 1.2);
      if (b.verandah && len >= 5 && depth >= 1.5) {
        const zw = top - (pitched ? eaveOf(b) * Math.tan((b.pitch * Math.PI) / 180) : 0) - 0.15;
        const zo = zw - (depth + 0.3) * Math.tan((10 * Math.PI) / 180);
        const vr: Vec3[] = [[...pt(-0.2, depth + 0.3), zo], [...pt(len + 0.2, depth + 0.3), zo], [...pt(len + 0.2, 0), zw], [...pt(-0.2, 0), zw]];
        face(rm, vr, (v) => [v[0] / 2, -v[1] / 2]);
        face(soffits.next(4), vr.slice().reverse(), (v) => [v[0] / 4, v[1] / 4]);
        const pm = posts.next(16 * 8);
        for (let m = 0.15; m <= len - 0.1; m += Math.max(2, (len - 0.3) / Math.max(1, Math.round((len - 0.3) / 2.6)))) {
          const [x, y] = pt(m, depth);
          post(pm, x, y, ground(x, y) - 0.2, zo + 0.3 * Math.tan((10 * Math.PI) / 180));
        }
        if (stumps > 0.3) {
          const dk: Vec3[] = [[...pt(0, depth + 0.1), floor0], [...pt(len, depth + 0.1), floor0], [...pt(len, 0), floor0], [...pt(0, 0), floor0]];
          face(decks.next(4), dk, (v) => [v[0] / 2, v[1] / 2]);
          if (b.under !== undefined) {
            // Lattice skirt round the deck.
            const lm = of(walls, b.under).next(12);
            const corners: Vec2[] = [pt(0, 0), pt(0, depth + 0.1), pt(len, depth + 0.1), pt(len, 0)];
            for (let k = 0; k < 3; k++) wall(lm, corners[k], corners[k + 1], base, floor0, 0, floor, LAYOUTS.blank);
          }
        }
      }
      // Shop awning: over the footpath, under the sign, cantilevered.
      const reach = Math.min(3, (b.setback ?? 3.4) - 0.4);
      if (b.awning && len >= 4 && reach >= 1.2) {
        const za = floor0 + 3, th = 0.35;
        const am = awnings.next(24);
        const A = pt(0, 0), B = pt(len, 0), C = pt(len, reach), D = pt(0, reach);
        // Top (facing up) and underside (facing down).
        face(am, [[...A, za + th], [...D, za + th], [...C, za + th], [...B, za + th]], (v) => [v[0] / 4, v[1] / 4]);
        face(am, [[...A, za], [...B, za], [...C, za], [...D, za]], (v) => [v[0] / 4, v[1] / 4]);
        // Fascia across the front and down each end, facing out.
        face(am, [[...D, za], [...C, za], [...C, za + th], [...D, za + th]], (v) => [v[0] / 4, v[2]]);
        face(am, [[...A, za], [...D, za], [...D, za + th], [...A, za + th]], (v) => [v[0] / 4, v[2]]);
        face(am, [[...C, za], [...B, za], [...B, za + th], [...C, za + th]], (v) => [v[0] / 4, v[2]]);
      }
    }
  }
  const out: Kn5MeshNode[] = [];
  walls.forEach((cm, fi) => cm.all().forEach((m, i) => out.push(m.toKn5(`1WALL_BLD_${FACADES[fi].name}_${pad(i)}`, `facade_${FACADES[fi].name}`))));
  roofs.forEach((cm, ri) => cm.all().forEach((m, i) => out.push(m.toKn5(`ROOF_${ROOF_COLOURS[ri].name}_${pad(i)}`, `roof_${ROOF_COLOURS[ri].name}`))));
  soffits.all().forEach((m, i) => out.push(m.toKn5(`SOFFIT_${pad(i)}`, "canopy", { castShadows: false })));
  panes.all().forEach((m, i) => out.push(m.toKn5(`WINDOWS_${pad(i)}`, "window", { castShadows: false })));
  garages.all().forEach((m, i) => out.push(m.toKn5(`GARAGE_${pad(i)}`, "garage", { castShadows: false })));
  doors.all().forEach((m, i) => out.push(m.toKn5(`DOOR_${pad(i)}`, "door", { castShadows: false })));
  drives.all().forEach((m, i) => out.push(m.toKn5(`DRIVEWAY_${pad(i)}`, "concrete", { castShadows: false })));
  posts.all().forEach((m, i) => out.push(m.toKn5(`POSTS_${pad(i)}`, "canopy")));
  decks.all().forEach((m, i) => out.push(m.toKn5(`DECK_${pad(i)}`, "timber")));
  awnings.all().forEach((m, i) => out.push(m.toKn5(`AWNING_${pad(i)}`, "canopy")));
  return out;
}
