// Procedural textures (asphalt with markings, verge, grass) so a build never
// depends on a texture download, and small raster drawing for map.png and
// the Content Manager outline/preview images.

import { encodeDdsDxt1 } from "./dds";
import { encodePng } from "./png";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise in 0..1 with `cells` lattice cells across. */
function valueNoise(w: number, h: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const cx = cells, cy = Math.max(1, Math.round((cells * h) / w));
  const lattice = Array.from({ length: cx * cy }, r);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * cy, iy = Math.floor(fy), ty = fy - iy;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cx, ix = Math.floor(fx), tx = fx - ix;
      const sx = tx * tx * (3 - 2 * tx);
      const a = lattice[(iy % cy) * cx + (ix % cx)], b = lattice[(iy % cy) * cx + ((ix + 1) % cx)];
      const c = lattice[((iy + 1) % cy) * cx + (ix % cx)], d = lattice[((iy + 1) % cy) * cx + ((ix + 1) % cx)];
      out[y * w + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

function fill(w: number, h: number, shade: (x: number, y: number, i: number) => [number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const [r, g, b] = shade(x, y, i);
      px[i * 4] = Math.max(0, Math.min(255, r));
      px[i * 4 + 1] = Math.max(0, Math.min(255, g));
      px[i * 4 + 2] = Math.max(0, Math.min(255, b));
      px[i * 4 + 3] = 255;
    }
  }
  return px;
}

export type SealKind = "asphalt" | "chipseal";

/** Road surface texture repeats every this many metres along the road. */
export const SEAL_LENGTH = 24;

/**
 * Bare road surface (no markings; those are separate geometry) across the
 * full width (u 0..1, left to right) and SEAL_LENGTH metres along (v),
 * tiling seamlessly along the road. RGBA, 512 x 1024.
 *
 *  - asphalt: dense-graded, dark and fine, with sealed cracks ("tar
 *    snakes"), patch repairs, polished wheel paths and an oil-drip line
 *    down each lane.
 *  - chipseal: spray seal, the usual rural Australian surface: lighter,
 *    coarse stone, with binder bleeding through darker in the wheel paths
 *    and premix patches.
 *
 * Returned as DXT1 DDS (these are the largest textures on the road), plus
 * the raw pixels for the browser preview.
 */
export function sealTexture(kind: SealKind, twoLane: boolean, variant: number): { dds: Uint8Array; rgba: Uint8Array; width: number; height: number } {
  const w = 512, h = 1024;
  const seed = (kind === "asphalt" ? 100 : 200) + variant * 17 + (twoLane ? 5 : 0);
  const r = rng(seed);
  const coarse = valueNoise(w, h, 6, seed + 1), mid = valueNoise(w, h, 48, seed + 2), fine = valueNoise(w, h, 160, seed + 3);
  // Wheel paths: two per lane, ~0.9 m either side of each lane's centre.
  const lanes = twoLane ? [0.25, 0.75] : [0.5];
  const laneW = twoLane ? 0.5 : 1;
  const wheel = (u: number) => {
    let best = 0;
    for (const c of lanes) {
      for (const o of [-0.26, 0.26]) best = Math.max(best, 1 - Math.min(1, Math.abs(u - (c + o * laneW)) / (0.09 * laneW)));
    }
    return best * best * (3 - 2 * best);
  };
  const drip = (u: number) => Math.max(...lanes.map((c) => 1 - Math.min(1, Math.abs(u - c) / (0.05 * laneW))));

  const px = new Uint8Array(w * h * 4);
  const stone: [number, number, number][] = [[112, 110, 106], [74, 73, 72], [122, 108, 92], [98, 102, 112], [136, 132, 124]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, u = x / w;
      const wp = wheel(u);
      let c: [number, number, number];
      if (kind === "chipseal") {
        const s = stone[Math.floor(r() * stone.length)];
        const k = 0.85 + (coarse[i] - 0.5) * 0.25 + (mid[i] - 0.5) * 0.2 + (fine[i] - 0.5) * 0.35;
        // Flushed binder in the wheel paths: darker and smoother.
        const flush = wp * (0.35 + coarse[i] * 0.3);
        c = [s[0] * k * (1 - flush) + 52 * flush, s[1] * k * (1 - flush) + 52 * flush, s[2] * k * (1 - flush) + 54 * flush];
      } else {
        const g = (r() - 0.5) * 20 * (1 - wp * 0.5);
        const base = 60 + (coarse[i] - 0.5) * 12 + (mid[i] - 0.5) * 8 + (fine[i] - 0.5) * 10 + g - wp * 5 - drip(u) * 7 * mid[i];
        c = [base, base, base + 2];
      }
      px.set([c[0], c[1], c[2], 255].map((v) => Math.max(0, Math.min(255, v))), i * 4);
    }
  }

  const shade = (x: number, y: number, f: (c: number) => number) => {
    const xx = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const yy = ((Math.floor(y) % h) + h) % h; // wrap along the road
    const i = (yy * w + xx) * 4;
    for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, f(px[i + k])));
  };

  // Patch repairs: rectangles within a lane, a new or faded tone with a sealed edge.
  const patches = 1 + Math.floor(r() * 3);
  for (let p = 0; p < patches; p++) {
    const lane = lanes[Math.floor(r() * lanes.length)];
    const pw = (0.15 + r() * 0.25) * laneW * w, ph = (1.5 + r() * 5) / SEAL_LENGTH * h;
    const px0 = (lane - laneW * 0.4 + r() * laneW * 0.8) * w - pw / 2, py0 = r() * h;
    const tone = kind === "chipseal" ? -30 - r() * 15 : r() < 0.6 ? -9 : 8;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const edge = x < 2 || y < 2 || x > pw - 3 || y > ph - 3;
        shade(px0 + x, py0 + y, (c) => (edge ? c * 0.55 : c + tone + (r() - 0.5) * 6));
      }
    }
  }

  // Sealed cracks: dark meandering lines, mostly along the road, some across.
  const cracks = kind === "asphalt" ? 4 + Math.floor(r() * 4) : 1 + Math.floor(r() * 2);
  for (let c = 0; c < cracks; c++) {
    const along = r() < 0.7;
    let x = twoLane && c === 0 ? w * 0.5 : r() * w, y = r() * h;
    let a = along ? Math.PI / 2 + (r() - 0.5) * 0.4 : (r() - 0.5) * 0.6;
    const len = (along ? 200 + r() * 600 : 80 + r() * 200);
    for (let t = 0; t < len; t++) {
      a += (r() - 0.5) * 0.35;
      if (along) a = Math.PI / 2 + Math.max(-0.5, Math.min(0.5, a - Math.PI / 2));
      x += Math.cos(a);
      y += Math.sin(a);
      for (let dx = -1.5; dx <= 1.5; dx++) shade(x + dx, y, () => 26 + r() * 8);
    }
  }
  return { dds: encodeDdsDxt1(px, w, h), rgba: px, width: w, height: h };
}

