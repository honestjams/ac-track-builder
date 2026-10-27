// Browser-side tile fetching: Terrarium elevation tiles for the DEM, and
// aerial imagery tiles composited into one texture per terrain chunk.

import { DemGrid, demTilesFor, type HeightFn } from "../core/elevation";
import { applyColours, matchColours, type ColourTransform } from "../core/colour";
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
  wa: {
    // Landgate's free Locate mosaic. An ImageServer with no tile cache, so each
    // web map tile is asked for by its Web Mercator box ({bbox}).
    label: "Landgate WA (Locate)",
    template: "https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Locate/ImageServer/exportImage"
      + "?bbox={bbox}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&interpolation=RSP_BilinearInterpolation&f=image",
    credit: "Locate mosaic (c) Western Australian Land Information Authority (Landgate), personal use",
    maxZoom: 20,
  },
} as const;

export type ImagerySource = keyof typeof IMAGERY;

const WORLD_M = 40075016.68557849;

/** A web map tile's Web Mercator box as "xmin,ymin,xmax,ymax". */
export function tileBbox(z: number, x: number, y: number): string {
  const size = WORLD_M / 2 ** z;
  const x0 = x * size - WORLD_M / 2, y1 = WORLD_M / 2 - y * size;
  return [x0, y1 - size, x0 + size, y1].map((v) => v.toFixed(3)).join(",");
}

export const tileUrl = (src: ImagerySource, z: number, x: number, y: number) =>
  IMAGERY[src].template
    .replace("{z}", String(z))
    .replace("{y}", String(y))
    .replace("{x}", String(x))
    .replace("{bbox}", () => tileBbox(z, x, y));

/**
 * Sources to try, best first, for a place. The state services are much
 * sharper than Esri in their own state and answer 404 outside it, so a
 * chunk falls back tile by tile.
 */
/** Sources whose colour is matched to Esri's (NSW's mosaic can carry a strong blue cast). */
const BALANCED = new Set<ImagerySource>(["nsw"]);
const balances = new Map<string, Promise<ColourTransform | null>>();

/**
 * Colour transform for one of a source's tiles, matched to Esri's imagery of
 * the same area; null when the source needs none. The cast belongs to the
 * survey a zoom level was built from, so the comparison is made at the zoom
 * in use (Esri's z18 parent, cropped, past z18).
 */
export function colourBalance(source: ImagerySource, z: number, x: number, y: number): Promise<ColourTransform | null> {
  if (!BALANCED.has(source)) return Promise.resolve(null);
  const key = `${source}/${z}/${x},${y}`;
  let p = balances.get(key);
  if (!p) {
    const zr = Math.min(z, 18), up = z - zr;
    p = Promise.all([loadBitmap(tileUrl(source, z, x, y)), loadBitmap(tileUrl("esri", zr, x >> up, y >> up))])
      .then(([a, b]) => {
        if (!a || !b) return null;
        const span = 256 >> up;
        const c = new OffscreenCanvas(span, span).getContext("2d", { willReadFrequently: true })!;
        c.drawImage(b, (x - ((x >> up) << up)) * span, (y - ((y >> up) << up)) * span, span, span, 0, 0, span, span);
        return matchColours(pixels(a), c.getImageData(0, 0, span, span).data);
      })
      .catch(() => null);
    balances.set(key, p);
  }
  return p;
}

