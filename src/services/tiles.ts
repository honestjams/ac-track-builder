// Browser-side tile fetching: Terrarium elevation tiles for the DEM, and
// aerial imagery tiles composited into one texture per terrain chunk.

import { DemGrid, demTilesFor, type HeightFn } from "../core/elevation";
import { encodeDdsDxt1 } from "../core/dds";
import { tilesCovering, type Bounds, type LocalProjection } from "../core/geo";
import type { TerrainChunk } from "../core/terrain";

export const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const IMAGERY = {
  esri: {
    label: "Esri World Imagery",
    template: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    url: (z: number, x: number, y: number) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    credit: "Esri World Imagery (Esri, Maxar, Earthstar Geographics, and the GIS User Community)",
    maxZoom: 19,
  },
} as const;

const MAX_PARALLEL = 6;
let active = 0;
const queue: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function loadBitmap(url: string, attempts = 3): Promise<ImageBitmap | null> {
  return limited(async () => {
    for (let a = 0; a < attempts; a++) {
      try {
        const r = await fetch(url, { mode: "cors" });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // No colour management: elevation is encoded in the raw RGB values.
        return await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      } catch (e) {
        if (a === attempts - 1) throw new Error(`Could not load ${url}: ${(e as Error).message}`);
        await new Promise((res) => setTimeout(res, 500 * 2 ** a));
      }
    }
    return null;
  });
}

function pixels(bitmap: ImageBitmap): Uint8ClampedArray {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/** Height sampler for the bounds, from Terrarium tiles. */
export async function loadDem(
  proj: LocalProjection,
  bounds: Bounds,
  zoom: number,
  onTile?: (done: number, total: number) => void,
): Promise<HeightFn> {
  let z = Math.min(15, zoom);
  // Keep very long roads to a sane download.
  while (z > 10 && demTilesFor(proj, bounds, z).length > 300) z--;
  const list = demTilesFor(proj, bounds, z);
  let done = 0;
  const tiles = await Promise.all(
    list.map(async ({ x, y }) => {
      const bmp = await loadBitmap(TERRARIUM_URL(z, x, y));
      onTile?.(++done, list.length);
      // Missing tiles are ocean: sea level.
      const rgba = bmp ? pixels(bmp) : new Uint8ClampedArray(256 * 256 * 4).fill(128);
      return { x, y, rgba };
    }),
  );
  return DemGrid.fromTiles(proj, z, tiles).sample;
}

/**
 * One aerial texture for a terrain chunk: the tiles under the chunk's square
 * drawn into a `size` x `size` canvas (north up), DXT1-compressed. The canvas
 * is kept in `previews` for the 3D preview.
 */
export async function loadChunkImagery(
  proj: LocalProjection,
  chunk: TerrainChunk,
  zoom: number,
  size: number,
  previews: Map<string, OffscreenCanvas>,
  source: keyof typeof IMAGERY = "esri",
): Promise<{ data: Uint8Array; ext: "dds" } | null> {
  const src = IMAGERY[source];
  const z = Math.min(src.maxZoom, zoom);
  const p0 = proj.localToPixel([chunk.minX, chunk.maxY], z);
  const p1 = proj.localToPixel([chunk.maxX, chunk.minY], z);
  const scale = size / (p1[0] - p0[0]);
  const range = tilesCovering(proj, { minX: chunk.minX, minY: chunk.minY, maxX: chunk.maxX, maxY: chunk.maxY }, z);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#56603f";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = "high";
  const jobs: Promise<void>[] = [];
  let any = false;
  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) {
      jobs.push(
        loadBitmap(src.url(z, tx, ty)).then((bmp) => {
          if (!bmp) return;
          any = true;
          // +0.5 px overlap hides hairline seams between tiles.
          ctx.drawImage(bmp, (tx * 256 - p0[0]) * scale, (ty * 256 - p0[1]) * scale, 256 * scale + 0.5, 256 * scale + 0.5);
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (!any) return null;
  previews.set(chunk.key, canvas);
  const rgba = ctx.getImageData(0, 0, size, size).data;
  return { data: encodeDdsDxt1(rgba, size, size), ext: "dds" };
}
