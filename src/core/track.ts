// The whole build: route in, track folder out. Network access is injected
// through `DataSources`, so the same pipeline runs in the browser (real
// tiles) and in Node tests (synthetic terrain).

import { buildAiLine } from "./aiLine";
import { BACKDROP_CHUNK, buildBackdropChunk, planBackdrop } from "./backdrop";
import { writeFastLaneAi } from "./aiSpline";
import { outlinePng, previewPng, readme, slugify, surfacesIni, trackMap, uiTrackJson, type TrackMeta } from "./acFiles";
import type { HeightFn } from "./elevation";
import { boundsOf, LocalProjection, type Bounds, type LngLat } from "./geo";
import { frameTransform, IDENTITY, writeKn5, type Kn5GroupNode, type Kn5Material, type Kn5Model, type Kn5Node, type Kn5Texture } from "./kn5";
import { toAc } from "./mesh";
import { withDefaults, type BuildOptions } from "./options";
import { simplify } from "./polyline";
import { applyElevation, planRoad, surfaceHeight, SegmentIndex, type RoadPlan, type RoadSample } from "./road";
import { buildRoadMeshes, buildWalls } from "./roadMesh";
import { buildTerrainChunk, makeTerrainFn, planTerrainChunks, type TerrainChunk } from "./terrain";
import { asphaltTexture, grassTexture, solidTexture, vergeTexture } from "./textures";

/** Progress callback; a returned promise is awaited, which lets a UI repaint. */
export type Progress = (stage: string, fraction?: number) => void | Promise<void>;

export interface DataSources {
  /** Height sampler (local metres) covering `bounds`. */
  dem(proj: LocalProjection, bounds: Bounds, zoom: number): Promise<HeightFn>;
  /** Image bytes (PNG or JPEG) covering the chunk square, north up; null to fall back to grass. */
  imagery?(proj: LocalProjection, chunk: TerrainChunk, zoom: number, size: number): Promise<{ data: Uint8Array; ext: "png" | "jpg" | "dds" } | null>;
  /** Asphalt width at a point from map data, metres. */
  widthAt?(p: LngLat): number | undefined;
  /** Credit line for the imagery source, written into the README. */
  imageryCredit?: string;
}

export interface TrackResult {
  slug: string;
  files: Record<string, Uint8Array>;
  model: Kn5Model;
  plan: RoadPlan;
  proj: LocalProjection;
  stats: {
    length: number;
    closed: boolean;
    minElevation: number;
    maxElevation: number;
    climb: number;
    meanWidth: number;
    vertices: number;
    triangles: number;
    terrainChunks: number;
    kn5Bytes: number;
  };
}

const enc = new TextEncoder();
const MIN_LENGTH = 300;

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
    out.push(dummy(name, frameTransform(p.pos, p.fwd)));
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
    const startLine = 14 + rows * 8;
    const end = plan.samples[plan.samples.length - 1].s;
    for (let k = 0; k < opts.pitCount; k++) {
      const { s, t } = slot(k, startLine);
      place(`AC_START_${k}`, s, t, 0.5);
      place(`AC_PIT_${k}`, s, t, 0.5);
    }
    place("AC_HOTLAP_START_0", 4, 0, 0.5);
    const startHalf = along(plan, startLine, 0, 0, 0).sample.width / 2 + 1;
    place("AC_AB_START_L", startLine, startHalf, 1);
    place("AC_AB_START_R", startLine, -startHalf, 1);
    const finish = end - 25;
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
  const plan = planRoad(local, opts, widthFn);
  if (plan.length < MIN_LENGTH) throw new Error(`Road is ${Math.round(plan.length)} m; make it at least ${MIN_LENGTH} m`);

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
    { name: "road_2lane.png", data: asphaltTexture(true) },
    { name: "road_1lane.png", data: asphaltTexture(false) },
    { name: "verge.png", data: vergeTexture() },
    { name: "grass.png", data: grassTexture() },
    { name: "wall.png", data: solidTexture([128, 128, 128]) },
  ];
  const materials: Kn5Material[] = [
    material("road_2lane", "road_2lane.png", { ambient: 0.4, diffuse: 0.45, specular: 0.08, exp: 20 }),
    material("road_1lane", "road_1lane.png", { ambient: 0.4, diffuse: 0.45, specular: 0.08, exp: 20 }),
    material("verge", "verge.png", { ambient: 0.45, diffuse: 0.4, specular: 0, exp: 1 }),
    material("grass", "grass.png", { ambient: 0.45, diffuse: 0.4, specular: 0, exp: 1 }),
    material("wall", "wall.png", { ambient: 0.4, diffuse: 0.4, specular: 0, exp: 1 }),
  ];

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
    }
  }

  await progress("Building road and terrain meshes");
  const roadMeshes = buildRoadMeshes(plan, opts);
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
  const walls = buildWalls(plan, opts, (x, y) => terrainAt(x, y).h, index);

  const group = (name: string, children: Kn5Node[]): Kn5GroupNode => ({ kind: "node", name, transform: IDENTITY, children });
  const slug = slugify(opts.name);
  const model: Kn5Model = {
    textures,
    materials,
    root: group(slug, [
      group("ROAD", roadMeshes.road.map((r) => r.mesh)),
      group("VERGE", roadMeshes.verge),
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
  const trackMeta: TrackMeta = { name: opts.name, ...meta };
  const files: Record<string, Uint8Array> = {
    [`${slug}/${slug}.kn5`]: kn5,
    [`${slug}/ai/fast_lane.ai`]: ai,
    [`${slug}/data/surfaces.ini`]: enc.encode(surfacesIni()),
    [`${slug}/data/map.ini`]: enc.encode(map.ini),
    [`${slug}/map.png`]: map.png,
    [`${slug}/ui/ui_track.json`]: enc.encode(uiTrackJson(trackMeta, {
      length: plan.length, width: meanWidth, pitboxes: opts.pitCount, closed: plan.closed, centre,
    })),
    [`${slug}/ui/outline.png`]: outlinePng(outline2d),
    [`${slug}/ui/preview.png`]: previewPng(outline2d, plan.closed),
    [`${slug}/README.txt`]: enc.encode(readme(trackMeta, textured.size ? sources.imageryCredit ?? "aerial imagery" : null)),
  };

  const hs = plan.samples.map((s) => s.h);
  let climb = 0;
  for (let i = 1; i < hs.length; i++) climb += Math.max(0, hs[i] - hs[i - 1]);
  const geo = countGeometry(model.root);
  await progress("Done", 1);
  return {
    slug, files, model, plan, proj,
    stats: {
      length: plan.length,
      closed: plan.closed,
      minElevation: Math.min(...hs),
      maxElevation: Math.max(...hs),
      climb,
      meanWidth,
      vertices: geo.v,
      triangles: geo.t,
      terrainChunks: terrainNodes.length,
      kn5Bytes: kn5.length,
    },
  };
}
