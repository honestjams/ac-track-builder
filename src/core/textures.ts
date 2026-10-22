// Procedural textures (asphalt with markings, verge, grass) so a build never
// depends on a texture download, and small raster drawing for map.png and
// the Content Manager outline/preview images.

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

/**
 * Asphalt across the full road width (u 0..1, left to right) and 12 m along
 * it (v). White edge lines; a dashed centre line (3 m line, 9 m gap) on
 * two-lane roads.
 */
export function asphaltTexture(twoLane: boolean): Uint8Array {
  const w = 512, h = 1024;
  const coarse = valueNoise(w, h, 8, 11), mid = valueNoise(w, h, 64, 12);
  const r = rng(13);
  const grain = Float32Array.from({ length: w * h }, r);
  const px = fill(w, h, (x, y, i) => {
    const u = x / w, v = y / h;
    const base = 62 + (coarse[i] - 0.5) * 14 + (mid[i] - 0.5) * 10 + (grain[i] - 0.5) * 22;
    const edge = (u > 0.018 && u < 0.036) || (u > 0.964 && u < 0.982);
    const centre = twoLane && u > 0.491 && u < 0.509 && v < 0.25;
    if (edge || centre) {
      const paint = 205 + (grain[i] - 0.5) * 30 + (coarse[i] - 0.5) * 20;
      return [paint, paint, paint - 4];
    }
    // Darker wheel tracks where tyres polish the surface.
    const lane = twoLane ? Math.min(Math.abs(u - 0.25), Math.abs(u - 0.75)) : Math.abs(u - 0.5);
    const track = Math.max(0, 1 - Math.abs(lane - 0.12) / 0.05) * 6;
    return [base - track, base - track, base - track + 2];
  });
  return encodePng(px, w, h, { alpha: false });
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

/** Facade: one storey (3 m) tall, 4 m wide, with a window. */
export function facadeTexture(): Uint8Array {
  const w = 128, h = 96;
  const r = rng(61);
  return encodePng(fill(w, h, (x, y) => {
    const win = x > 30 && x < 98 && y > 22 && y < 70;
    if (win) {
      const g = 60 + (y - 22) * 0.8 + r() * 8;
      return [g * 0.7, g * 0.82, g];
    }
    const k = 196 + (r() - 0.5) * 16;
    return [k, k * 0.95, k * 0.86];
  }), w, h, { alpha: false });
}

export function roofTexture(): Uint8Array {
  const w = 64, h = 64;
  const r = rng(71);
  return encodePng(fill(w, h, () => {
    const k = 95 + (r() - 0.5) * 20;
    return [k * 1.05, k * 0.95, k * 0.9];
  }), w, h, { alpha: false });
}
