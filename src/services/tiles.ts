// Browser-side tile fetching: Terrarium elevation tiles for the DEM, and
// aerial imagery tiles composited into one texture per terrain chunk.

import { DemGrid, demTilesFor, type HeightFn } from "../core/elevation";
import { encodeDdsDxt1 } from "../core/dds";
import { tilesCovering, type Bounds, type LngLat, type LocalProjection } from "../core/geo";
import type { TerrainChunk } from "../core/terrain";

export const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export const IMAGERY = {
  esri: {
    label: "Esri World Imagery",
    template: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Esri World Imagery (Esri, Maxar, Earthstar Geographics, and the GIS User Community)",
    maxZoom: 19,
  },
  qld: {
    label: "Queensland Government",
    template: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}",
    credit: "State of Queensland aerial imagery (latest public State Program; includes material (c) Planet Labs)",
    maxZoom: 20,
  },
  nsw: {
    label: "NSW Government",
    template: "https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "NSW Spatial Services imagery ((c) Department of Customer Service NSW)",
    maxZoom: 21,
  },
} as const;

export type ImagerySource = keyof typeof IMAGERY;

const tileUrl = (src: ImagerySource, z: number, x: number, y: number) =>
  IMAGERY[src].template.replace("{z}", String(z)).replace("{y}", String(y)).replace("{x}", String(x));

/**
 * Sources to try, best first, for a place. The state services are much
 * sharper than Esri in their own state and answer 404 outside it, so a
 * chunk falls back tile by tile.
 */
export function imageryChain(at: LngLat, pick: "auto" | ImagerySource = "auto"): ImagerySource[] {
  if (pick !== "auto") return pick === "esri" ? ["esri"] : [pick, "esri"];
  const [lng, lat] = at;
  const chain: ImagerySource[] = [];
  if (lat > -29.3 && lat < -9 && lng > 137.9 && lng < 154) chain.push("qld");
  if (lat < -28.1 && lat > -37.6 && lng > 140.9 && lng < 154) chain.push("nsw");
  return [...chain, "esri"];
}

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
  chain: ImagerySource[] = ["esri"],
  used?: Set<ImagerySource>,
): Promise<{ data: Uint8Array; ext: "dds"; rgba: Uint8ClampedArray } | null> {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  let any = false;
  for (const [k, source] of chain.entries()) {
    const z = Math.min(IMAGERY[source].maxZoom, zoom);
    const p0 = proj.localToPixel([chunk.minX, chunk.maxY], z);
    const p1 = proj.localToPixel([chunk.maxX, chunk.minY], z);
    const scale = size / (p1[0] - p0[0]);
    const range = tilesCovering(proj, { minX: chunk.minX, minY: chunk.minY, maxX: chunk.maxX, maxY: chunk.maxY }, z);
    // Later sources only fill what earlier ones left empty.
    ctx.globalCompositeOperation = k === 0 ? "source-over" : "destination-over";
    let missing = false;
    const jobs: Promise<void>[] = [];
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        jobs.push(loadBitmap(tileUrl(source, z, tx, ty)).catch(() => null).then((bmp) => {
          if (!bmp) {
            missing = true;
            return;
          }
          any = true;
          used?.add(source);
          // +0.5 px overlap hides hairline seams between tiles.
          ctx.drawImage(bmp, (tx * 256 - p0[0]) * scale, (ty * 256 - p0[1]) * scale, 256 * scale + 0.5, 256 * scale + 0.5);
        }));
      }
    }
    await Promise.all(jobs);
    if (!missing) break;
  }
  if (!any) return null;
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#56603f";
  ctx.fillRect(0, 0, size, size);
  previews.set(chunk.key, canvas);
  const rgba = ctx.getImageData(0, 0, size, size).data;
  return { data: encodeDdsDxt1(rgba, size, size), ext: "dds", rgba };
}