/** Road paint, slightly worn. Tiles every metre. */
export function paintTexture(): Uint8Array {
  const w = 64, h = 64;
  const r = rng(301);
  const wear = valueNoise(w, h, 8, 302);
  return encodePng(fill(w, h, (_x, _y, i) => {
    const k = 228 - Math.max(0, wear[i] - 0.6) * 160 + (r() - 0.5) * 18;
    return [k, k, k - 3];
  }), w, h, { alpha: false });
}

export function vergeTexture(): Uint8Array {
  const w = 256, h = 256;
  const n1 = valueNoise(w, h, 16, 21), n2 = valueNoise(w, h, 64, 22);
  const r = rng(23);
  const px = fill(w, h, (_x, _y, i) => {
    const g = r();
    const k = n1[i] * 0.6 + n2[i] * 0.4;
    // gravel at the road edge fading into dry grass (u = 0 outer, 1 inner)
    return [96 + k * 40 + g * 30, 90 + k * 36 + g * 26, 70 + k * 24 + g * 20];
  });
  return encodePng(px, w, h, { alpha: false });
}

export function grassTexture(): Uint8Array {
  const w = 512, h = 512;
  const n1 = valueNoise(w, h, 8, 31), n2 = valueNoise(w, h, 48, 32);
  const r = rng(33);
  const px = fill(w, h, (_x, _y, i) => {
    const k = n1[i] * 0.55 + n2[i] * 0.45, g = r();
    return [52 + k * 40 + g * 18, 78 + k * 46 + g * 22, 36 + k * 22 + g * 12];
  });
  return encodePng(px, w, h, { alpha: false });
}

