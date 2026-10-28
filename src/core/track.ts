// The whole build: route in, track folder out. Network access is injected
// through `DataSources`, so the same pipeline runs in the browser (real
// tiles) and in Node tests (synthetic terrain).

import { buildAiLine } from "./aiLine";
import { BACKDROP_CHUNK, backdropHeight, buildBackdropChunk, planBackdrop } from "./backdrop";
import { writeFastLaneAi } from "./aiSpline";
import { outlinePng, previewPng, readme, slugify, surfacesIni, trackMap, uiTrackJson, type TrackMeta } from "./acFiles";
import type { HeightFn } from "./elevation";
import { boundsOf, LocalProjection, type Bounds, type LngLat, type Vec2 } from "./geo";
import { frameTransform, IDENTITY, writeKn5, type Kn5GroupNode, type Kn5Material, type Kn5MeshNode, type Kn5Model, type Kn5Node, type Kn5Texture } from "./kn5";
import { toAc } from "./mesh";
import { withDefaults, type BuildOptions } from "./options";
import { simplify } from "./polyline";
import { applyElevation, inRoundabout, isLoop, planRoad, surfaceHeight, SegmentIndex, type RoadPlan, type RoadSample } from "./road";
import { extendRoute, pathLength } from "./extend";
import { keepOffRoute, onRoute } from "./clearance";
import { buildRingMeshes, buildRingWall, innerRadius, outerRadius, resolveRoundabouts, ringHeight, type RoundaboutHint } from "./roundabout";
import { buildRoadMeshes, buildWalls, type RoadMaterialFn } from "./roadMesh";
import { buildKerbReturns, buildKerbs, KERB_BACK, kerbEvidence, planKerbs, STRIP_EXTRA, stripPhotoTexture, type StripMaterialFn } from "./kerbs";
import { photoRoadTexture } from "./photoSurface";
import { encodeDdsDxt1 } from "./dds";
import { buildMarkings, type DiscreteMark } from "./markings";
import { buildTerrainChunk, makeTerrainFn, planTerrainChunks, type TerrainChunk } from "./terrain";
import { FACADES, paintTexture, sealTexture, type SealKind, facadeTexture, grassTexture, concreteTexture, postTexture, railTexture, ROOF_COLOURS, roofTexture, solidTexture, treeAtlas, vergeTexture } from "./textures";
import {
  buildGuardRails, buildGuidePosts, buildTrees, filterTrees, railNeeds, treeSpotsFromImagery, type TreeSpot,
} from "./scenery";
import { buildBuildings, centroid, detectBuildings, filterBuildings, fromOsm, pointInRing, type Building } from "./buildings";
import { camerasIni, placeCameras } from "./cameras";
import { cullable } from "./cull";
import { chunkPhotoSampler, frontageHouses } from "./frontage";
import { ArtList, type ArtRenderer } from "./art";
import { buildPieces, gateSigns, landmarks, mergeSightings, seenFeatures, streetSigns } from "./furniture";
import { placeUtilities } from "./utilities";
import { findLines, paintCandidates, type ImageLine } from "./paintLines";
import { applyTrace, displayOf, traceRoad, type RasterSampler, type TraceResult } from "./trace";
import { buildSideStreets, LineIndex, traceSideStreets, planSideStreets, streetSurface, type StreetLine, type StreetName } from "./sideStreets";

/** Progress callback; a returned promise is awaited, which lets a UI repaint. */
export type Progress = (stage: string, fraction?: number) => void | Promise<void>;

export interface DataSources {
  /** Height sampler (local metres) covering `bounds`. */
  dem(proj: LocalProjection, bounds: Bounds, zoom: number): Promise<HeightFn>;
  /**
   * Image bytes (PNG, JPEG or DDS) covering the chunk square, north up; null
   * to fall back to grass. `rgba` (size x size) lets the build find trees.
   */
  imagery?(proj: LocalProjection, chunk: TerrainChunk, zoom: number, size: number): Promise<{
    data: Uint8Array;
    ext: "png" | "jpg" | "dds";
    rgba?: Uint8Array | Uint8ClampedArray;
  } | null>;
  /** OSM features near the road, already fetched. */
  osm?: OsmFeatures;
  /** Other streets near the route and their names (vector tiles). */
  streets?: { lines: StreetLine[]; names: StreetName[] };
  /** Points of interest near the route (vector tiles). */
  pois?: { at: LngLat; cls: string; subclass: string; name?: string }[];
  /** Objects located by street-level imagery (Mapillary map features). */
  seen?: { at: LngLat; value: string }[];
  /** Draws the sign artwork atlas; without one, signs are left out. */
  renderArt?: ArtRenderer;
  /** Sharpest aerial imagery within `reach` metres of the path, for tracing the road. */
  raster?(proj: LocalProjection, path: Vec2[], reach: number): Promise<RasterSampler | null>;
  /** Roundabouts the router says the route goes round. */
  roundabouts?: RoundaboutHint[];
  /** Road class at a point (OpenMapTiles: motorway, primary, minor, ...). */
  roadClassAt?(p: LngLat): string | undefined;
  /** Asphalt width at a point from map data, metres. */
  widthAt?(p: LngLat): number | undefined;
  /** Credit line for the imagery source(s), written into the README; read after imagery is fetched. */
  imageryCredit?: string | (() => string);
}

export interface OsmFeatures {
  /** Footprints (first point not repeated) with OSM / vector tile tags. */
  buildings: { ring: LngLat[]; tags: Record<string, string> }[];
  guardRails: LngLat[][];
  /** OSM junction=roundabout ways near the route. */
  roundaboutRings?: LngLat[][];
  /** Power poles, street lamps and distribution power lines (on poles) near the route. */
  poles?: LngLat[];
  lamps?: LngLat[];
  powerLines?: LngLat[][];
}

export interface TrackResult {
  slug: string;
  files: Record<string, Uint8Array>;
  model: Kn5Model;
  plan: RoadPlan;
  proj: LocalProjection;
  /** Where side streets meet the route (distance along it, side 1 = left). */
  junctions: { s: number; side: 1 | -1 }[];
  /** Raw pixels for textures the browser can't decode (DDS), keyed by texture name. */
  previewTextures: Record<string, { rgba: Uint8Array; width: number; height: number }>;
  stats: {
    length: number;
    /** Between the start and finish lines (the whole road on a loop). */
    timedLength: number;
    closed: boolean;
    minElevation: number;
    maxElevation: number;
    climb: number;
    meanWidth: number;
    vertices: number;
    triangles: number;
    terrainChunks: number;
    kn5Bytes: number;
    trees: number;
    buildings: number;
    buildingsDetected: number;
    /** Fraction of the route traced from the aerial photos. */
    traced: number;
    /** Line markings read off the photo. */
    photoLines: number;
    /** Road chunks textured from the aerial photo. */
    photoChunks: number;
    sideStreets: number;
    /** Side streets traced from the photo. */
    sideTraced: number;
    /** Kerb and gutter built, metres (both sides counted). */
    kerbMetres: number;
    /** Power poles and street lights placed. */
    poles: number;
    streetLights: number;
    streetSigns: number;
    signs: number;
    railMetres: number;
  };
}

