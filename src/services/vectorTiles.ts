// OpenFreeMap vector tiles (OpenMapTiles schema): building footprints with
// render heights, and road class / surface along the route. Served from a
// CDN, keyless, so unlike the public Overpass servers it is reliably up.

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { lngLatToPixel, pixelToLngLat, type LngLat } from "../core/geo";

const TILEJSON = "https://tiles.openfreemap.org/planet";
const Z = 14;

let template: Promise<string> | null = null;

function tileTemplate(): Promise<string> {
  template ??= fetch(TILEJSON)
    .then((r) => r.json())
    .then((j) => j.tiles[0] as string)
    .catch((e) => {
      template = null;
      throw e;
    });
  return template;
}

export interface TileBuilding {
  ring: LngLat[];
  tags: Record<string, string>;
}

export interface TileRoad {
  pts: LngLat[];
  cls: string;
  surface?: string;
  /** "bridge" or "tunnel" when the road is grade separated. */
  brunnel?: string;
}

/** A named road line (transportation_name layer). */
export interface TileName {
  pts: LngLat[];
  name: string;
  cls: string;
}

export interface TilePoi {
  at: LngLat;
  cls: string;
  subclass: string;
  name?: string;
  rank?: number;
}

export interface TileFeatures {
  buildings: TileBuilding[];
  roads: TileRoad[];
  names: TileName[];
  pois: TilePoi[];
}

type P = { x: number; y: number };

/** Clips a ring to the tile square (Sutherland-Hodgman), so buildings split across tiles meet exactly. */
function clipToTile(ring: P[], extent: number): P[] {
  let out = ring;
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= extent, (a, b) => ({ x: extent, y: a.y + ((b.y - a.y) * (extent - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= extent, (a, b) => ({ x: a.x + ((b.x - a.x) * (extent - a.y)) / (b.y - a.y), y: extent })],
  ];
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length], b = input[i];
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

function signedArea(r: P[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Buildings and roads from every z14 tile covering [west, south, east, north]. */
export async function fetchTileFeatures(bbox: [number, number, number, number]): Promise<TileFeatures> {
  const url = await tileTemplate();
  const [w, s, e, n] = bbox;
  const a = lngLatToPixel([w, n], Z), b = lngLatToPixel([e, s], Z);
  const x0 = Math.floor(a[0] / 256), x1 = Math.floor(b[0] / 256), y0 = Math.floor(a[1] / 256), y1 = Math.floor(b[1] / 256);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) throw new Error("Area too large for building tiles");
  const buildings: TileBuilding[] = [];
  const roads: TileRoad[] = [];
  const names: TileName[] = [];
  const pois: TilePoi[] = [];
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push((async () => {
        const r = await fetch(url.replace("{z}", String(Z)).replace("{x}", String(tx)).replace("{y}", String(ty)));
        if (!r.ok) return;
        const tile = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())));
        const toLngLat = (p: P, extent: number): LngLat => pixelToLngLat([(tx + p.x / extent) * 256, (ty + p.y / extent) * 256], Z);
        const bl = tile.layers.building;
        for (let i = 0; bl && i < bl.length; i++) {
          const f = bl.feature(i);
          const tags: Record<string, string> = {};
          for (const [k, v] of Object.entries(f.properties)) tags[k] = String(v);
          for (const ring of f.loadGeometry()) {
            // Exterior rings have positive area in tile coordinates; holes are skipped.
            if (signedArea(ring) <= 0) continue;
            const clipped = clipToTile(ring.slice(0, -1), bl.extent);
            if (clipped.length >= 3) buildings.push({ ring: clipped.map((p) => toLngLat(p, bl.extent)), tags });
          }
        }
        const tl = tile.layers.transportation;
        for (let i = 0; tl && i < tl.length; i++) {
          const f = tl.feature(i);
          if (f.type !== 2) continue;
          const cls = String(f.properties.class ?? "");
          const surface = f.properties.surface !== undefined ? String(f.properties.surface) : undefined;
          const brunnel = f.properties.brunnel !== undefined ? String(f.properties.brunnel) : undefined;
          for (const line of f.loadGeometry()) roads.push({ pts: line.map((p) => toLngLat(p, tl.extent)), cls, surface, brunnel });
        }
        const nl = tile.layers.transportation_name;
        for (let i = 0; nl && i < nl.length; i++) {
          const f = nl.feature(i);
          const name = f.properties.name;
          if (f.type !== 2 || !name) continue;
          for (const line of f.loadGeometry()) {
            names.push({ pts: line.map((p) => toLngLat(p, nl.extent)), name: String(name), cls: String(f.properties.class ?? "") });
          }
        }
        const pl = tile.layers.poi;
        for (let i = 0; pl && i < pl.length; i++) {
          const f = pl.feature(i);
          if (f.type !== 1) continue;
          const pr = f.properties;
          const [pt] = f.loadGeometry()[0];
          // Points in the tile's buffer show up in two tiles; keep the owner's copy.
          if (pt.x < 0 || pt.y < 0 || pt.x >= pl.extent || pt.y >= pl.extent) continue;
          pois.push({
            at: toLngLat(pt, pl.extent),
            cls: String(pr.class ?? ""),
            subclass: String(pr.subclass ?? ""),
            name: pr.name !== undefined ? String(pr.name) : undefined,
            rank: typeof pr.rank === "number" ? pr.rank : undefined,
          });
        }
      })().catch(() => undefined));
    }
  }
  await Promise.all(jobs);
  return { buildings, roads, names, pois };
}

