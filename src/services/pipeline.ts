// The whole build, from fetching the map data to the finished track files.
// No DOM: it runs in the build worker (buildWorker.ts) so the page stays
// responsive, or on the page itself where workers can't draw (no
// OffscreenCanvas).

import type { LngLat } from "../core/geo";
import type { BuildOptions } from "../core/options";
import type { RoundaboutHint } from "../core/roundabout";
import { buildTrack, type TrackResult } from "../core/track";
import { renderArt } from "./art";
import { fetchSeen } from "./mapillary";
import { fetchOsm, widthLookup } from "./osm";
import { loadRouteRaster } from "./raster";
import { DEM_CREDIT, IMAGERY, imageryChain, loadChunkImagery, loadDem, type DemSource, type ImagerySource } from "./tiles";
import { classWidths, fetchTileFeatures, roadClassLookup } from "./vectorTiles";

export interface BuildJob {
  coords: LngLat[];
  roundabouts: RoundaboutHint[];
  opts: Partial<BuildOptions>;
  /** Mapillary client token, or "" for none. */
  token: string;
  imagerySource: ImagerySource | "auto";
  placeMeta: { country?: string; city?: string };
}

export interface BuildOutcome {
  result: TrackResult;
  /** The terrain photos as drawn, for the 3D preview. */
  chunkImages: Map<string, OffscreenCanvas>;
  usedImagery: ImagerySource[];
  usedDem: DemSource[];
  /** No width data: the road is the default width. */
  widthFallback: boolean;
  seen: number;
  seenError: string;
}

export type Report = (stage: string, fraction?: number) => Promise<void>;

export async function runBuild(job: BuildJob, report: Report, traceProgress: (text: string) => void): Promise<BuildOutcome> {
  const { coords, opts, token } = job;
  const chunkImages = new Map<string, OffscreenCanvas>();
  const usedImagery = new Set<ImagerySource>();
  const usedDem = new Set<DemSource>();
  const chain = imageryChain(coords[Math.floor(coords.length / 2)], job.imagerySource);

  await report("Fetching OpenStreetMap data");
  let seenError = "";
  const [osm, tiles, seen] = await Promise.all([
    fetchOsm(coords),
    fetchTileFeatures(paddedBounds(coords, (opts.buildingRadius ?? 250) + 50)).catch(() => null),
    token
      ? fetchSeen(paddedBounds(coords, (opts.corridor ?? 90) + 20), token).catch((e) => {
        seenError = (e as Error).message;
        return [];
      })
      : Promise.resolve([]),
  ]);
  if (tiles) osm.features.buildings = tiles.buildings;
  // Overpass widths when it answered; otherwise widths by road class from the tiles.
  const tileWidths = tiles ? classWidths(tiles.roads) : [];
  const widthAt = opts.widthOverride
    ? undefined
    : osm.widthAt ?? (tileWidths.length ? widthLookup(tileWidths, coords[0][1]) : undefined);
  const result = await buildTrack(coords, opts, {
    dem: (proj, bounds, z) => loadDem(proj, bounds, z, undefined, usedDem),
    imagery: opts.imageryZoom ? (proj, chunk, z, size) => loadChunkImagery(proj, chunk, z, size, chunkImages, chain, usedImagery) : undefined,
    widthAt,
    osm: osm.features,
    roundabouts: job.roundabouts,
    streets: tiles ? { lines: tiles.roads, names: tiles.names } : undefined,
    pois: tiles?.pois,
    seen,
    renderArt,
    raster: (proj, path, reach) => loadRouteRaster(proj, path, reach, chain, 20, (d, t) => traceProgress(`Tracing the road in the aerial photos (${Math.round((d / t) * 100)}%)`)),
    roadClassAt: tiles ? roadClassLookup(tiles.roads, coords[0][1]) : undefined,
    imageryCredit: () => [...[...usedImagery].map((k) => IMAGERY[k].credit), ...[...usedDem].map((k) => DEM_CREDIT[k])].join("; "),
  }, job.placeMeta, report);
  return {
    result,
    chunkImages,
    usedImagery: [...usedImagery],
    usedDem: [...usedDem],
    widthFallback: !widthAt && !opts.widthOverride,
    seen: seen.length,
    seenError,
  };
}

/** [west, south, east, north] around the route, padded by `metres`. */
function paddedBounds(coords: LngLat[], metres: number): [number, number, number, number] {
  const lats = coords.map((p) => p[1]), lngs = coords.map((p) => p[0]);
  const dLat = metres / 111320, dLng = metres / (111320 * Math.cos((lats[0] * Math.PI) / 180));
  return [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat];
}