export function imageryChain(at: LngLat, pick: "auto" | ImagerySource = "auto"): ImagerySource[] {
  if (pick !== "auto") return pick === "esri" ? ["esri"] : [pick, "esri"];
  const [lng, lat] = at;
  const chain: ImagerySource[] = [];
  if (lat > -29.3 && lat < -9 && lng > 137.9 && lng < 154) chain.push("qld");
  if (lat < -28.1 && lat > -37.6 && lng > 140.9 && lng < 154) chain.push("nsw");
  if (lat < -13.5 && lat > -35.4 && lng > 112.8 && lng < 129.1) chain.push("wa");
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

/** Hosts that keep failing (outage, CORS errors) are given up on for the session, so builds fall back fast. */
const failures = new Map<string, number>();
const GIVE_UP = 6;
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export async function loadBitmap(url: string, attempts = 3): Promise<ImageBitmap | null> {
  const host = hostOf(url);
  if ((failures.get(host) ?? 0) >= GIVE_UP) return null;
  return limited(async () => {
    for (let a = 0; a < attempts; a++) {
      if ((failures.get(host) ?? 0) >= GIVE_UP) return null;
      try {
        const r = await fetch(url, { mode: "cors", signal: AbortSignal.timeout(20000) });
        if (r.status === 404) {
          failures.set(host, 0);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // No colour management: elevation is encoded in the raw RGB values.
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        failures.set(host, 0);
        return bmp;
      } catch (e) {
        failures.set(host, (failures.get(host) ?? 0) + 1);
        if (a === attempts - 1) throw new Error(`Could not load ${url}: ${(e as Error).message}`);
        await new Promise((res) => setTimeout(res, 500 * 2 ** a));
      }
    }
    return null;
  });
}

/** True when a host has been given up on this session. */
export function hostDown(url: string): boolean {
  return (failures.get(hostOf(url)) ?? 0) >= GIVE_UP;
}

function pixels(bitmap: ImageBitmap): Uint8ClampedArray {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/**
 * State bare-earth elevation models, used before the Terrarium tiles where
 * they cover the road: SRTM-based tiles measure the tree tops.
 */
const STATE_DEMS = {
  qld: {
    url: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer/exportImage",
    credit: "Elevation: Queensland Digital Elevation Model (c) State of Queensland; (c) Commonwealth of Australia (Geoscience Australia)",
    label: "Qld",
    // Rough lng/lat box: west, south, east, north.
    box: [137.9, -29.3, 153.7, -9],
  },
  nsw: {
    url: "https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_5M_Elevation/ImageServer/exportImage",
    credit: "Elevation: NSW 5 m elevation (c) Department of Customer Service NSW (Spatial Services)",
    label: "NSW",
    box: [140.9, -37.6, 153.7, -28.1],
  },
  vic: {
    // A tile cache of LERC-compressed heights rather than exportImage.
    url: "https://tiles-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_10m_DEM/ImageServer/tile",
    credit: "Elevation: Vicmap Elevation 10 m DEM (c) State of Victoria (Department of Transport and Planning)",
    label: "Vic",
    box: [140.9, -39.3, 150.1, -33.9],
  },
} as const;
type LercModule = typeof import("lerc");
let lerc: Promise<LercModule> | null = null;

/** The LERC decoder (WebAssembly), loaded the first time a LERC tile is needed. */
function loadLerc(): Promise<LercModule> {
  lerc ??= Promise.all([import("lerc"), import("lerc/lerc-wasm.wasm?url")]).then(async ([mod, wasm]) => {
    await mod.load({ locateFile: () => wasm.default });
    return mod;
  });
  return lerc;
}

/** A 257 x 257 LERC tile of corner samples as 256 x 256 pixel-centre heights. */
async function lercTile(url: string): Promise<Float32Array | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  if (!res.ok) return null;
  const Lerc = await loadLerc();
  const block = Lerc.decode(await res.arrayBuffer());
  const src = block.pixels[0] as ArrayLike<number>, mask = block.mask, w = block.width;
  if (w < 257 || block.height < 257) return null;
  const out = new Float32Array(256 * 256);
  const at = (r: number, c: number) => (mask && !mask[r * w + c] ? NaN : src[r * w + c]);
  for (let r = 0; r < 256; r++) {
    for (let c = 0; c < 256; c++) out[r * 256 + c] = (at(r, c) + at(r, c + 1) + at(r + 1, c) + at(r + 1, c + 1)) / 4;
  }
  return out;
}
export type DemSource = keyof typeof STATE_DEMS;
export const DEM_CREDIT = Object.fromEntries(Object.entries(STATE_DEMS).map(([k, v]) => [k, v.credit])) as Record<DemSource, string>;
export const DEM_LABEL = Object.fromEntries(Object.entries(STATE_DEMS).map(([k, v]) => [k, v.label])) as Record<DemSource, string>;
const WORLD = 40075016.68557849;

/** One 256 x 256 web map tile of a state model's heights, or null where it has none. */
const demFailures = new Map<DemSource, number>();
/** exportImage sources are asked for blocks of up to this many tiles square in one request. */
const BLOCK = 8;

/**
 * Heights from one state model for the tiles listed (null where it has
 * none), keyed "x,y". exportImage models answer a block of up to 8 x 8
 * tiles per request, which matters when a server is slow; a model that
 * keeps failing (an outage) is skipped for the session.
 */
async function stateDemTiles(src: DemSource, z: number, list: { x: number; y: number }[]): Promise<Map<string, Float32Array | null>> {
  const out = new Map<string, Float32Array | null>();
  const jobs: (() => Promise<void>)[] = [];
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if ((demFailures.get(src) ?? 0) >= 4) return undefined;
    try {
      const got = await fn();
      demFailures.set(src, 0);
      return got;
    } catch {
      demFailures.set(src, (demFailures.get(src) ?? 0) + 1);
      return undefined;
    }
  };
  if (src === "vic") {
    // The cache only reliably goes to zoom 15 (the data is 10 m anyway): finer tiles are cut from their zoom 15 parent.
    const zv = Math.min(z, 15), up = z - zv;
    const parents = new Map<string, Promise<Float32Array | null | undefined>>();
    for (const { x, y } of list) {
      jobs.push(async () => {
        const px = x >> up, py = y >> up, pk = `${px},${py}`;
        if (!parents.has(pk)) parents.set(pk, attempt(() => lercTile(`${STATE_DEMS.vic.url}/${zv}/${py}/${px}`)));
        const parent = await parents.get(pk);
        const h = parent ? (up ? upsample(parent, x - (px << up), y - (py << up), up) : parent) : null;
        out.set(`${x},${y}`, h && h.some(usable) ? h : null);
      });
    }
  } else {
    const blocks = new Map<string, { x: number; y: number }[]>();
    for (const t of list) {
      const key = `${Math.floor(t.x / BLOCK)},${Math.floor(t.y / BLOCK)}`;
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key)!.push(t);
    }
    for (const tilesIn of blocks.values()) {
      jobs.push(async () => {
        const xs = tilesIn.map((t) => t.x), ys = tilesIn.map((t) => t.y);
        const tx0 = Math.min(...xs), ty0 = Math.min(...ys), nx = Math.max(...xs) - tx0 + 1, ny = Math.max(...ys) - ty0 + 1;
        const block = await attempt(() => exportBlock(src, z, tx0, ty0, nx, ny));
        const W = nx * 256;
        for (const { x, y } of tilesIn) {
          if (!block) {
            out.set(`${x},${y}`, null);
            continue;
          }
          const h = new Float32Array(256 * 256);
          const ox = (x - tx0) * 256, oy = (y - ty0) * 256;
          for (let r = 0; r < 256; r++) h.set(block.subarray((oy + r) * W + ox, (oy + r) * W + ox + 256), r * 256);
          out.set(`${x},${y}`, h.some(usable) ? h : null);
        }
      });
    }
  }
  // A few requests at a time.
  for (let k = 0; k < jobs.length; k += 4) await Promise.all(jobs.slice(k, k + 4).map((j) => j()));
  return out;
}