/**
 * Kerb and gutter concrete: pale grey, weathered, with a contraction joint
 * across the top row (v = 0) so each tile of the texture is one pour.
 */
export function concreteTexture(): Uint8Array {
  const w = 64, h = 256;
  const n1 = valueNoise(w, h, 4, 41), n2 = valueNoise(w, h, 16, 42);
  const r = rng(43);
  return encodePng(fill(w, h, (_x, y, i) => {
    const k = n1[i] * 0.6 + n2[i] * 0.4;
    const joint = y < 2 ? 0.55 : 1;
    const g = 150 + k * 34 + (r() - 0.5) * 16;
    return [g * joint, g * joint, (g - 4) * joint];
  }), w, h, { alpha: false });
}

export function solidTexture(rgb: [number, number, number]): Uint8Array {
  return encodePng(fill(4, 4, () => rgb), 4, 4, { alpha: false });
}

/** RGBA canvas with anti-aliased thick polylines, for map and outline images. */
export class Raster {
  readonly px: Uint8Array;
  constructor(readonly width: number, readonly height: number, background: [number, number, number, number] = [0, 0, 0, 0]) {
    this.px = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.px.set(background, i * 4);
  }

  private blend(x: number, y: number, rgba: [number, number, number, number], cover: number): void {
    const i = (y * this.width + x) * 4;
    const a = (rgba[3] / 255) * cover;
    const da = this.px[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) {
      this.px[i + k] = Math.round((rgba[k] * a + this.px[i + k] * da * (1 - a)) / oa);
    }
    this.px[i + 3] = Math.round(oa * 255);
  }

  line(pts: [number, number][], thickness: number, rgba: [number, number, number, number]): void {
    const r = thickness / 2;
    // Coverage per pixel is the max over segments, so joints do not double up.
    const cover = new Float32Array(this.width * this.height);
    for (let s = 1; s < pts.length; s++) {
      const [ax, ay] = pts[s - 1], [bx, by] = pts[s];
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(this.width - 1, Math.ceil(Math.max(ax, bx) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(this.height - 1, Math.ceil(Math.max(ay, by) + r + 1));
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const cx = x + 0.5, cy = y + 0.5;
          const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / L2));
          const d = Math.hypot(cx - (ax + dx * t), cy - (ay + dy * t));
          const c = Math.max(0, Math.min(1, r + 0.5 - d));
          const k = y * this.width + x;
          if (c > cover[k]) cover[k] = c;
        }
      }
    }
    for (let k = 0; k < cover.length; k++) {
      if (cover[k] > 0) this.blend(k % this.width, Math.floor(k / this.width), rgba, cover[k]);
    }
  }

  dot(x: number, y: number, radius: number, rgba: [number, number, number, number]): void {
    for (let py = Math.floor(y - radius - 1); py <= Math.ceil(y + radius + 1); py++) {
      for (let px = Math.floor(x - radius - 1); px <= Math.ceil(x + radius + 1); px++) {
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
        const c = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(px + 0.5 - x, py + 0.5 - y)));
        if (c > 0) this.blend(px, py, rgba, c);
      }
    }
  }

  png(): Uint8Array {
    return encodePng(this.px, this.width, this.height);
  }
}

/* ---------------- scenery textures ---------------- */

/** Tree atlas variants: u ranges within the 512 x 512 atlas. */
export const TREE_VARIANTS = [
  { u0: 0, u1: 0.5, kind: "broadleaf" },
  { u0: 0.5, u1: 1, kind: "conifer" },
] as const;

/**
 * Two tree sprites side by side with an alpha channel, for alpha-tested
 * crossed-quad trees: an open eucalypt/broadleaf canopy and a conifer.
 */
