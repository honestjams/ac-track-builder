// A colour sampler over the aerial imagery along the route, at the sharpest
// zoom the source has, for tracing the road and texturing it. Only the tiles
// within reach of the route are downloaded.

import { lngLatToPixel, type LocalProjection, type Vec2 } from "../core/geo";
import type { RasterSampler } from "../core/trace";
import { IMAGERY, loadBitmap, tileUrl, type ImagerySource } from "./tiles";

export async function loadRouteRaster(
  proj: LocalProjection,
  path: Vec2[],
  reach: number,
  chain: ImagerySource[],
  maxZoom = 20,
  onProgress?: (done: number, total: number) => void,
): Promise<RasterSampler | null> {
  const z = Math.min(maxZoom, IMAGERY[chain[0]].maxZoom);
  const mpp = proj.metresPerPixel(z);
  // Tiles within `reach` of any point along the path (sampled every 5 m).
  const need = new Set<string>();
  const r = reach / mpp;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[Math.min(path.length - 1, i + 1)];
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
    for (let k = 0; k < steps; k++) {
      const p: Vec2 = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
      const [gx, gy] = proj.localToPixel(p, z);
      for (let tx = Math.floor((gx - r) / 256); tx <= Math.floor((gx + r) / 256); tx++) {
        for (let ty = Math.floor((gy - r) / 256); ty <= Math.floor((gy + r) / 256); ty++) need.add(tx + "," + ty);
      }
    }
  }
  if (need.size > 4000) return null; // very long routes: skip tracing rather than exhaust memory
  const tiles = new Map<string, Uint8ClampedArray>();
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let done = 0;
  await Promise.all([...need].map(async (key) => {
    const [tx, ty] = key.split(",").map(Number);
    for (const src of chain) {
      const sz = Math.min(z, IMAGERY[src].maxZoom);
      const up = z - sz; // fall back to a coarser parent tile, scaled up
      const bmp = await loadBitmap(tileUrl(src, sz, tx >> up, ty >> up)).catch(() => null);
      if (!bmp) continue;
      const span = 256 >> up;
      const sx = (tx - ((tx >> up) << up)) * span, sy = (ty - ((ty >> up) << up)) * span;
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(bmp, sx, sy, span, span, 0, 0, 256, 256);
      tiles.set(key, ctx.getImageData(0, 0, 256, 256).data);
      break;
    }
    onProgress?.(++done, need.size);
  }));
  if (!tiles.size) return null;

  const origin = lngLatToPixel(proj.origin, z);
  const at = (gx: number, gy: number): number[] | null => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(tx + "," + ty);
    if (!t) return null;
    const i = ((Math.floor(gy) - ty * 256) * 256 + (Math.floor(gx) - tx * 256)) * 4;
    return [t[i], t[i + 1], t[i + 2]];
  };
  return (x, y) => {
    // Bilinear between the four nearest pixel centres.
    const gx = origin[0] + x / mpp - 0.5, gy = origin[1] - y / mpp - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    if (!a || !b || !c || !d) return null;
    const out: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      out[k] = ((a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy) / 255;
    }
    return out;
  };
}