/** The (ox, oy) sub-tile, 2^up to a side, of a 256 x 256 tile, resampled (bilinear) to 256 x 256. */
export function upsample(parent: Float32Array, ox: number, oy: number, up: number): Float32Array {
  const out = new Float32Array(256 * 256), span = 256 >> up, k = 1 << up;
  for (let r = 0; r < 256; r++) {
    // Child pixel centre in parent pixel-index space (parent centres at integers).
    const fy = Math.max(0, Math.min(254.999, oy * span + (r + 0.5) / k - 0.5));
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let c = 0; c < 256; c++) {
      const fx = Math.max(0, Math.min(254.999, ox * span + (c + 0.5) / k - 0.5));
      const x0 = Math.floor(fx), tx = fx - x0;
      const i = y0 * 256 + x0;
      const top = parent[i] + (parent[i + 1] - parent[i]) * tx, bot = parent[i + 256] + (parent[i + 257] - parent[i + 256]) * tx;
      out[r * 256 + c] = top + (bot - top) * ty;
    }
  }
  return out;
}

/** One exportImage request for a block of whole tiles: nx x ny tiles from (tx0, ty0), heights row by row from the north. */
async function exportBlock(src: DemSource, z: number, tx0: number, ty0: number, nx: number, ny: number): Promise<Float32Array | null> {
  const size = WORLD / 2 ** z;
  const x0 = tx0 * size - WORLD / 2, y1 = WORLD / 2 - ty0 * size;
  const w = nx * 256, h = ny * 256;
  const url = `${STATE_DEMS[src].url}?bbox=${x0},${y1 - ny * size},${x0 + nx * size},${y1}&bboxSR=3857&imageSR=3857&size=${w},${h}`
    + "&format=bip&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image";
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  // Raw little-endian float32, rows from the north (the server pads the end).
  if (buf.byteLength < w * h * 4) return null;
  return new Float32Array(buf.slice(0, w * h * 4));
}

