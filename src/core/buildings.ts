// Buildings, from two sources:
//
//  - OSM footprints (via OpenFreeMap vector tiles or Overpass), extruded to
//    their mapped height. Coverage is good in cities and thin in the bush.
//  - Placeholders detected from the aerial imagery: compact patches that
//    look like a roof (pale or dark grey metal, terracotta tile) become a
//    house with a hip or gable roof in the matching colour.
//
// Houses get eaves (the roof overhangs the walls, with white soffits) and,
// along a street frontage, often a roller door on the garage facing it.
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
import { FACADES, ROOF_COLOURS } from "./textures";
import { pad } from "./roadMesh";

export interface Building {
  /** Footprint, local metres, first point not repeated. */
  ring: Vec2[];
  /** Wall height to the eaves, metres. */
  height: number;
  roof: "flat" | "gable" | "hip";
  /** Index into ROOF_COLOURS. */
  roofColour: number;
  /** Index into FACADES. */
  facade: number;
  /** Mapped, a roof patch found in the photo, or a house found along a street frontage. */
  source: "osm" | "detected" | "frontage";
  /** The wall facing the street (its two corners), where known. */
  front?: [Vec2, Vec2];
  /** A garage door on the front wall. */
  garage?: boolean;
  /** Distance from the road edge to the front wall, metres, where known. */
  setback?: number;
}

/** Most Australian houses have a hip roof; about a third a gable. */
export function houseRoof(rand: () => number): "gable" | "hip" {
  return rand() < 0.68 ? "hip" : "gable";
}

