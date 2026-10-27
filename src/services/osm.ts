// Road routing (OSRM), place search (Photon / Nominatim) and road widths
// (Overpass). All keyless public services; the browser's Referer identifies
// the app, as their usage policies ask.

import type { LngLat } from "../core/geo";
import type { OsmFeatures } from "../core/track";
import type { RoundaboutHint } from "../core/roundabout";

const OSRM = "https://router.project-osrm.org";
const PHOTON = "https://photon.komoot.io/api/";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

export interface Route {
  coords: LngLat[];
  distance: number;
  /** Where the route goes round a roundabout, with the arc it drives. */
  roundabouts: RoundaboutHint[];
  /** Where the route turns back on itself (usually a pin snapped to the wrong side of the road). */
  uturns: LngLat[];
}

interface OsrmStep {
  maneuver: { type: string; modifier?: string; location: LngLat };
  geometry: { coordinates: LngLat[] };
}

/** Driving route through the pins, in order, on the real road network. */
export async function route(pins: LngLat[], signal?: AbortSignal): Promise<Route> {
  const path = pins.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  const r = await fetch(`${OSRM}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=true&continue_straight=true`, { signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.code !== "Ok" || !body.routes?.length) {
    throw new Error(body.message || `Routing failed (HTTP ${r.status})`);
  }
  const steps: OsrmStep[] = body.routes[0].legs.flatMap((l: { steps: OsrmStep[] }) => l.steps);
  const roundabouts = steps
    .filter((st) => /^(roundabout|rotary|roundabout turn)$/.test(st.maneuver.type))
    .map((st) => ({ location: st.maneuver.location, arc: st.geometry.coordinates }));
  const uturns = steps.filter((st) => st.maneuver.modifier === "uturn").map((st) => st.maneuver.location);
  return { coords: body.routes[0].geometry.coordinates, distance: body.routes[0].distance, roundabouts, uturns };
}

export interface Place {
  label: string;
  detail: string;
  lngLat: LngLat;
  /** [minLng, maxLat, maxLng, minLat] when the place is an area. */
  extent?: [number, number, number, number];
}

/** Search-as-you-type (Photon is built for it; Nominatim's policy forbids it). */
export async function searchPlaces(q: string, near?: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const params = new URLSearchParams({ q, limit: "6" });
  if (near) {
    params.set("lon", near[0].toFixed(4));
    params.set("lat", near[1].toFixed(4));
  }
  const r = await fetch(`${PHOTON}?${params}`, { signal });
  if (!r.ok) return [];
  const body = await r.json();
  return (body.features ?? []).map((f: { properties: Record<string, string>; geometry: { coordinates: LngLat }; }) => {
    const p = f.properties as Record<string, unknown>;
    const label = String(p.name ?? p.street ?? p.city ?? "Unnamed");
    const detail = [p.street !== label ? p.street : null, p.city, p.state, p.country].filter(Boolean).join(", ");
    return { label, detail, lngLat: f.geometry.coordinates, extent: p.extent as Place["extent"] };
  });
}

export interface PlaceName {
  road?: string;
  town?: string;
  country?: string;
}

let lastNominatim = 0;

/** Road, town and country at a point (Nominatim, at most once a second). */
export async function reverseGeocode(p: LngLat): Promise<PlaceName> {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=16&lat=${p[1]}&lon=${p[0]}`);
  if (!r.ok) return {};
  const a = (await r.json()).address ?? {};
  return { road: a.road, town: a.town ?? a.village ?? a.city ?? a.suburb ?? a.county, country: a.country };
}

/** Typical asphalt width by OSM highway class, metres. */
const CLASS_WIDTH: Record<string, number> = {
  motorway: 7.5, trunk: 7.5, primary: 7.5, secondary: 7, tertiary: 6.5,
  motorway_link: 5, trunk_link: 5, primary_link: 5, secondary_link: 5, tertiary_link: 5,
  unclassified: 5.5, residential: 6, living_street: 5, service: 4, track: 3.5, raceway: 10, road: 6,
};

function wayWidth(tags: Record<string, string>): number | undefined {
  const w = parseFloat(tags.width ?? tags["est_width"] ?? "");
  if (w > 2 && w < 30) return w;
  const lanes = parseInt(tags.lanes ?? "", 10);
  if (lanes > 0 && lanes < 8) return Math.max(3.5, lanes * 3.2);
  return CLASS_WIDTH[tags.highway];
}

export interface Way {
  width: number;
  pts: LngLat[];
}

interface OverpassWay {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export interface OsmData {
  /** Asphalt width at a point; undefined when Overpass was unreachable. */
  widthAt?: (p: LngLat) => number | undefined;
  features: OsmFeatures;
}

/**
 * One Overpass query for the road ways under the route (for widths) and
 * guard rails. Every public mirror is asked at once and the first good
 * answer wins; if all fail, the build falls back to widths by road class
 * from the vector tiles. Buildings come from the vector tiles too.
 */
export async function fetchOsm(routeCoords: LngLat[]): Promise<OsmData> {
  const step = Math.max(1, Math.ceil(routeCoords.length / 180));
  const sampled = routeCoords.filter((_, i) => i % step === 0 || i === routeCoords.length - 1);
  const around = sampled.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(",");
  const query = `[out:json][timeout:40];(
    way(around:12,${around})[highway];
    way(around:15,${around})[barrier=guard_rail];
    way(around:30,${around})[junction~"^(roundabout|circular)$"];
  );out tags geom;`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  let elements: OverpassWay[] | undefined;
  try {
    elements = await Promise.any(OVERPASS.map(async (url) => {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      return ((body.elements ?? []) as OverpassWay[]).filter((e) => e.type === "way" && e.geometry);
    }));
  } catch {
    // every mirror failed
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  const features: OsmFeatures = { buildings: [], guardRails: [], roundaboutRings: [] };
  if (!elements) return { features };

  const ways: Way[] = [];
  for (const e of elements) {
    const tags = e.tags ?? {};
    const pts = e.geometry!.map((g) => [g.lon, g.lat] as LngLat);
    if (tags.junction === "roundabout" || tags.junction === "circular") {
      features.roundaboutRings!.push(pts);
    } else if (tags.barrier === "guard_rail") {
      features.guardRails.push(pts);
    } else if (tags.highway) {
      const width = wayWidth(tags);
      if (width !== undefined) ways.push({ width, pts });
    }
  }
  return { features, widthAt: ways.length ? widthLookup(ways, routeCoords[0][1]) : undefined };
}

export function widthLookup(ways: Way[], lat: number): (p: LngLat) => number | undefined {
  const kx = Math.cos((lat * Math.PI) / 180) * 111320, ky = 111320;
  return (p) => {
    let best: number | undefined, bestD = 12 * 12;
    for (const w of ways) {
      for (let i = 1; i < w.pts.length; i++) {
        const ax = (w.pts[i - 1][0] - p[0]) * kx, ay = (w.pts[i - 1][1] - p[1]) * ky;
        const bx = (w.pts[i][0] - p[0]) * kx, by = (w.pts[i][1] - p[1]) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
        const d = (ax + dx * t) ** 2 + (ay + dy * t) ** 2;
        if (d < bestD) {
          bestD = d;
          best = w.width;
        }
      }
    }
    return best;
  };
}