const usable = (h: number) => Number.isFinite(h) && h > -100 && h < 9000;

/** State models whose rough box takes in the bounds' centre. */
function statesFor(proj: LocalProjection, b: Bounds): DemSource[] {
  const [lng, lat] = proj.toLngLat([(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2]);
  return (Object.keys(STATE_DEMS) as DemSource[]).filter((k) => {
    const [w, so, e, n] = STATE_DEMS[k].box;
    return lng > w && lng < e && lat > so && lat < n;
  });
}

/**
 * Height sampler for the bounds: Terrarium tiles, and where a state
 * bare-earth model covers them, that model (on a 2 m grid by the road,
 * 20 m for the horizon), filled from the next model, then Terrarium, where
 * it has a gap. `used` gets the state models that were used.
 */
export async function loadDem(
  proj: LocalProjection,
  bounds: Bounds,
  zoom: number,
  onTile?: (done: number, total: number) => void,
  used?: Set<DemSource>,
): Promise<HeightFn> {
  const terrarium = await loadTerrarium(proj, bounds, zoom, onTile);
  const states = statesFor(proj, bounds);
  if (!states.length) return terrarium;
  const floor = Math.min(15, zoom);
  let z = zoom >= 14 ? 16 : 13;
  while (z > floor && demTilesFor(proj, bounds, z).length > 200) z--;
  const list = demTilesFor(proj, bounds, z);
  const heights = new Map(list.map(({ x, y }) => [`${x},${y}`, new Float32Array(256 * 256).fill(NaN)]));
  const found = new Set<DemSource>();
  for (const src of states) {
    // Each model fills what the ones before it left.
    const pending = list.filter(({ x, y }) => !heights.get(`${x},${y}`)!.every(usable));
    if (!pending.length) break;
    const got = await stateDemTiles(src, z, pending);
    for (const [key, h] of got) {
      if (!h) continue;
      found.add(src);
      const mine = heights.get(key)!;
      for (let i = 0; i < mine.length; i++) if (!usable(mine[i]) && usable(h[i])) mine[i] = h[i];
    }
  }
  if (!found.size) return terrarium;
  // Whatever's left (outside the states, no data) from Terrarium.
  const tiles = list.map(({ x, y }) => {
    const h = heights.get(`${x},${y}`)!;
    for (let i = 0; i < h.length; i++) {
      if (usable(h[i])) continue;
      const p = proj.pixelToLocal([x * 256 + (i % 256) + 0.5, y * 256 + Math.floor(i / 256) + 0.5], z);
      h[i] = terrarium(p[0], p[1]);
    }
    return { x, y, heights: h };
  });
  for (const src of found) used?.add(src);
  return DemGrid.fromHeights(proj, z, tiles).sample;
}

/** Height sampler for the bounds, from Terrarium tiles. */
async function loadTerrarium(
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
  const here = new Set<ImagerySource>();
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
          here.add(source);
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
  const rgba = ctx.getImageData(0, 0, size, size).data;
  // Even out a source's colour cast, by the transform for the chunk's middle.
  for (const source of here) {
    const z = Math.min(IMAGERY[source].maxZoom, zoom);
    const [gx, gy] = proj.localToPixel([(chunk.minX + chunk.maxX) / 2, (chunk.minY + chunk.maxY) / 2], z);
    const t = await colourBalance(source, z, Math.floor(gx / 256), Math.floor(gy / 256));
    if (t) {
      applyColours(rgba, t);
      ctx.putImageData(new ImageData(rgba, size, size), 0, 0);
      break;
    }
  }
  previews.set(chunk.key, canvas);
  return { data: encodeDdsDxt1(rgba, size, size), ext: "dds", rgba };
}