/** Typical asphalt width by OpenMapTiles road class, metres. */
const CLASS_WIDTH: Record<string, number> = {
  motorway: 7.5, trunk: 7.5, primary: 7.5, secondary: 7, tertiary: 6.5, minor: 6, service: 4, track: 3.5, raceway: 10,
};

/** Road ways from the tiles as width-tagged lines, for when Overpass is down. */
export function classWidths(roads: TileRoad[]): { width: number; pts: LngLat[] }[] {
  return roads.filter((r) => CLASS_WIDTH[r.cls] !== undefined).map((r) => ({ width: CLASS_WIDTH[r.cls], pts: r.pts }));
}

/** Road class at a point: the nearest tile road within 12 m. */
export function roadClassLookup(roads: TileRoad[], lat: number): (p: LngLat) => string | undefined {
  const kx = Math.cos((lat * Math.PI) / 180) * 111320, ky = 111320;
  const drivable = roads.filter((r) => CLASS_WIDTH[r.cls] !== undefined);
  return (p) => {
    let best: string | undefined, bestD = 12 * 12;
    for (const r of drivable) {
      for (let i = 1; i < r.pts.length; i++) {
        const ax = (r.pts[i - 1][0] - p[0]) * kx, ay = (r.pts[i - 1][1] - p[1]) * ky;
        const bx = (r.pts[i][0] - p[0]) * kx, by = (r.pts[i][1] - p[1]) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
        const d = (ax + dx * t) ** 2 + (ay + dy * t) ** 2;
        if (d < bestD) {
          bestD = d;
          best = r.cls;
        }
      }
    }
    return best;
  };
}

/** A polygon from the tiles: exterior ring first, then holes. `edge[r][i]` is false where ring r's edge i is only a tile seam. */
export interface TilePolygon {
  rings: LngLat[][];
  edge: boolean[][];
}

/**
 * The sea (water layer, class ocean) and piers and jetties (transportation,
 * class pier, as areas) from z13 tiles over [west, south, east, north].
 * Polygons are clipped to their tiles so neighbouring tiles meet without overlap.
 */
export async function fetchCoast(bbox: [number, number, number, number]): Promise<{ ocean: TilePolygon[]; piers: TilePolygon[]; beaches: TilePolygon[] }> {
  const url = await tileTemplate();
  const z = 13;
  const [w, s, e, n] = bbox;
  const a = lngLatToPixel([w, n], z), b = lngLatToPixel([e, s], z);
  const x0 = Math.floor(a[0] / 256), x1 = Math.floor(b[0] / 256), y0 = Math.floor(a[1] / 256), y1 = Math.floor(b[1] / 256);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 100) throw new Error("Area too large for coast tiles");
  const ocean: TilePolygon[] = [];
  const piers: TilePolygon[] = [];
  const beaches: TilePolygon[] = [];
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      jobs.push((async () => {
        const r = await fetch(url.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty)));
        if (!r.ok) return;
        const tile = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())));
        const take = (layer: string, want: (p: Record<string, unknown>) => boolean, out: TilePolygon[]) => {
          const l = tile.layers[layer];
          for (let i = 0; l && i < l.length; i++) {
            const f = l.feature(i);
            if (f.type !== 3 || !want(f.properties)) continue;
            const ext = l.extent;
            let poly: TilePolygon | null = null;
            for (const ring of f.loadGeometry()) {
              const clipped = clipToTile(ring.slice(0, -1), ext);
              if (clipped.length < 3) continue;
              const onSeam = (p: P, q: P) => (p.x <= 0 && q.x <= 0) || (p.x >= ext && q.x >= ext) || (p.y <= 0 && q.y <= 0) || (p.y >= ext && q.y >= ext);
              const edge = clipped.map((p, k) => !onSeam(p, clipped[(k + 1) % clipped.length]));
              const ll = clipped.map((p) => pixelToLngLat([(tx + p.x / ext) * 256, (ty + p.y / ext) * 256], z));
              if (signedArea(ring) > 0) {
                poly = { rings: [ll], edge: [edge] };
                out.push(poly);
              } else if (poly) {
                poly.rings.push(ll);
                poly.edge.push(edge);
              }
            }
          }
        };
        take("water", (p) => p.class === "ocean", ocean);
        take("transportation", (p) => p.class === "pier", piers);
        take("landcover", (p) => p.class === "sand" && (p.subclass === "beach" || p.subclass === undefined), beaches);
      })().catch(() => undefined));
    }
  }
  await Promise.all(jobs);
  return { ocean, piers, beaches };
}
