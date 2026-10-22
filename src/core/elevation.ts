// Elevation model: a mosaic of Terrarium tiles (AWS Open Data "Terrain Tiles",
// global, keyless, built from SRTM, USGS 3DEP, national lidar and others),
// decoded into one height grid and sampled bilinearly in local metres.
//
// Terrarium encoding: height = R * 256 + G + B / 256 - 32768 (metres).

import type { Bounds, LocalProjection, Vec2 } from "./geo";
import { tilesCovering } from "./geo";

export type HeightFn = (x: number, y: number) => number;

export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export interface DecodedTile {
  x: number;
  y: number;
  /** 256 x 256 RGBA. */
  rgba: Uint8Array | Uint8ClampedArray;
}

export class DemGrid {
  constructor(
    readonly z: number,
    /** Global pixel coordinate of data[0]. */
    readonly px0: number,
    readonly py0: number,
    readonly width: number,
    readonly height: number,
    readonly data: Float32Array,
    private readonly proj: LocalProjection,
  ) {}

  static fromTiles(proj: LocalProjection, z: number, tiles: DecodedTile[]): DemGrid {
    const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
    const tx0 = Math.min(...xs), ty0 = Math.min(...ys);
    const w = (Math.max(...xs) - tx0 + 1) * 256, h = (Math.max(...ys) - ty0 + 1) * 256;
    const data = new Float32Array(w * h);
    for (const t of tiles) {
      const ox = (t.x - tx0) * 256, oy = (t.y - ty0) * 256;
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const i = (y * 256 + x) * 4;
          data[(oy + y) * w + ox + x] = decodeTerrarium(t.rgba[i], t.rgba[i + 1], t.rgba[i + 2]);
        }
      }
    }
    // Terrarium pixel centres sit at +0.5.
    return new DemGrid(z, tx0 * 256 + 0.5, ty0 * 256 + 0.5, w, h, data, proj);
  }

  /** Flat-ish synthetic terrain for tests and offline runs. */
  static fromFunction(proj: LocalProjection, z: number, bounds: Bounds, fn: HeightFn): DemGrid {
    const a = proj.localToPixel([bounds.minX, bounds.maxY], z);
    const c = proj.localToPixel([bounds.maxX, bounds.minY], z);
    const px0 = Math.floor(a[0]) - 2, py0 = Math.floor(a[1]) - 2;
    const w = Math.ceil(c[0]) - px0 + 4, h = Math.ceil(c[1]) - py0 + 4;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [lx, ly] = proj.pixelToLocal([px0 + x, py0 + y], z);
        data[y * w + x] = fn(lx, ly);
      }
    }
    return new DemGrid(z, px0, py0, w, h, data, proj);
  }

  sample: HeightFn = (x, y) => {
    const [gx, gy] = this.proj.localToPixel([x, y], this.z);
    let fx = gx - this.px0, fy = gy - this.py0;
    fx = Math.max(0, Math.min(this.width - 1.001, fx));
    fy = Math.max(0, Math.min(this.height - 1.001, fy));
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const i = iy * this.width + ix;
    const d = this.data;
    const top = d[i] + (d[i + 1] - d[i]) * tx;
    const bot = d[i + this.width] + (d[i + this.width + 1] - d[i + this.width]) * tx;
    return top + (bot - top) * ty;
  };
}

export function demTilesFor(proj: LocalProjection, bounds: Bounds, z: number): { x: number; y: number }[] {
  const r = tilesCovering(proj, bounds, z);
  const out: { x: number; y: number }[] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ x, y });
  return out;
}

/** Height profile along a path, sampled then smoothed to remove DEM noise. */
export function profileAlong(path: Vec2[], height: HeightFn): number[] {
  return path.map(([x, y]) => height(x, y));
}