const ROOF_PITCH = Math.tan((22 * Math.PI) / 180);
/** Eave overhang beyond the walls, metres. */
const EAVE = 0.45;

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
function isRectangle(ring: Vec2[]): boolean {
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
    height,
    roof: !small || !isRectangle(ring) ? "flat" : tags["roof:shape"] === "gabled" ? "gable" : tags["roof:shape"] === "hipped" ? "hip" : houseRoof(rand),
    roofColour: roofTag >= 0 ? roofTag : Math.floor(rand() * ROOF_COLOURS.length),
    facade: small ? Math.floor(rand() * FACADES.length) : 2,
    source: "osm",
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
    out.push({
      ring,
      height: area > 250 ? 3.6 : 2.8,
      roof: houseRoof(rand),
      roofColour: nearestRoofColour(rgb),
      facade: Math.floor(rand() * FACADES.length),
      source: "detected",
    });
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

function wall(mb: MeshBuilder, p: Vec2, q: Vec2, base: number, top: number, u0: number, floor: number): number {
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const n: Vec3 = [(q[1] - p[1]) / (len || 1), -(q[0] - p[0]) / (len || 1), 0];
  const i = mb.vertexCount;
  // Texture: 8 m by one 3 m storey, its bottom on the ground floor, so windows sit at sill height on every storey.
  const u1 = u0 + len / 8, v = (z: number) => 1 - (z - floor) / 3;
  mb.vertex([p[0], p[1], base], u0, v(base));
  mb.vertex([q[0], q[1], base], u1, v(base));
  mb.vertex([q[0], q[1], top], u1, v(top));
  mb.vertex([p[0], p[1], top], u0, v(top));
  for (let j = 0; j < 4; j++) mb.normals!.push(...n);
  mb.quad(i, i + 1, i + 2, i + 3);
  return u1;
}

/**
 * What a house shows the street: a roller door on the garage at one end of
 * the front wall (2.6 m x 2.1 m) with a concrete driveway from it out to the
 * nature strip, and the front door toward the other end.
 */
function frontage(
  b: Building,
  ring: Vec2[],
  ground: HeightFn,
  mesh: { garage: MeshBuilder; door: MeshBuilder; drive: MeshBuilder },
): void {
  const front = b.front!;
  const same = (a: Vec2, c: Vec2) => Math.hypot(a[0] - c[0], a[1] - c[1]) < 0.05;
  // The front wall as it runs in the (counter-clockwise) ring, so things on it face out.
  const k = ring.findIndex((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return (same(p, front[0]) && same(q, front[1])) || (same(p, front[1]) && same(q, front[0]));
  });
  if (k < 0) return;
  const p = ring[k], q = ring[(k + 1) % ring.length];
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
  const garage = b.garage && len >= 6;
  if (garage) {
    panel(mesh.garage, 0.6, 2.6, 2.1);
    // The driveway: from the door out to where the nature strip starts, about 3.5 m from the road.
    const run = (b.setback ?? 0) - 3.5;
    if (run > 1) {
      const pts: Vec3[] = [];
      for (const [m, o] of [[0.4, 0.05], [3.4, 0.05], [3.4, run], [0.4, run]] as const) {
        const v = along(m, o);
        pts.push([v[0], v[1], ground(v[0], v[1]) + 0.03]);
      }
      face(mesh.drive, pts.reverse(), (v) => [v[0] / 3, v[1] / 3]);
    }
  }
  // The front door: toward the far end from the garage, or a third of the way along.
  panel(mesh.door, garage ? Math.min(len - 1.4, 4.2) : len / 3, 0.85, 2.05);
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

/**
 * Walls (collidable, one mesh set per facade) and roofs (one mesh set per
 * colour). Gable roofs run their ridge along the long side.
 */
export function buildBuildings(buildings: Building[], ground: HeightFn): Kn5MeshNode[] {
  const walls = FACADES.map(() => new ChunkedMesh(0));
  const roofs = ROOF_COLOURS.map(() => new ChunkedMesh(0));
  const soffits = new ChunkedMesh(0), garages = new ChunkedMesh(0), doors = new ChunkedMesh(0), drives = new ChunkedMesh(0);
  for (const b of buildings) {
    const ring = ringArea(b.ring) < 0 ? b.ring.slice().reverse() : b.ring;
    const hs = ring.map(([x, y]) => ground(x, y));
    const base = Math.min(...hs) - 0.4;
    const top = Math.max(...hs) + b.height;
    const wm = walls[b.facade].next(ring.length * 4 + 8);
    const rm = roofs[b.roofColour].next(ring.length * 3 + 8);
    let u = 0;
    for (let k = 0; k < ring.length; k++) u = wall(wm, ring[k], ring[(k + 1) % ring.length], base, top, u, Math.min(...hs));
    if (b.roof !== "flat" && ring.length === 4) {
      // Rotate so r[0]->r[1] is a long side (an eave).
      const l0 = Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]);
      const l1 = Math.hypot(ring[2][0] - ring[1][0], ring[2][1] - ring[1][1]);
      const r = l0 >= l1 ? ring : [ring[1], ring[2], ring[3], ring[0]];
      const span = Math.min(l0, l1), long = Math.max(l0, l1);
      const ridgeZ = top + (span / 2) * ROOF_PITCH;
      // The roof's edge: the footprint grown by the overhang, dropped to match the pitch.
      const eaveZ = top - EAVE * ROOF_PITCH;
      const c = centroid(r);
      const e: Vec2 = [(r[1][0] - r[0][0]) / long, (r[1][1] - r[0][1]) / long], n: Vec2 = [-e[1], e[0]];
      const grow = (p: Vec2): Vec3 => {
        const a = (p[0] - c[0]) * e[0] + (p[1] - c[1]) * e[1], b2 = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1];
        const a2 = a + Math.sign(a) * EAVE, b3 = b2 + Math.sign(b2) * EAVE;
        return [c[0] + e[0] * a2 + n[0] * b3, c[1] + e[1] * a2 + n[1] * b3, eaveZ];
      };
      const g = r.map(grow);
      // Ridge along the long axis: full length for a gable (to the eaves), shortened by half the span each end for a hip.
      const inset = b.roof === "hip" ? Math.min(long / 2, span / 2) : -EAVE;
      const ridge = (sign: -1 | 1): Vec3 => [c[0] + e[0] * sign * (long / 2 - inset), c[1] + e[1] * sign * (long / 2 - inset), ridgeZ];
      const ridgeA = ridge(-1), ridgeB = ridge(1);
      // Roof sheets: 2 m texture repeat.
      const roofUv = (p: Vec3): [number, number] => [p[0] / 2, -p[1] / 2];
      face(rm, [g[0], g[1], ridgeB, ridgeA], roofUv);
      face(rm, [g[2], g[3], ridgeA, ridgeB], roofUv);
      const at = (p: Vec2, z = top): Vec3 => [p[0], p[1], z];
      if (b.roof === "hip") {
        face(rm, [g[1], g[2], ridgeB], roofUv);
        face(rm, [g[3], g[0], ridgeA], roofUv);
      } else {
        // Gable ends: the wall carries on up to the ridge, in the wall's plane.
        const wallRidge = (sign: -1 | 1): Vec3 => [c[0] + e[0] * sign * long / 2, c[1] + e[1] * sign * long / 2, ridgeZ];
        // Plain wall from the band below the windows (no windows up in the gable).
        const plain = (p: Vec3): [number, number] => [p[0] / 8, 0.8 + (ridgeZ - p[2]) * 0.05];
        face(wm, [at(r[1]), at(r[2]), wallRidge(1)], plain);
        face(wm, [at(r[3]), at(r[0]), wallRidge(-1)], plain);
      }
      // Soffits: under the overhang, from the top of the wall out to the roof's edge, facing down.
      const sm = soffits.next(16);
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        face(sm, [at(r[k]), at(r[k2]), g[k2], g[k]], (p) => [p[0] / 4, p[1] / 4]);
      }
      if (b.front) frontage(b, ring, ground, { garage: garages.next(8), door: doors.next(4), drive: drives.next(16) });
      continue;
    }
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
  }
  const out: Kn5MeshNode[] = [];
  walls.forEach((cm, f) => cm.all().forEach((m, i) => out.push(m.toKn5(`1WALL_BLD_${FACADES[f]}_${pad(i)}`, `facade_${FACADES[f]}`))));
  roofs.forEach((cm, c) => cm.all().forEach((m, i) => out.push(m.toKn5(`ROOF_${ROOF_COLOURS[c].name}_${pad(i)}`, `roof_${ROOF_COLOURS[c].name}`))));
  soffits.all().forEach((m, i) => out.push(m.toKn5(`SOFFIT_${pad(i)}`, "canopy", { castShadows: false })));
  garages.all().forEach((m, i) => out.push(m.toKn5(`GARAGE_${pad(i)}`, "garage", { castShadows: false })));
  doors.all().forEach((m, i) => out.push(m.toKn5(`DOOR_${pad(i)}`, "door", { castShadows: false })));
  drives.all().forEach((m, i) => out.push(m.toKn5(`DRIVEWAY_${pad(i)}`, "concrete", { castShadows: false })));
  return out;
}
