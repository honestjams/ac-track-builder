// Geographic helpers. The track's local frame is Web Mercator scaled by
// cos(origin latitude): metres at the origin, conformal everywhere, and a
// linear map of web-map tile pixels. That last property means elevation and
// aerial tiles line up with the geometry exactly, with no reprojection.
// Scale error is ~0.1% ten kilometres north or south of the origin.

export type LngLat = [number, number];
/** Local metres: x east, y north. */
export type Vec2 = [number, number];

export const EARTH_RADIUS = 6378137; // WGS84 / Web Mercator sphere
const TILE_SIZE = 256;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Global Web Mercator pixel coordinates at zoom z (256 px tiles). */
export function lngLatToPixel(p: LngLat, z: number): Vec2 {
  const size = TILE_SIZE * 2 ** z;
  const x = ((p[0] + 180) / 360) * size;
  const s = Math.sin(rad(Math.max(-85.0511, Math.min(85.0511, p[1]))));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return [x, y];
}

export function pixelToLngLat(px: Vec2, z: number): LngLat {
  const size = TILE_SIZE * 2 ** z;
  const lng = (px[0] / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * px[1]) / size;
  return [lng, deg(Math.atan(Math.sinh(n)))];
}

export class LocalProjection {
  readonly origin: LngLat;
  private readonly k: number;
  private readonly mx0: number;
  private readonly my0: number;

  constructor(origin: LngLat) {
    this.origin = origin;
    this.k = Math.cos(rad(origin[1]));
    this.mx0 = EARTH_RADIUS * rad(origin[0]);
    this.my0 = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + rad(origin[1]) / 2));
  }

  toLocal(p: LngLat): Vec2 {
    const mx = EARTH_RADIUS * rad(p[0]);
    const my = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + rad(p[1]) / 2));
    return [(mx - this.mx0) * this.k, (my - this.my0) * this.k];
  }

  toLngLat(v: Vec2): LngLat {
    const mx = v[0] / this.k + this.mx0;
    const my = v[1] / this.k + this.my0;
    return [deg(mx / EARTH_RADIUS), deg(2 * Math.atan(Math.exp(my / EARTH_RADIUS)) - Math.PI / 2)];
  }

  /** Local metres per global pixel at zoom z (the same everywhere in this frame). */
  metresPerPixel(z: number): number {
    return ((2 * Math.PI * EARTH_RADIUS) / (TILE_SIZE * 2 ** z)) * this.k;
  }

  /** Local metres -> global pixel coordinates at zoom z. Linear, by construction. */
  localToPixel(v: Vec2, z: number): Vec2 {
    const o = lngLatToPixel(this.origin, z);
    const m = this.metresPerPixel(z);
    return [o[0] + v[0] / m, o[1] - v[1] / m];
  }

  pixelToLocal(px: Vec2, z: number): Vec2 {
    const o = lngLatToPixel(this.origin, z);
    const m = this.metresPerPixel(z);
    return [(px[0] - o[0]) * m, (o[1] - px[1]) * m];
  }
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Vec2[], pad = 0): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of points) {
    if (x < b.minX) b.minX = x;
    if (y < b.minY) b.minY = y;
    if (x > b.maxX) b.maxX = x;
    if (y > b.maxY) b.maxY = y;
  }
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Tile x/y ranges at zoom z covering local bounds. */
export function tilesCovering(proj: LocalProjection, b: Bounds, z: number): { x0: number; y0: number; x1: number; y1: number } {
  const a = proj.localToPixel([b.minX, b.maxY], z);
  const c = proj.localToPixel([b.maxX, b.minY], z);
  const max = 2 ** z - 1;
  const clamp = (v: number) => Math.max(0, Math.min(max, v));
  return {
    x0: clamp(Math.floor(a[0] / TILE_SIZE)),
    y0: clamp(Math.floor(a[1] / TILE_SIZE)),
    x1: clamp(Math.floor(c[0] / TILE_SIZE)),
    y1: clamp(Math.floor(c[1] / TILE_SIZE)),
  };
}