const enc = new TextEncoder();
const MIN_LENGTH = 300;
/** Clear road between the front row of the grid and the start line, and before the back row. */
const GRID_DEPTH = 14;

/**
 * The sample at a pin: nearest to it among those about `frac` of the way
 * along the road (smoothing shortens the road a little, so distances along
 * the original path only say roughly where to look; on a road that passes
 * the same spot twice, this keeps to the right pass).
 */
function sampleNearPin(plan: RoadPlan, pin: Vec2, frac: number): number {
  const last = plan.samples[plan.samples.length - 1].s;
  const est = frac * last, window = Math.max(60, last * 0.05);
  let best = -1, bestD = Infinity;
  for (const pass of [window, Infinity]) {
    plan.samples.forEach((s, i) => {
      if (Math.abs(s.s - est) > pass) return;
      const d = Math.hypot(s.pos[0] - pin[0], s.pos[1] - pin[1]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) break;
  }
  return Math.max(0, best);
}

/** Point on the road at distance s (wrapping on loops), lateral offset t, and its heading. */
function along(plan: RoadPlan, s: number, t: number, lift: number, crown: number) {
  const n = plan.samples.length;
  const L = plan.length;
  if (plan.closed) s = ((s % L) + L) % L;
  else s = Math.max(0, Math.min(plan.samples[n - 1].s, s));
  let i = Math.min(n - 1, Math.floor(s / (L / (plan.closed ? n : n - 1))));
  while (i > 0 && plan.samples[i].s > s) i--;
  while (i < n - 1 && plan.samples[i + 1].s <= s) i++;
  const a: RoadSample = plan.samples[i];
  const z = surfaceHeight(a, t, crown) + lift;
  const pos = toAc(a.pos[0] + a.left[0] * t, a.pos[1] + a.left[1] * t, z);
  const fwd = toAc(a.tan[0], a.tan[1], 0);
  return { pos, fwd, sample: a };
}

function dummy(name: string, transform: number[]): Kn5GroupNode {
  return { kind: "node", name, transform, children: [] };
}

/** Spawn points and timing gates. */
function trackObjects(plan: RoadPlan, opts: BuildOptions): Kn5GroupNode[] {
  const out: Kn5GroupNode[] = [];
  const width = plan.samples[0].width;
  const rows = Math.ceil(opts.pitCount / 2);
  const slot = (k: number, lineS: number) => {
    const row = Math.floor(k / 2);
    const t = (k % 2 === 0 ? 1 : -1) * width / 4;
    return { s: lineS - 8 - row * 8, t };
  };
  const place = (name: string, s: number, t: number, lift: number) => {
    const p = along(plan, s, t, lift, opts.crown);
    // The game takes a dummy's -Z as the way the car faces (with +Z, cars
    // spawned facing back down the road), so Z points back along the road.
    out.push(dummy(name, frameTransform(p.pos, [-p.fwd[0], -p.fwd[1], -p.fwd[2]])));
  };

  if (plan.closed) {
    const line = 0;
    for (let k = 0; k < opts.pitCount; k++) {
      const { s, t } = slot(k, line);
      place(`AC_START_${k}`, s, t, 0.5);
      place(`AC_PIT_${k}`, s, t, 0.5);
    }
    place("AC_HOTLAP_START_0", plan.length - 150, 0, 0.5);
    const half = width / 2 + 1;
    place("AC_TIME_0_L", line, half, 1);
    place("AC_TIME_0_R", line, -half, 1);
  } else {
    // Start and finish lines on the pins when there's a run-up and run-off; otherwise just inside the ends.
    const end = plan.samples[plan.samples.length - 1].s;
    const startLine = plan.timed ? Math.max(GRID_DEPTH + rows * 8, plan.samples[plan.timed.start].s) : GRID_DEPTH + rows * 8;
    for (let k = 0; k < opts.pitCount; k++) {
      const { s, t } = slot(k, startLine);
      place(`AC_START_${k}`, s, t, 0.5);
      place(`AC_PIT_${k}`, s, t, 0.5);
    }
    place("AC_HOTLAP_START_0", 4, 0, 0.5);
    const startHalf = along(plan, startLine, 0, 0, 0).sample.width / 2 + 1;
    place("AC_AB_START_L", startLine, startHalf, 1);
    place("AC_AB_START_R", startLine, -startHalf, 1);
    const finish = plan.timed ? Math.min(end - 25, plan.samples[plan.timed.finish].s) : end - 25;
    const finishHalf = along(plan, finish, 0, 0, 0).sample.width / 2 + 1;
    place("AC_AB_FINISH_L", finish, finishHalf, 1);
    place("AC_AB_FINISH_R", finish, -finishHalf, 1);
  }
  return out;
}

function material(name: string, texture: string, light: { ambient: number; diffuse: number; specular: number; exp: number }): Kn5Material {
  return {
    name,
    shader: "ksPerPixel",
    properties: [
      { name: "ksAmbient", a: light.ambient },
      { name: "ksDiffuse", a: light.diffuse },
      { name: "ksSpecular", a: light.specular },
      { name: "ksSpecularEXP", a: light.exp },
      { name: "ksEmissive", c: [0, 0, 0] },
      { name: "ksAlphaRef", a: 0 },
    ],
    textures: { txDiffuse: texture },
  };
}

function countGeometry(node: Kn5Node): { v: number; t: number } {
  if (node.kind === "mesh") return { v: node.positions.length / 3, t: node.indices.length / 3 };
  return node.children.map(countGeometry).reduce((a, b) => ({ v: a.v + b.v, t: a.t + b.t }), { v: 0, t: 0 });
}

export async function buildTrack(
  route: LngLat[],
  partial: Partial<BuildOptions>,
  sources: DataSources,
  meta: Partial<TrackMeta> = {},
  progress: Progress = () => {},
): Promise<TrackResult> {
  const opts = withDefaults(partial);
  if (route.length < 2) throw new Error("Pick a start and a finish on the map first");

  await progress("Laying out the road");
  const lngs = route.map((p) => p[0]), lats = route.map((p) => p[1]);
  const centre: LngLat = [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
  const proj = new LocalProjection(centre);
  const local = route.map((p) => proj.toLocal(p));
  const widthFn = sources.widthAt ? (x: number, y: number) => sources.widthAt!(proj.toLngLat([x, y])) : undefined;
  const circles = resolveRoundabouts(sources.roundabouts ?? [], sources.osm?.roundaboutRings ?? [], proj);
  // Point to point: room to line up and get going before the start pin, and to brake after the finish pin.
  const rows = Math.ceil(opts.pitCount / 2);
  const ext = !isLoop(local) && (opts.runUp > 0 || opts.runOff > 0)
    ? extendRoute(local, (sources.streets?.lines ?? []).map((l) => l.pts.map((p) => proj.toLocal(p))), GRID_DEPTH + rows * 8 + opts.runUp, opts.runOff)
    : null;
  const plan = planRoad(ext?.path ?? local, opts, widthFn, circles);
  if (ext) {
    const total = pathLength(ext.path);
    plan.timed = { start: sampleNearPin(plan, local[0], ext.startAt / total), finish: sampleNearPin(plan, local[local.length - 1], ext.finishAt / total) };
  }
  const timedLength = () => (plan.timed ? plan.samples[plan.timed.finish].s - plan.samples[plan.timed.start].s : plan.length);
  if (timedLength() < MIN_LENGTH) throw new Error(`Road is ${Math.round(timedLength())} m; make it at least ${MIN_LENGTH} m`);

  // Put the road where the aerial photos show it, at the width they show.
  let raster: RasterSampler | null = null;
  let trace: TraceResult | null = null;
  if (opts.traceRoads && sources.raster) {
    await progress("Tracing the road in the aerial photos");
    const reach = Math.max(16, Math.max(...plan.samples.map((s) => s.width)) * 1.5);
    raster = await sources.raster(proj, plan.samples.map((s) => s.pos), reach);
    if (raster) {
      trace = traceRoad(plan, raster);
      if (opts.noTrace.length) {
        const zones = opts.noTrace.map((z) => ({ c: proj.toLocal(z.at), r: z.radius }));
        plan.samples.forEach((smp, i) => {
          // 1 inside a zone, fading to 0 over 30 m outside it.
          const keep = Math.min(1, ...zones.map((z) => Math.max(0, Math.min(1, (Math.hypot(smp.pos[0] - z.c[0], smp.pos[1] - z.c[1]) - z.r) / 30))));
          trace!.offset[i] *= keep;
          trace!.conf[i] *= keep;
        });
      }
      applyTrace(plan, trace, (i) => !!inRoundabout(plan, plan.samples[i].pos[0], plan.samples[i].pos[1], 0.5));
    }
  }

  await progress("Fetching elevation");
  const bounds = boundsOf(plan.samples.map((s) => s.pos), opts.corridor + opts.terrainBlend + 60);
  const dem = await sources.dem(proj, bounds, opts.demZoom);
  // The horizon only needs coarse heights; a separate low-zoom DEM keeps the download small.
  const farBounds = boundsOf(plan.samples.map((s) => s.pos), opts.horizon + BACKDROP_CHUNK);
  const farDem = opts.horizon > 0 ? await sources.dem(proj, farBounds, Math.min(opts.demZoom, 12)) : dem;
  applyElevation(plan, dem, opts);
  const index = new SegmentIndex(plan);
  const terrainAt = makeTerrainFn(plan, index, dem, opts);

  const chunks = planTerrainChunks(plan, index, opts);
  const backdrop = planBackdrop(plan, index, opts);
  const textures: Kn5Texture[] = [
    { name: "verge.png", data: vergeTexture() },
    { name: "grass.png", data: grassTexture() },
    { name: "wall.png", data: solidTexture([128, 128, 128]) },
  ];
  const materials: Kn5Material[] = [
    material("verge", "verge.png", { ambient: 0.45, diffuse: 0.4, specular: 0, exp: 1 }),
    material("grass", "grass.png", { ambient: 0.45, diffuse: 0.4, specular: 0, exp: 1 }),
    material("wall", "wall.png", { ambient: 0.4, diffuse: 0.4, specular: 0, exp: 1 }),
  ];
  const addScenery = (tex: string, data: Uint8Array, mat: Kn5Material) => {
    textures.push({ name: tex, data });
    materials.push(mat);
  };
  addScenery("trees.png", treeAtlas(), {
    ...material("trees", "trees.png", { ambient: 0.55, diffuse: 0.35, specular: 0, exp: 1 }),
    shader: "ksPerPixelAT",
    alphaTested: true,
  });
  addScenery("paint.png", paintTexture(), material("paint", "paint.png", { ambient: 0.5, diffuse: 0.5, specular: 0.1, exp: 15 }));
  addScenery("paint_yellow.png", solidTexture([226, 182, 32]), material("paint_yellow", "paint_yellow.png", { ambient: 0.5, diffuse: 0.5, specular: 0.1, exp: 15 }));
  addScenery("rrpm.png", solidTexture([238, 238, 232]), material("rrpm", "rrpm.png", { ambient: 0.6, diffuse: 0.5, specular: 0.6, exp: 40 }));
  addScenery("timber.png", solidTexture([92, 74, 58]), material("timber", "timber.png", { ambient: 0.45, diffuse: 0.45, specular: 0, exp: 1 }));
  addScenery("glass.png", solidTexture([120, 140, 150]), material("glass", "glass.png", { ambient: 0.4, diffuse: 0.3, specular: 0.6, exp: 60 }));
  addScenery("canopy.png", solidTexture([236, 236, 232]), material("canopy", "canopy.png", { ambient: 0.5, diffuse: 0.45, specular: 0.1, exp: 10 }));
  addScenery("lamp.png", solidTexture([150, 152, 150]), material("lamp", "lamp.png", { ambient: 0.45, diffuse: 0.45, specular: 0.3, exp: 30 }));
  addScenery("signal.png", solidTexture([28, 30, 26]), material("signal", "signal.png", { ambient: 0.4, diffuse: 0.4, specular: 0.2, exp: 20 }));
  addScenery("rail.png", railTexture(), material("rail", "rail.png", { ambient: 0.4, diffuse: 0.45, specular: 0.3, exp: 30 }));
  addScenery("wire.png", solidTexture([38, 38, 40]), material("wire", "wire.png", { ambient: 0.35, diffuse: 0.35, specular: 0.2, exp: 20 }));
  addScenery("steel.png", solidTexture([120, 122, 126]), material("steel", "steel.png", { ambient: 0.4, diffuse: 0.45, specular: 0.2, exp: 20 }));
  addScenery("concrete.png", concreteTexture(), material("concrete", "concrete.png", { ambient: 0.45, diffuse: 0.45, specular: 0.05, exp: 10 }));
  addScenery("guidepost.png", postTexture(), material("guidepost", "guidepost.png", { ambient: 0.45, diffuse: 0.45, specular: 0.1, exp: 10 }));
  for (const f of FACADES) {
    addScenery(`facade_${f}.png`, facadeTexture(f), material(`facade_${f}`, `facade_${f}.png`, { ambient: 0.45, diffuse: 0.45, specular: 0.05, exp: 10 }));
  }
  for (const c of ROOF_COLOURS) {
    addScenery(`roof_${c.name}.png`, roofTexture(c), material(`roof_${c.name}`, `roof_${c.name}.png`, { ambient: 0.45, diffuse: 0.45, specular: c.tile ? 0.05 : 0.25, exp: 25 }));
  }
  const detected: Building[] = [];
  const treeSpots: TreeSpot[] = [];
  const photos: Parameters<typeof chunkPhotoSampler>[0] = [];

  const textured = new Set<string>();
  if (sources.imagery && opts.imageryZoom > 0) {
    const jobs = [
      ...chunks.map((c) => ({ chunk: c, zoom: opts.imageryZoom, size: opts.textureSize, prefix: "terrain" })),
      ...backdrop.map((c) => ({ chunk: c, zoom: opts.horizonZoom, size: 512, prefix: "backdrop" })),
    ];
    for (const [done, job] of jobs.entries()) {
      await progress("Fetching aerial imagery", done / jobs.length);
      const img = await sources.imagery(proj, job.chunk, job.zoom, job.size);
      if (!img) continue;
      const tex = `${job.prefix}_${job.chunk.key}.${img.ext}`;
      textures.push({ name: tex, data: img.data });
      // Aerial photos carry their own light and shadow, so lean on ambient.
      materials.push(material(`${job.prefix}_${job.chunk.key}`, tex, { ambient: 0.6, diffuse: 0.2, specular: 0, exp: 1 }));
      textured.add(job.chunk.key);
      if (img.rgba && job.prefix === "terrain") {
        treeSpots.push(...treeSpotsFromImagery(img.rgba, job.size, job.chunk, opts.trees));
        if (opts.buildings && opts.detectBuildings) detected.push(...detectBuildings(img.rgba, job.size, job.chunk));
        photos.push({ chunk: job.chunk, rgba: img.rgba, size: job.size });
      }
    }
  }

  // Other streets: planned now so buildings, trees and verges can keep clear.
  const streetPlan = planSideStreets(
    opts.sideStreets ? sources.streets?.lines ?? [] : [], sources.streets?.names ?? [], plan, index, opts, proj,
  );
  const sideTraced = raster && opts.traceRoads ? traceSideStreets(streetPlan.streets, raster, opts) : 0;
  const streetIndex = new LineIndex(streetPlan.streets);
  const mouth = (side: 1 | -1, sd: number) => streetPlan.junctions.some((j) => j.side === side && Math.abs(j.s - sd) < j.width / 2 + 1.5);

  const mapped: Building[] = opts.buildings
    ? (sources.osm?.buildings ?? []).map((b, i) => fromOsm(b.ring.map((p) => proj.toLocal(p)), b.tags, i))
    : [];
  // A house on every lot along the streets, where the photo shows a roof there.
  const photo = chunkPhotoSampler(photos);
  const frontage = photo && opts.buildings && opts.detectBuildings ? (() => {
    const realStreets = streetPlan.streets.filter((st) => /^(primary|secondary|tertiary|minor)/.test(st.cls));
    const known = [...mapped, ...detected].map((b) => centroid(b.ring));
    const cache = new Map<string, boolean>();
    const builtUp = (x: number, y: number) => {
      const key = `${Math.floor(x / 50)},${Math.floor(y / 50)}`;
      let v = cache.get(key);
      if (v === undefined) {
        const cx = (Math.floor(x / 50) + 0.5) * 50, cy = (Math.floor(y / 50) + 0.5) * 50;
        const near = (r: number) => ([px, py]: Vec2) => Math.hypot(px - cx, py - cy) < r;
        v = known.filter(near(150)).length >= 4 || realStreets.filter((st) => st.pts.some(near(120))).length >= 3;
        cache.set(key, v);
      }
      return v;
    };
    const onRoad = (x: number, y: number) => {
      const n = index.nearest(x, y, 30);
      return (!!n && n.dist < index.at(n).width / 2 + 1) || streetIndex.clearance(x, y) < 1;
    };
    return frontageHouses([
      { pts: plan.samples.map((s) => s.pos), half: plan.samples.map((s) => s.width / 2) },
      ...streetPlan.streets.map((st) => ({ pts: st.pts, half: st.pts.map((_, i) => (st.widths?.[i] ?? st.width) / 2) })),
    ], photo, onRoad, builtUp, [...mapped, ...detected], plan.samples.length);
  })() : [];
  const kept = filterBuildings([...mapped, ...detected, ...frontage], index, opts, opts.buildingRadius)
    .filter((b) => !b.ring.some(([x, y]) => inRoundabout(plan, x, y, opts.vergeWidth + 2)))
    // Detected roofs on a street are paving, not houses; mapped ones get a little more benefit of the doubt.
    .filter((b) => !b.ring.some(([x, y]) => streetIndex.clearance(x, y) < (b.source !== "osm" ? 1 : -0.5)));

  await progress("Building road and terrain meshes");
  // Road surface per chunk: dense asphalt on major roads and in built-up
  // areas, chip seal on rural roads (the usual Australian split).
  const centres = kept.map((b) => b.ring[0]);
  const previewTextures: TrackResult["previewTextures"] = {};
  const surfaceMaterials = new Set<string>();
  const roadMaterial = (ci: number, meanWidth: number, mid: RoadSample): string => {
    let kind: SealKind;
    if (opts.roadSurface === "asphalt" || opts.roadSurface === "chipseal") kind = opts.roadSurface;
    else {
      const cls = sources.roadClassAt?.(proj.toLngLat(mid.pos));
      const nearby = centres.filter(([x, y]) => Math.hypot(x - mid.pos[0], y - mid.pos[1]) < 150).length;
      // Kerbed streets are town streets: asphalt.
      kind = /^(motorway|trunk|primary)/.test(cls ?? "") || nearby >= 8 || !!mid.kerb ? "asphalt" : "chipseal";
    }
    const twoLane = meanWidth >= 5.5;
    const name = `road_${kind}_${twoLane ? 2 : 1}_${ci % 3}`;
    if (!surfaceMaterials.has(name)) {
      surfaceMaterials.add(name);
      const tex = sealTexture(kind, twoLane, ci % 3);
      textures.push({ name: `${name}.dds`, data: tex.dds });
      previewTextures[`${name}.dds`] = { rgba: tex.rgba, width: tex.width, height: tex.height };
      materials.push(material(name, `${name}.dds`, { ambient: 0.4, diffuse: 0.45, specular: kind === "asphalt" ? 0.08 : 0.04, exp: 20 }));
    }
    return name;
  };
  // Photo surface: chunks where the road was traced get their own stretch of the aerial photo.
  const chunkMaterial: RoadMaterialFn = (ci, w, mid, a, b) => {
    if (opts.roadSurface === "photo" && raster && trace && a >= 0) {
      const tr = trace;
      const trusted = (i: number) => tr.conf[i] > 0.7;
      let ok = 0;
      for (let i = a; i <= b; i++) if (trusted(i % plan.samples.length)) ok++;
      if (ok / (b - a + 1) >= 0.3) {
        const name = `road_photo_${String(ci).padStart(3, "0")}`;
        const tex = photoRoadTexture(plan, displayOf(raster), a, b, trusted);
        textures.push({ name: `${name}.dds`, data: encodeDdsDxt1(tex.rgba, tex.width, tex.height) });
        previewTextures[`${name}.dds`] = tex;
        materials.push(material(name, `${name}.dds`, { ambient: 0.42, diffuse: 0.45, specular: 0.06, exp: 20 }));
        return { material: name, perChunk: true };
      }
    }
    return roadMaterial(ci, w, mid);
  };
  // Kerb and gutter: read off the photo where the road was traced; in town
  // they are the rule, so there it takes little evidence (or none, under canopy).
  const nS = plan.samples.length;
  // How built-up it is around each sample (checked every 10 m): 2 = town
  // (dense houses or a street grid), 1 = edge of town, 0 = country.
  // Motorways never count. Only real streets count, not driveways and tracks.
  const streets = streetPlan.streets.filter((st) => /^(primary|secondary|tertiary|minor)/.test(st.cls));
  const town: number[] = [];
  plan.samples.forEach((s, i) => {
    if (i % 5) return town.push(town[i - 1]);
    const near = (r: number) => ([x, y]: Vec2) => Math.hypot(x - s.pos[0], y - s.pos[1]) < r;
    const cls = sources.roadClassAt?.(proj.toLngLat(s.pos)) ?? "";
    if (/^(motorway|trunk)/.test(cls)) return town.push(0);
    const houses = centres.filter(near(150)).length, grid = streets.filter((st) => st.pts.some(near(120))).length;
    town.push(houses >= 20 || grid >= 5 ? 2 : houses >= 8 || grid >= 3 ? 1 : 0);
  });
  let kerbs: [number[], number[]] = [new Array(nS).fill(0), new Array(nS).fill(0)];
  if (opts.kerbs) {
    const tr = trace;
    const evidence = raster && tr ? kerbEvidence(plan, raster, (i) => tr.conf[i] > 0.7) : null;
    // A kerb must never stand on anything drivable: none across a side
    // street's mouth, on the inside of a turn too tight for the strip (it
    // would fold over onto the road), or anywhere its gutter, kerb or strip
    // would land on another street, a roundabout or another stretch of the
    // route itself.
    const kerbBlocked = (i: number, side: 1 | -1) => {
      const s = plan.samples[i];
      if (streetPlan.junctions.some((j) => j.side === side && Math.abs(j.s - s.s) < j.width / 2 + 4)) return true;
      const half = s.width / 2, reach = half + opts.vergeWidth + STRIP_EXTRA;
      const inside = s.curvature * side;
      if (inside > 0 && 1 / inside < reach + 3) return true;
      for (const t of [half + 0.3, half + KERB_BACK, half + 1.5, reach]) {
        const x = s.pos[0] + s.left[0] * t * side, y = s.pos[1] + s.left[1] * t * side;
        if (inRoundabout(plan, x, y, 1.5) || streetIndex.clearance(x, y) < 0.5) return true;
        // Clearly on the route's asphalt (another stretch of it).
        const n = index.nearest(x, y, 30);
        if (n && n.dist < index.at(n).width / 2 - 0.2) return true;
      }
      return false;
    };
    kerbs = planKerbs(plan, evidence, (i) => town[i], kerbBlocked);
    // A roundabout is kerbed when the road is kerbed coming up to it.
    for (const rb of plan.roundabouts) {
      const reach = outerRadius(rb) + 30;
      rb.kerbed = plan.samples.some((s, i) => (kerbs[0][i] || kerbs[1][i]) && Math.hypot(s.pos[0] - rb.c[0], s.pos[1] - rb.c[1]) < reach);
    }
  }
  // Record the kerbs on the samples too: the terrain reads them (SegmentIndex.at),
  // so the ground behind a kerb starts at nature strip height. Without this it
  // started BELOW_VERGE under the road edge, leaving a step of about 40 cm
  // between the back of the nature strip and the ground.
  plan.samples.forEach((smp, i) => {
    if (kerbs[0][i] > 0 || kerbs[1][i] > 0) smp.kerb = [kerbs[0][i], kerbs[1][i]];
  });
  const kerbAt = (i: number, side: 1 | -1) => kerbs[side === 1 ? 0 : 1][((i % nS) + nS) % nS] > 0;
  // The gravel verge gives way to the kerb's nature strip, which also covers the slopes where kerbs start and end.
  const roadMeshes = buildRoadMeshes(plan, opts, chunkMaterial, (i, side) => mouth(side, plan.samples[i % nS].s) || kerbAt(i, side));
  plan.roundabouts.forEach((rb, k) => {
    const open = [...roadMeshes.openings[k]];
    // Side streets that run into the ring get an opening in its verge and kerb too.
    const Ro = outerRadius(rb);
    for (const st of streetPlan.streets) {
      for (const p of [st.pts[0], st.pts[st.pts.length - 1]]) {
        if (Math.hypot(p[0] - rb.c[0], p[1] - rb.c[1]) > Ro + 6) continue;
        const a = Math.atan2(p[1] - rb.c[1], p[0] - rb.c[0]), half = (st.width / 2 + 2.5) / Ro;
        open.push([a - half, a + half]);
      }
    }
    if (open.length) rb.openings = open;
  });
  // Nature strips: the aerial photo of the strip itself when there is one, so footpaths and driveways show.
  const stripMaterial: StripMaterialFn = (ci, a, b) => {
    if (!raster || opts.imageryZoom <= 0) return { material: "grass", photo: false };
    const name = `strip_photo_${String(ci).padStart(3, "0")}`;
    const tex = stripPhotoTexture(plan, displayOf(raster), opts, a, b);
    textures.push({ name: `${name}.dds`, data: encodeDdsDxt1(tex.rgba, tex.width, tex.height) });
    previewTextures[`${name}.dds`] = tex;
    materials.push(material(name, `${name}.dds`, { ambient: 0.6, diffuse: 0.2, specular: 0, exp: 1 }));
    return { material: name, photo: true };
  };
  // Kerbs round the corners into side streets, carrying on along each one's first 40 m; then along the road.
  const surface = streetSurface(plan, index, opts, (x, y) => terrainAt(x, y).h);
  const streetAt = streetPlan.junctions.map((j) => {
    const s = plan.samples[j.seg], half = s.width / 2;
    const o: Vec2 = [s.pos[0] + s.left[0] * j.side * half, s.pos[1] + s.left[1] * j.side * half];
    for (const st of streetPlan.streets) {
      for (const k of st.joins) if (Math.hypot(st.pts[k][0] - o[0], st.pts[k][1] - o[1]) < 4) return { st, k };
    }
    return null;
  });
  const streetEdge = (ji: number, c: -1 | 1, R: number) => {
    const m = streetAt[ji];
    if (!m) return null;
    const { st, k: k0 } = m;
    const n = st.pts.length, step = k0 === 0 ? 1 : -1;
    const tan = plan.samples[streetPlan.junctions[ji].seg].tan;
    const dirAt = (k: number): Vec2 => {
      const a = st.pts[Math.max(0, k - 1)], b = st.pts[Math.min(n - 1, k + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    };
    // Which side of the street this corner is on (the street's own left, in its point order).
    const d0 = dirAt(k0);
    const sideSt = tan[0] * c * -d0[1] + tan[1] * c * d0[0] >= 0 ? 1 : -1;
    const out: { pos: [number, number]; out: [number, number]; z: number }[] = [];
    let dist = 0;
    for (let k = k0; k >= 0 && k < n; k += step) {
      if (k !== k0) dist += Math.hypot(st.pts[k][0] - st.pts[k - step][0], st.pts[k][1] - st.pts[k - step][1]);
      if (dist < R) continue;
      if (dist > R + 40) break;
      const d = dirAt(k), left: [number, number] = [-d[1] * sideSt, d[0] * sideSt];
      const w = (st.widths?.[k] ?? st.width) / 2;
      const pos: [number, number] = [st.pts[k][0] + left[0] * w, st.pts[k][1] + left[1] * w];
      // Stop short of the route (the street's far end) or a roundabout.
      const near = index.nearest(pos[0], pos[1], 30);
      if (dist > R + 4 && near && near.dist < index.at(near).width / 2 + 4) break;
      if (inRoundabout(plan, pos[0], pos[1], 4)) break;
      out.push({ pos, out: left, z: surface(st, k, sideSt * w) });
    }
    return out.length > 4 ? out : null;
  };
  const returns = opts.kerbs
    ? buildKerbReturns(plan, opts, streetPlan.junctions, kerbs, roadMaterial(0, 6, { ...plan.samples[0], kerb: [1, 1] }), raster && opts.imageryZoom > 0 ? displayOf(raster) : undefined, streetEdge, photo ?? undefined)
    : null;
  const kerbReturns = returns?.nodes ?? [];
  if (returns?.sideAtlas) {
    textures.push({ name: "sidestrips_photo.dds", data: encodeDdsDxt1(returns.sideAtlas.rgba, returns.sideAtlas.width, returns.sideAtlas.height) });
    previewTextures["sidestrips_photo.dds"] = returns.sideAtlas;
    materials.push(material("sidestrips_photo", "sidestrips_photo.dds", { ambient: 0.6, diffuse: 0.2, specular: 0, exp: 1 }));
  }
  if (returns?.atlas) {
    textures.push({ name: "returns_photo.dds", data: encodeDdsDxt1(returns.atlas.rgba, returns.atlas.width, returns.atlas.height) });
    previewTextures["returns_photo.dds"] = returns.atlas;
    materials.push(material("returns_photo", "returns_photo.dds", { ambient: 0.6, diffuse: 0.2, specular: 0, exp: 1 }));
  }
  const kerbMeshes = buildKerbs(plan, opts, kerbs, stripMaterial, returns?.noRamp);
  // Photo surface on the traced side streets too (the nearest 40, to keep the file in check).
  const photoStreets = new Set(
    opts.roadSurface === "photo" && raster
      ? streetPlan.streets
        .filter((st) => st.traced && st.traced.conf.filter((c) => c > 0.7).length / st.traced.conf.length > 0.5)
        .map((st) => ({ st, d: Math.min(...st.pts.map((p) => index.nearest(p[0], p[1], 500)?.dist ?? 500)) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 40)
        .map((x) => x.st)
      : [],
  );
  const sideStreets = buildSideStreets(streetPlan.streets, plan, index, opts, (x, y) => terrainAt(x, y).h, (st, i) => {
    if (photoStreets.has(st) && st.traced && raster) {
      const sub = st.traced.plan, conf = st.traced.conf;
      const name = `side_photo_${String(i).padStart(3, "0")}`;
      // 128 px across; about 12 cm per pixel along, in a power of two.
      let h = 64;
      while (h < sub.length / 0.12 && h < 2048) h *= 2;
      const tex = photoRoadTexture(sub, displayOf(raster), 0, sub.samples.length - 1, (k) => conf[k] > 0.7, 128, h);
      textures.push({ name: `${name}.dds`, data: encodeDdsDxt1(tex.rgba, tex.width, tex.height) });
      previewTextures[`${name}.dds`] = tex;
      materials.push(material(name, `${name}.dds`, { ambient: 0.42, diffuse: 0.45, specular: 0.06, exp: 20 }));
      return { material: name, perStreet: true };
    }
    const mid = st.pts[Math.floor(st.pts.length / 2)];
    return roadMaterial(i, st.width, { ...plan.samples[0], pos: mid });
  });
  const sampleNear = (sd: number) => plan.samples[Math.max(0, Math.min(plan.samples.length - 1, Math.round(sd / opts.spacing)))];
  // Markings read off the photo where the road was traced; generated elsewhere.
  let imageLines: ImageLine[] = [];
  let covered = (_i: number) => false;
  if (opts.markings && raster && trace) {
    await progress("Reading line markings from the aerial photos");
    const tr = trace;
    const trusted = (i: number) => tr.conf[i] > 0.7;
    imageLines = findLines(plan, paintCandidates(plan, raster, trusted), trusted);
    const near = new Uint8Array(plan.samples.length);
    const reachSamples = Math.round(40 / opts.spacing);
    for (const ln of imageLines) {
      for (let i = Math.max(0, ln.i0 - reachSamples); i <= Math.min(plan.samples.length - 1, ln.i1 + reachSamples); i++) near[i] = 1;
    }
    covered = (i) => trusted(i) && near[i] === 1;
  }
  // Painted marks street-level imagery located: snapped to the road at their distance along it.
  const discreteMarks = (): DiscreteMark[] => (sources.seen ?? []).flatMap((f): DiscreteMark[] => {
    const m = /^marking--discrete--(stop-line|give-way|crosswalk-zebra|arrow--([a-z-]+)|text--(\d+))/.exec(f.value);
    if (!m) return [];
    const p = proj.toLocal(f.at);
    const n = index.nearest(p[0], p[1], 15);
    // Seen on this road, not the other carriageway or a side street.
    if (!n || Math.abs(n.t) > plan.samples[n.seg].width / 2 + 1) return [];
    const at = { s: plan.samples[n.seg].s + n.frac * opts.spacing, t: n.t };
    if (m[2]) return [{ ...at, kind: "arrow", shape: m[2] }];
    if (m[3]) return [{ ...at, kind: "text", shape: m[3] }];
    return [{ ...at, kind: m[1] === "stop-line" ? "stop" : m[1] === "give-way" ? "giveway" : "zebra" }];
  }).filter((d, i, all) => !all.slice(0, i).some((e) => e.kind === d.kind && Math.abs(e.s - d.s) < 8
    // Arrows and numbers: one per lane.
    && (!/^(arrow|text)$/.test(d.kind) || Math.sign(e.t) === Math.sign(d.t) && Math.abs(e.t - d.t) < 1.6)));
  const markings = opts.markings
    ? buildMarkings(plan, opts, (sd) => {
      const p = sampleNear(sd).pos;
      return !!inRoundabout(plan, p[0], p[1], 1);
    }, (side, sd) => mouth(side, sd) || kerbAt(Math.round(sd / opts.spacing), side), { lines: imageLines, covered }, [
      ...discreteMarks(),
      // The start and finish lines themselves, painted across the road.
      ...(plan.timed ? [
        { s: plan.samples[plan.timed.start].s, t: 0, kind: "start" as const },
        { s: plan.samples[plan.timed.finish].s, t: 0, kind: "finish" as const },
      ] : []),
    ])
    : [];
  // The full circulating carriageway and island of each roundabout.
  const ringNodes: Kn5Node[] = [];
  plan.roundabouts.forEach((rb, k) => {
    const nearest = plan.samples.reduce((a, s) => (Math.abs(s.s - rb.sIn) < Math.abs(a.s - rb.sIn) ? s : a));
    const m = buildRingMeshes(rb, k, opts, roadMaterial(Math.floor(plan.samples.indexOf(nearest) / 120), rb.w, nearest));
    ringNodes.push(m.road, m.island, m.verge, ...m.kerb);
  });
  const terrainNodes: Kn5Node[] = [];
  for (const [i, chunk] of chunks.entries()) {
    await progress("Building road and terrain meshes", i / chunks.length);
    const mesh = buildTerrainChunk(chunk, terrainAt, opts, textured.has(chunk.key));
    if (mesh) terrainNodes.push(mesh);
  }
  const backdropNodes: Kn5Node[] = [];
  for (const chunk of backdrop) {
    const mesh = buildBackdropChunk(chunk, farDem, index, opts, textured.has(chunk.key));
    if (mesh) backdropNodes.push(mesh);
  }
  const ground = (x: number, y: number) => terrainAt(x, y).h;
  const walls = buildWalls(plan, opts, ground, index);

  await progress("Placing scenery");
  const offRings = (spots: TreeSpot[]) => spots.filter((t) => !inRoundabout(plan, t.x, t.y, opts.vergeWidth + 3));
  const offStreets = (spots: TreeSpot[]) => spots.filter((t) => streetIndex.clearance(t.x, t.y) > 1.5);
  const trees = buildTrees(offStreets(offRings(filterTrees(treeSpots, index, opts, opts.maxTrees))), ground);
  // A tree and a ring of shrubs on each island big enough for them.
  const islandTrees = plan.roundabouts.flatMap((rb) => {
    const ri = innerRadius(rb);
    if (opts.trees <= 0 || ri < 4) return [];
    const shrubs: TreeSpot[] = [{ x: rb.c[0], y: rb.c[1], scale: Math.min(0.9, ri / 12), variant: 0 }];
    const count = Math.floor(ri);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * 2 * Math.PI;
      shrubs.push({ x: rb.c[0] + Math.cos(a) * ri * 0.55, y: rb.c[1] + Math.sin(a) * ri * 0.55, scale: 0.22, variant: k % 2 });
    }
    return shrubs;
  });
  const islandGround = (x: number, y: number) => {
    const rb = inRoundabout(plan, x, y)!;
    return ringHeight(rb, innerRadius(rb)) + 0.55;
  };
  const shrubs = islandTrees.length ? buildTrees(islandTrees, islandGround, "ISLANDTREES") : [];
  const ringWalls = plan.roundabouts.map((rb, k) => buildRingWall(rb, k, opts, ground)).filter((w): w is Kn5Node & { kind: "mesh" } => !!w);

  const osmRails = opts.guardRails ? (sources.osm?.guardRails ?? []).map((l) => l.map((p) => proj.toLocal(p))) : [];
  const needs = railNeeds(plan, opts, ground, osmRails, index);
  if (!opts.guardRails) needs.forEach((side) => side.fill(false));
  // No rails or posts on or beside a roundabout.
  const nearRing = plan.samples.map((s) => !!inRoundabout(plan, s.pos[0], s.pos[1], 15));
  // Nor across a side street's mouth.
  needs.forEach((side, k) => side.forEach((_, i) => { if (mouth(k === 0 ? 1 : -1, plan.samples[i].s)) side[i] = false; }));
  needs.forEach((side) => side.forEach((_, i) => { if (nearRing[i]) side[i] = false; }));
  // Kerbed streets have neither.
  needs.forEach((side, k) => side.forEach((_, i) => { if (kerbAt(i, k === 0 ? 1 : -1)) side[i] = false; }));
  const rails = buildGuardRails(plan, opts, needs);
  const postMask = needs.map((side, k) => side.map((v, i) => v || nearRing[i] || mouth(k === 0 ? 1 : -1, plan.samples[i].s) || kerbAt(i, k === 0 ? 1 : -1))) as [boolean[], boolean[]];
  const posts = opts.guidePosts ? buildGuidePosts(plan, opts, postMask) : [];
  // Inside the corridor buildings stand on the detailed terrain; further out, on the horizon mesh.
  const buildingGround = (x: number, y: number) => {
    const n = index.nearest(x, y, opts.corridor - 1);
    return n ? ground(x, y) : backdropHeight(farDem, index, opts, x, y) - 0.6;
  };
  // Power poles, wires and street lights: seen, mapped, or (lights, in town) at a typical spacing.
  const seenLocal = mergeSightings((sources.seen ?? []).map((f) => ({ ...f, at: proj.toLocal(f.at) })));
  const osmLocal = (pts?: LngLat[]) => (pts ?? []).map((p) => proj.toLocal(p));
  const utilities = placeUtilities({
    poles: [...seenLocal.filter((f) => /^object--support--utility-pole/.test(f.value)).map((f) => f.at), ...osmLocal(sources.osm?.poles)],
    lamps: [...seenLocal.filter((f) => /^object--street-light/.test(f.value)).map((f) => f.at), ...osmLocal(sources.osm?.lamps)],
    lines: (sources.osm?.powerLines ?? []).map(osmLocal),
  }, plan, index, opts, (i) => town[i], (x, y) => streetIndex.clearance(x, y) < 1 || kept.some((b) => pointInRing(x, y, b.ring)));
  // Signs and street furniture; their artwork is drawn in one atlas.
  const art = new ArtList();
  const pieces = [
    ...(opts.streetSigns ? streetSigns(streetPlan, plan, opts, art) : []),
    ...(opts.landmarks ? landmarks((sources.pois ?? []).map((p) => ({ ...p, at: proj.toLocal(p.at) })), plan, index, opts, art,
      (x, y) => Math.min(streetIndex.clearance(x, y), ...kept.map((b) => (pointInside(x, y, b.ring) ? -1 : Infinity)))) : []),
    ...seenFeatures((sources.seen ?? []).map((f) => ({ ...f, at: proj.toLocal(f.at) })), plan, index, opts, art),
    ...gateSigns(plan, opts, art),
    ...utilities.pieces,
  ];
  let atlas = null;
  if (sources.renderArt && art.list.length) {
    atlas = await sources.renderArt(art.list);
    textures.push({ name: "signart.png", data: atlas.data });
    materials.push({ ...material("signart", "signart.png", { ambient: 0.55, diffuse: 0.45, specular: 0.15, exp: 20 }), shader: "ksPerPixelAT", alphaTested: true });
  }
  const furniture = buildPieces(pieces, atlas);
  const houses = buildBuildings(opts.horizon > 0 ? kept : kept.filter((b) => b.ring.every(([x, y]) => index.nearest(x, y, opts.corridor - 1))), buildingGround);

  const group = (name: string, children: Kn5Node[]): Kn5GroupNode => ({ kind: "node", name, transform: IDENTITY, children });
  // Last check: no kerb, strip, gutter or rail triangle stands on the route's asphalt.
  const onRoad = onRoute(plan, index);
  const meshesOf = (nodes: Kn5Node[]) => nodes.filter((n): n is Kn5MeshNode => n.kind === "mesh");
  const kerbsClear = keepOffRoute([...kerbMeshes.gutter, ...kerbMeshes.kerb, ...kerbMeshes.strip, ...kerbReturns], onRoad);
  const ringsClear = keepOffRoute(meshesOf(ringNodes), onRoad);
  const railsClear = keepOffRoute(rails.rails, onRoad);
  const slug = slugify(opts.name);
  const model: Kn5Model = {
    textures,
    materials,
    // Wide meshes split into tiles and small detail given a draw distance, so the game can skip what's out of sight.
    root: group(slug, [
      ...cullable([
        group("ROAD", roadMeshes.road),
        group("SIDESTREETS", sideStreets),
        group("FURNITURE", furniture),
        group("WIRES", utilities.wires),
        group("ROUNDABOUTS", [...ringsClear.nodes, ...shrubs, ...ringWalls]),
        group("MARKINGS", markings),
        group("VERGE", roadMeshes.verge),
        group("KERBS", kerbsClear.nodes),
        group("TREES", trees),
        group("RAILS", [...railsClear.nodes, ...rails.posts]),
        group("GUIDEPOSTS", posts),
        group("BUILDINGS", houses),
      ]),
      // Already in compact chunks (terrain, horizon), or never drawn (walls).
      group("TERRAIN", terrainNodes),
      group("WALLS", walls),
      group("HORIZON", backdropNodes),
      ...trackObjects(plan, opts),
    ]),
  };

  await progress("Writing track files");
  const kn5 = writeKn5(model);
  const ai = writeFastLaneAi(buildAiLine(plan));
  const outline2d = simplify(plan.samples.map((s) => s.pos), 0.5).map(([x, y]) => [x, -y] as [number, number]);
  if (plan.closed) outline2d.push(outline2d[0]);
  const map = trackMap(outline2d);
  const meanWidth = plan.samples.reduce((a, s) => a + s.width, 0) / plan.samples.length;
  const cameras = placeCameras(plan, opts, (x, y) => terrainAt(x, y).h, (x, y) => kept.some((b) => pointInRing(x, y, b.ring)));
  const trackMeta: TrackMeta = { name: opts.name, ...meta };
  const files: Record<string, Uint8Array> = {
    [`${slug}/${slug}.kn5`]: kn5,
    [`${slug}/ai/fast_lane.ai`]: ai,
    [`${slug}/data/surfaces.ini`]: enc.encode(surfacesIni()),
    [`${slug}/data/map.ini`]: enc.encode(map.ini),
    [`${slug}/data/cameras_1.ini`]: enc.encode(camerasIni(cameras)),
    [`${slug}/map.png`]: map.png,
    [`${slug}/ui/ui_track.json`]: enc.encode(uiTrackJson(trackMeta, {
      length: timedLength(), width: meanWidth, pitboxes: opts.pitCount, closed: plan.closed, centre,
    })),
    [`${slug}/ui/outline.png`]: outlinePng(outline2d),
    [`${slug}/ui/preview.png`]: previewPng(outline2d, plan.closed),
    [`${slug}/README.txt`]: enc.encode(readme(trackMeta, textured.size ? (typeof sources.imageryCredit === "function" ? sources.imageryCredit() : sources.imageryCredit) ?? "aerial imagery" : null)),
  };

  const hs = plan.samples.map((s) => s.h);
  let climb = 0;
  for (let i = 1; i < hs.length; i++) climb += Math.max(0, hs[i] - hs[i - 1]);
  const geo = countGeometry(model.root);
  await progress("Done", 1);
  return {
    slug, files, model, plan, proj, previewTextures,
    junctions: streetPlan.junctions.map((j) => ({ s: j.s, side: j.side })),
    stats: {
      length: plan.length,
      timedLength: timedLength(),
      closed: plan.closed,
      minElevation: Math.min(...hs),
      maxElevation: Math.max(...hs),
      climb,
      meanWidth,
      vertices: geo.v,
      triangles: geo.t,
      terrainChunks: terrainNodes.length,
      kn5Bytes: kn5.length,
      trees: trees.reduce((n, m) => n + (m.kind === "mesh" ? m.positions.length / 3 / 24 : 0), 0),
      buildings: kept.length,
      buildingsDetected: kept.filter((b) => b.source !== "osm").length,
      traced: trace?.coverage ?? 0,
      photoLines: imageLines.length,
      photoChunks: materials.filter((m) => m.name.startsWith("road_photo_")).length,
      sideStreets: streetPlan.streets.length,
      sideTraced,
      kerbMetres: (kerbs[0].reduce((a, b) => a + b, 0) + kerbs[1].reduce((a, b) => a + b, 0)) * opts.spacing,
      poles: utilities.poles,
      streetLights: utilities.lights.length,
      streetSigns: pieces.filter((p) => p.kind === "blade").length,
      signs: pieces.filter((p) => p.kind === "face").length,
      railMetres: needs.reduce((n, side) => n + side.filter(Boolean).length * opts.spacing, 0),
    },
  };
}

function pointInside(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