export function treeAtlas(): Uint8Array {
  const w = 512, h = 512;
  const px = new Uint8Array(w * h * 4);
  const r = rng(41);
  const put = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (Math.floor(y) * w + Math.floor(x)) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };
  const blob = (cx: number, cy: number, rad: number, shade: number, x0: number, x1: number) => {
    for (let y = cy - rad; y <= cy + rad; y++) {
      for (let x = Math.max(x0, cx - rad); x <= Math.min(x1 - 1, cx + rad); x++) {
        const d = Math.hypot(x - cx, y - cy) / rad;
        if (d > 1 || r() < d * d * 0.55) continue; // ragged, see-through edges
        const k = shade * (0.75 + 0.35 * (1 - d)) * (0.85 + r() * 0.3);
        put(x, y, [34 * k + 8, 70 * k + 14, 30 * k + 6]);
      }
    }
  };
  // Broadleaf: trunk with a couple of branches, clumped canopy.
  for (let y = 330; y < 512; y++) {
    const t = 3.5 + (512 - y) * 0.008;
    for (let x = 128 - t; x < 128 + t; x++) put(x, y, [92 + r() * 25, 78 + r() * 20, 62 + r() * 15]);
  }
  for (let i = 0; i < 110; i++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r());
    blob(128 + Math.cos(a) * d * 92, 215 + Math.sin(a) * d * 150, 16 + r() * 24, 0.7 + r() * 0.6, 0, 256);
  }
  // Conifer: narrow trunk, stacked tiers.
  for (let y = 380; y < 512; y++) for (let x = 378; x < 390; x++) put(x, y, [78 + r() * 20, 60 + r() * 15, 45]);
  for (let tier = 0; tier < 9; tier++) {
    const y = 40 + tier * 40, half = 18 + tier * 11;
    for (let i = 0; i < 26; i++) {
      const x = 384 + (r() * 2 - 1) * half;
      blob(x, y + r() * 30, 10 + r() * 10, 0.55 + r() * 0.45, 256, 512);
    }
  }
  return encodePng(px, w, h);
}

/** W-beam guard rail, 1 m along (u) by the beam height (v). */
export function railTexture(): Uint8Array {
  const w = 64, h = 64;
  const r = rng(51);
  return encodePng(fill(w, h, (_x, y) => {
    // Two raised ridges and a central groove.
    const v = y / h;
    const shade = 150 + 45 * Math.cos(v * Math.PI * 4) + (r() - 0.5) * 12;
    return [shade, shade + 2, shade + 6];
  }), w, h, { alpha: false });
}

/** Guide post: white with a black band near the top and a reflector. */
export function postTexture(): Uint8Array {
  const w = 16, h = 64;
  return encodePng(fill(w, h, (x, y) => {
    if (y < 6) return [30, 30, 30];
    if (y >= 8 && y < 16) return x < 8 ? [230, 40, 30] : [240, 170, 30];
    if (y < 22) return [25, 25, 25];
    return [232, 232, 226];
  }), w, h, { alpha: false });
}

/** Australian roof colours (Colorbond-style metal, plus terracotta tile). */
export const ROOF_COLOURS: { name: string; rgb: [number, number, number]; tile?: boolean }[] = [
  { name: "surfmist", rgb: [228, 226, 213] },
  { name: "shalegrey", rgb: [189, 191, 186] },
  { name: "windspray", rgb: [136, 139, 138] },
  { name: "woodland", rgb: [75, 76, 70] },
  { name: "monument", rgb: [50, 50, 51] },
  { name: "cream", rgb: [233, 220, 184] },
  { name: "terracotta", rgb: [181, 88, 58], tile: true },
];

