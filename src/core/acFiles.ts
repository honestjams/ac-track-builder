// The text and image files that sit next to the kn5 in a track folder.

import type { LngLat } from "./geo";
import { Raster } from "./textures";

export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "real_road";
}

/**
 * Physics surfaces. Mesh names starting with a digit and one of these keys
 * (1ROAD_000, 1GRASS_t004, 1WALL_L_000) become drivable/collidable.
 */
/**
 * `traffic` turns on CSP's extended track physics and lets scripts drive
 * traffic cars (what CSP's traffic planner needs). The track then won't pass
 * an online server's integrity check against the original files, but LAN
 * between machines with the same build is fine.
 */
export function surfacesIni(traffic = false): string {
  const surfaces = [
    { KEY: "ROAD", FRICTION: 0.99, DAMPING: 0, WAV: "", WAV_PITCH: 0, FF_EFFECT: "NULL", DIRT_ADDITIVE: 0, IS_VALID_TRACK: 1, BLACK_FLAG_TIME: 0, SIN_HEIGHT: 0, SIN_LENGTH: 0, IS_PITLANE: 0, VIBRATION_GAIN: 0, VIBRATION_LENGTH: 0 },
    // Streets that aren't the route: asphalt underfoot, but leaving the route for one invalidates the run.
    { KEY: "STREET", FRICTION: 0.99, DAMPING: 0, WAV: "", WAV_PITCH: 0, FF_EFFECT: "NULL", DIRT_ADDITIVE: 0, IS_VALID_TRACK: 0, BLACK_FLAG_TIME: 0, SIN_HEIGHT: 0, SIN_LENGTH: 0, IS_PITLANE: 0, VIBRATION_GAIN: 0, VIBRATION_LENGTH: 0 },
    { KEY: "GRASS", FRICTION: 0.6, DAMPING: 0.1, WAV: "grass.wav", WAV_PITCH: 0, FF_EFFECT: "NULL", DIRT_ADDITIVE: 1, IS_VALID_TRACK: 0, BLACK_FLAG_TIME: 0, SIN_HEIGHT: 0.03, SIN_LENGTH: 0.5, IS_PITLANE: 0, VIBRATION_GAIN: 0.2, VIBRATION_LENGTH: 0.4 },
    // Concrete kerb: grippy enough, a little jolt and rumble when a wheel rides it.
    { KEY: "KERB", FRICTION: 0.92, DAMPING: 0, WAV: "", WAV_PITCH: 0, FF_EFFECT: "NULL", DIRT_ADDITIVE: 0, IS_VALID_TRACK: 1, BLACK_FLAG_TIME: 0, SIN_HEIGHT: 0, SIN_LENGTH: 0, IS_PITLANE: 0, VIBRATION_GAIN: 0.3, VIBRATION_LENGTH: 0.2 },
    { KEY: "WALL", FRICTION: 0.3, DAMPING: 0, WAV: "", WAV_PITCH: 0, FF_EFFECT: "NULL", DIRT_ADDITIVE: 0, IS_VALID_TRACK: 0, BLACK_FLAG_TIME: 0, SIN_HEIGHT: 0, SIN_LENGTH: 0, IS_PITLANE: 0, VIBRATION_GAIN: 0, VIBRATION_LENGTH: 0 },
  ];
  if (traffic) (surfaces[0] as Record<string, unknown>).WAV_PITCH = "extended-0";
  return surfaces
    .map((s, i) => `[SURFACE_${i}]\n` + Object.entries(s).map(([k, v]) => `${k}=${v}`).join("\n"))
    .join("\n\n") + "\n" + (traffic ? "\n[_SCRIPTING_PHYSICS]\nALLOW_TOOLS=1\nALLOW_TRACK_SCRIPTS=1\n" : "");
}

function geotag(lngLat: LngLat): [string, string] {
  const [lng, lat] = lngLat;
  return [`${Math.abs(lat).toFixed(5)} ${lat >= 0 ? "N" : "S"}`, `${Math.abs(lng).toFixed(5)} ${lng >= 0 ? "E" : "W"}`];
}

export interface TrackMeta {
  name: string;
  description?: string;
  country?: string;
  city?: string;
  author?: string;
}