/** Roof sheet, 2 m x 2 m: corrugated metal or rows of tiles, in one colour. */
export function roofTexture(colour: (typeof ROOF_COLOURS)[number]): Uint8Array {
  const w = 128, h = 128;
  const r = rng(71 + colour.rgb[0]);
  const [cr, cg, cb] = colour.rgb;
  return encodePng(fill(w, h, (x, y) => {
    let k: number;
    if (colour.tile) {
      // Overlapping tile rows ~0.33 m, with staggered joints.
      const row = Math.floor(y / 21), inRow = (y % 21) / 21;
      const joint = (x + (row % 2) * 16) % 32 < 2;
      k = 0.78 + inRow * 0.3 - (joint ? 0.25 : 0);
    } else {
      // Corrugations every ~76 mm run down the slope (along v).
      k = 0.9 + 0.12 * Math.sin((x / w) * Math.PI * 2 * 26);
    }
    k += (r() - 0.5) * 0.06;
    return [cr * k, cg * k, cb * k];
  }), w, h, { alpha: false });
}

export const FACADES = ["brick", "weatherboard", "render", "creambrick", "fibro"] as const;

/**
 * One storey (3 m) tall by 8 m wide: a wide living-room window and a small,
 * higher one (bathroom or bedroom), in white frames, so a wall reads as a
 * house rather than a row of motel rooms.
 */
export function facadeTexture(kind: (typeof FACADES)[number]): Uint8Array {
  const w = 256, h = 96; // 32 px per metre
  const r = rng(61 + kind.length);
  const windows: [number, number, number, number][] = [
    [36, 108, 24, 66], // 2.25 m wide, sill at 0.9 m
    [170, 210, 24, 50], // 1.25 m wide, sill at 1.4 m
  ];
  return encodePng(fill(w, h, (x, y) => {
    for (const [x0, x1, y0, y1] of windows) {
      if (x > x0 && x < x1 && y > y0 && y < y1) {
        // Glass, a mullion in the wide one, and a hint of curtain at the top.
        if (x1 - x0 > 60 && Math.abs(x - (x0 + x1) / 2) < 1.5) return [235, 235, 230];
        const g = 55 + (y - y0) * 0.9 + r() * 8 + (y < y0 + 6 ? 40 : 0);
        return [g * 0.7, g * 0.82, g];
      }
      if (x > x0 - 4 && x < x1 + 4 && y > y0 - 4 && y < y1 + 4) return [235, 235, 230];
    }
    const n = (r() - 0.5) * 14;
    if (kind === "brick" || kind === "creambrick") {
      // 230 x 76 mm bricks, stretcher bond.
      const course = Math.floor(y / 2.5);
      const mortar = y % 2.5 < 0.6 || (x + (course % 2) * 4) % 8 < 0.9;
      const tone = ((course * 7 + Math.floor((x + (course % 2) * 4) / 8) * 13) % 5) * 6;
      if (kind === "creambrick") return mortar ? [200 + n, 196 + n, 186 + n] : [214 + tone + n, 190 + tone / 2 + n, 148 + n];
      if (mortar) return [196 + n, 188 + n, 172 + n];
      return [150 + tone + n, 78 + tone / 2 + n, 58 + n];
    }
    if (kind === "weatherboard") {
      // 150 mm boards with a shadow line under each.
      const board = (y % 5) / 5;
      const k = board > 0.8 ? 0.8 : 0.97 + board * 0.03;
      return [238 * k + n, 236 * k + n, 226 * k + n];
    }
    if (kind === "fibro") {
      // Fibro-cement sheets, 1.2 m wide, with cover strips.
      const strip = x % 38 < 2;
      return strip ? [205 + n, 205 + n, 198 + n] : [226 + n / 2, 224 + n / 2, 214 + n / 2];
    }
    return [214 + n, 200 + n, 172 + n];
  }), w, h, { alpha: false });
}

/** A Colorbond roller door, 2.6 m x 2.1 m: fine horizontal ribs, a darker bottom rail. */
export function garageTexture(): Uint8Array {
  const w = 64, h = 64;
  const r = rng(91);
  return encodePng(fill(w, h, (_x, y) => {
    const n = (r() - 0.5) * 6;
    if (y > 60) return [120 + n, 122 + n, 120 + n];
    const k = 0.92 + 0.08 * Math.sin((y / h) * Math.PI * 2 * 14);
    return [214 * k + n, 212 * k + n, 200 * k + n];
  }), w, h, { alpha: false });
}