export function uiTrackJson(meta: TrackMeta, opts: {
  length: number;
  width: number;
  pitboxes: number;
  closed: boolean;
  centre: LngLat;
}): string {
  const json = {
    name: meta.name,
    description: meta.description ?? `${meta.name}, built from the real road with OpenStreetMap and open elevation data.`,
    tags: ["real road", opts.closed ? "circuit" : "point to point", "street", "osm"],
    geotags: geotag(opts.centre),
    country: meta.country ?? "",
    city: meta.city ?? "",
    length: String(Math.round(opts.length)),
    width: String(Math.round(opts.width)),
    pitboxes: String(opts.pitboxes),
    run: opts.closed ? "clockwise" : "A to B",
    author: meta.author ?? "AC Track Builder",
    version: "1.0",
  };
  return JSON.stringify(json, null, 2) + "\n";
}

const MAP_MARGIN = 20;
const MAP_MAX_PIXELS = 2048;

/**
 * map.png plus data/map.ini. The game maps world X/Z to pixels with
 * px = (X + X_OFFSET) / SCALE_FACTOR, so the offsets shift the track's
 * bounding box to start one margin in from the image corner.
 * `points` are AC world X/Z pairs.
 */
export function trackMap(points: [number, number][]): { png: Uint8Array; ini: string } {
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const extent = Math.max(maxX - minX, maxZ - minZ, 1);
  const scale = Math.max(1, extent / (MAP_MAX_PIXELS - MAP_MARGIN * 2));
  const width = Math.ceil((maxX - minX) / scale) + MAP_MARGIN * 2;
  const height = Math.ceil((maxZ - minZ) / scale) + MAP_MARGIN * 2;
  const xOff = -minX + MAP_MARGIN * scale, zOff = -minZ + MAP_MARGIN * scale;
  const r = new Raster(width, height);
  r.line(points.map(([x, z]) => [(x + xOff) / scale, (z + zOff) / scale]), 8, [255, 255, 255, 255]);
  const ini = [
    "[PARAMETERS]",
    `WIDTH=${width}`,
    `HEIGHT=${height}`,
    `MARGIN=${MAP_MARGIN}`,
    `SCALE_FACTOR=${scale.toFixed(6)}`,
    `X_OFFSET=${xOff.toFixed(4)}`,
    `Z_OFFSET=${zOff.toFixed(4)}`,
    "DRAWING_SIZE=10",
    "",
  ].join("\n");
  return { png: r.png(), ini };
}

/** Fits points (AC X/Z) into a w x h box, keeping aspect ratio. */
function fit(points: [number, number][], w: number, h: number, margin: number): [number, number][] {
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const s = Math.min((w - margin * 2) / Math.max(1, maxX - minX), (h - margin * 2) / Math.max(1, maxZ - minZ));
  const ox = (w - (maxX - minX) * s) / 2, oz = (h - (maxZ - minZ) * s) / 2;
  return points.map(([x, z]) => [ox + (x - minX) * s, oz + (z - minZ) * s]);
}

/** Content Manager's track outline: white line on transparent. */
export function outlinePng(points: [number, number][]): Uint8Array {
  const r = new Raster(512, 512);
  const p = fit(points, 512, 512, 24);
  r.line(p, 10, [255, 255, 255, 255]);
  return r.png();
}

/** Fallback preview (the web app replaces it with a 3D render). */
export function previewPng(points: [number, number][], closed: boolean): Uint8Array {
  const r = new Raster(1024, 576, [24, 26, 32, 255]);
  const p = fit(points, 1024, 576, 48);
  r.line(p, 14, [70, 74, 84, 255]);
  r.line(p, 6, [245, 196, 66, 255]);
  r.dot(p[0][0], p[0][1], 12, [80, 220, 120, 255]);
  if (!closed) r.dot(p[p.length - 1][0], p[p.length - 1][1], 12, [235, 80, 80, 255]);
  return r.png();
}

export function readme(meta: TrackMeta, imagery: string | null): string {
  return [
    `${meta.name}`,
    "",
    "Install: copy this folder into assettocorsa/content/tracks/ (or drag the zip onto Content Manager).",
    "",
    "Data sources:",
    "- Road network (c) OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright",
    "- Routing by OSRM (project-osrm.org) on OpenStreetMap data.",
    "- Elevation: Terrain Tiles on AWS Open Data (Mapzen/Tilezen), from SRTM, USGS 3DEP, GMTED and national datasets.",
    imagery ? `- Aerial imagery: ${imagery}. For personal use only; do not redistribute this track.` : "- Terrain textures are procedural.",
    "",
    "Assetto Corsa is a trademark of Kunos Simulazioni. This track is not affiliated with or endorsed by Kunos.",
    "",
  ].join("\n");
}
