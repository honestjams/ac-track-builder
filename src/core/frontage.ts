// Houses along street frontages. In an Australian suburb there is a house
// on nearly every lot, set back a few metres from the street, and that row
// of roofs is most of what a driver sees. Mapped footprints are thin on the
// ground and roof patches are hard to pick out of the photo on their own
// (grey roofs, concrete drives and roads all look alike from above), so
// this reads the photo the way the houses are laid out: along each side of
// each street, from just behind the footpath back about 25 m.
//
// Every metre along the street, a column of 1 m cells is classed as roof or
// not (not vegetation, water, deep shade, bare earth or another street).
// The first solid run of roof in the column gives the house's front and
// back. Runs along the street are split into houses wherever the run
// stops (a side setback), its depth jumps, or the roof colour changes
// (the next house), and long runs into ~15 m lots. Each house is a box
// square to the street, its roof in the photo's colour.

import { centroid, houseRoof, nearestRoofColour, pointInRing, type Building } from "./buildings";
import type { Vec2 } from "./geo";
import { rng } from "./scenery";
import type { TerrainChunk } from "./terrain";
import { FACADES } from "./textures";

/** Aerial photo colour at a local point, 0..1 RGB, or null where there is none. */
export type PhotoSampler = (x: number, y: number) => [number, number, number] | null;

export interface Frontage {
  pts: Vec2[];
  /** Half the street's width at each point, metres. */
  half: number[];
}

/** Nearest-pixel sampler over the terrain chunks' aerial photos. */
export function chunkPhotoSampler(images: { chunk: TerrainChunk; rgba: Uint8Array | Uint8ClampedArray; size: number }[]): PhotoSampler | null {
  if (!images.length) return null;
  const span = images[0].chunk.maxX - images[0].chunk.minX;
  const grid = new Map<string, (typeof images)[number]>();
  for (const im of images) grid.set(`${Math.round(im.chunk.minX / span)},${Math.round(im.chunk.minY / span)}`, im);
  return (x, y) => {
    const im = grid.get(`${Math.floor(x / span)},${Math.floor(y / span)}`);
    if (!im) return null;
    const { chunk, rgba, size } = im;
    const px = Math.floor(((x - chunk.minX) / span) * size), py = Math.floor(((chunk.maxY - y) / span) * size);
    if (px < 0 || py < 0 || px >= size || py >= size) return null;
    const i = (py * size + px) * 4;
    return [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255];
  };
}

/** Is this colour a roof (rather than garden, pool, shade or bare earth)? */
export function roofLike([r, g, b]: [number, number, number]): boolean {
  const l = (r + g + b) / 3, sum = r + g + b + 1e-4;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  if ((2 * g - r - b) / sum > 0.025) return false; // lawn, trees
  if (b > r * 1.1 && b > g && sat > 0.25) return false; // water, pools
  if (l < 0.13) return false; // deep shade
  // Dry grass and bare earth: yellow-brown, pale. Terracotta is redder than that.
  if (l > 0.33 && r > b * 1.25 && g > b * 1.15 && r < g * 1.25 && sat > 0.18) return false;
  return true;
}

const NEAR = 3; // scan from this far behind the kerb line...
const FAR = 28; // ...to this far, metres
const MAX_FRONT = 14; // a house's front within this distance of the kerb line
const STEP = 1;

interface Column {
  ok: boolean;
  d0: number;
  d1: number;
  rgb: [number, number, number];
  /** Centreline point, direction and half width of the street here. */
  pos: Vec2;
  tan: Vec2;
  half: number;
}

export function frontageHouses(
  streets: Frontage[],
  photo: PhotoSampler,
  /** On a street (any of them, the route included). */
  onRoad: (x: number, y: number) => boolean,
  /** Built-up enough to expect a house on every lot. */
  builtUp: (x: number, y: number) => boolean,
  existing: Building[],
  seed = 1,
): Building[] {
  const out: Building[] = [];
  const rand = rng(seed);
  const taken = (ring: Vec2[]) => {
    const c = centroid(ring);
    return [...existing, ...out].some((b) => pointInRing(c[0], c[1], b.ring) || pointInRing(...centroid(b.ring), ring));
  };

  for (const st of streets) {
    const cols = resample(st);
    for (const side of [1, -1] as const) {
      const column = cols.map(({ pos, tan, half }): Column => {
        const outV: Vec2 = [-tan[1] * side, tan[0] * side];
        const none = { ok: false, d0: 0, d1: 0, rgb: [0, 0, 0] as [number, number, number], pos, tan, half };
        if (!builtUp(pos[0], pos[1])) return none;
        let d0 = -1, d1 = -1, gap = 0;
        const acc = [0, 0, 0];
        let cnt = 0;
        for (let d = half + NEAR; d <= half + FAR; d += 1) {
          const x = pos[0] + outV[0] * d, y = pos[1] + outV[1] * d;
          if (onRoad(x, y)) break; // another street behind: the lot ends
          const c = cell(photo, x, y, tan, outV);
          const roof = !!c && roofLike(c);
          if (roof) {
            if (d0 < 0) {
              if (d > half + MAX_FRONT) break;
              d0 = d;
            }
            d1 = d;
            gap = 0;
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; cnt++;
          } else if (d0 >= 0 && ++gap > 1) break;
        }
        if (d0 < 0 || d1 - d0 < 6) return none;
        return { ok: true, d0: d0 - half, d1: d1 - half, rgb: [acc[0] / cnt, acc[1] / cnt, acc[2] / cnt], pos, tan, half };
      });

      // Split the row of roof into houses.
      let start = -1;
      const flush = (a: number, b: number) => {
        if (a < 0 || b - a + 1 < 7) return;
        const len = b - a + 1;
        const lots = len > 24 ? Math.round(len / 15) : 1;
        for (let k = 0; k < lots; k++) {
          const i0 = a + Math.round((k * len) / lots), i1 = a + Math.round(((k + 1) * len) / lots) - 1;
          const house = box(column.slice(i0, i1 + 1), side, rand);
          if (house && !taken(house.ring)) out.push(house);
        }
      };
      // Smooth along the street first, so a driveway, a skylight or a tree
      // over the roof doesn't split a house.
      const n = column.length;
      const near = (i: number, r: number) => column.slice(Math.max(0, i - r), Math.min(n, i + r + 1)).filter((c) => c.ok);
      const okS = column.map((_, i) => near(i, 2).length * 2 > Math.min(n, i + 3) - Math.max(0, i - 2));
      const back = column.map((_, i) => {
        const w = near(i, 3);
        return w.length ? median(w.map((c) => c.d1)) : NaN;
      });
      const rgbS = column.map((_, i) => {
        const w = near(i, 2);
        return w.length ? [0, 1, 2].map((k) => median(w.map((c) => c.rgb[k]))) : null;
      });
      // How different the roof is 3 m either side of each point: houses meet at its peaks.
      const mean = (rows: (number[] | null)[]) => {
        const v = rows.filter((r): r is number[] => !!r);
        return v.length ? [0, 1, 2].map((k) => v.reduce((a, r) => a + r[k], 0) / v.length) : null;
      };
      const change = column.map((_, i) => {
        const a = mean(rgbS.slice(Math.max(0, i - 3), i)), b = mean(rgbS.slice(i, i + 3));
        if (!a || !b) return 0;
        const la = (a[0] + a[1] + a[2]) / 3, lb = (b[0] + b[1] + b[2]) / 3;
        const ratio = Math.max(la, lb) / Math.max(1e-3, Math.min(la, lb));
        return Math.max(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 0.1, (ratio - 1) / 0.35);
      });
      for (let i = 0; i < n; i++) {
        if (!okS[i]) {
          flush(start, i - 1);
          start = -1;
          continue;
        }
        if (start < 0) {
          start = i;
          continue;
        }
        const peak = change[i] >= 1 && change[i] >= change[i - 1] && change[i] > (change[i + 1] ?? 0);
        const step = Math.abs(back[i] - back[i - 1]) > 3;
        if (peak || step) {
          flush(start, i - 1);
          start = i;
        }
      }
      flush(start, column.length - 1);
    }
  }
  return out;
}

/** The street every metre: position, direction and half width. */
function resample(st: Frontage): { pos: Vec2; tan: Vec2; half: number }[] {
  const out: { pos: Vec2; tan: Vec2; half: number }[] = [];
  for (let i = 1; i < st.pts.length; i++) {
    const a = st.pts[i - 1], b = st.pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const tan: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const first = out.length ? STEP - ((out.length * STEP) % 1) : 0;
    for (let d = first; d < len; d += STEP) {
      const f = d / len;
      out.push({ pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], tan, half: st.half[i - 1] + (st.half[i] - st.half[i - 1]) * f });
    }
  }
  return out;
}

/** Mean colour of a 1 m cell (four samples). */
function cell(photo: PhotoSampler, x: number, y: number, tan: Vec2, outV: Vec2): [number, number, number] | null {
  const acc = [0, 0, 0];
  let n = 0;
  for (const [a, o] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
    const c = photo(x + tan[0] * a + outV[0] * o, y + tan[1] * a + outV[1] * o);
    if (!c) continue;
    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n++;
  }
  return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : null;
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** A house square to the street over a run of columns. */
function box(cols: Column[], side: 1 | -1, rand: () => number): Building | null {
  const ok = cols.filter((c) => c.ok);
  if (ok.length < 5) return null;
  // Front and back, measured from the kerb line.
  const front = median(ok.map((c) => c.d0)), back = Math.min(median(ok.map((c) => c.d1)), front + 22);
  if (back - front < 6) return null;
  // Square to the chord of this stretch of street, from its first column to its last.
  const a = cols[0], b = cols[cols.length - 1], mid = cols[cols.length >> 1];
  let tx = b.pos[0] - a.pos[0], ty = b.pos[1] - a.pos[1];
  const tl = Math.hypot(tx, ty);
  if (tl < 5) return null;
  tx /= tl;
  ty /= tl;
  const ox = -ty * side, oy = tx * side;
  const along = (p: Vec2) => (p[0] - mid.pos[0]) * tx + (p[1] - mid.pos[1]) * ty;
  const s0 = along(a.pos), s1 = along(b.pos);
  const f0 = mid.half + front, f1 = mid.half + back;
  const at = (s: number, f: number): Vec2 => [mid.pos[0] + tx * s + ox * f, mid.pos[1] + ty * s + oy * f];
  const ring: Vec2[] = [at(s0, f0), at(s1, f0), at(s1, f1), at(s0, f1)];
  const facing: [Vec2, Vec2] = [ring[0], ring[1]];
  // Counter-clockwise, as footprints are elsewhere.
  if (side === -1) ring.reverse();
  const rgb = [0, 1, 2].map((k) => (ok.reduce((s, c) => s + c.rgb[k], 0) / ok.length) * 255) as [number, number, number];
  const area = (s1 - s0) * (back - front);
  return {
    ring,
    height: area > 250 ? 3.6 : 2.8,
    roof: houseRoof(rand),
    roofColour: nearestRoofColour(rgb),
    facade: Math.floor(rand() * FACADES.length),
    source: "frontage",
    front: facing,
    setback: front,
    // About half the houses on a street show a garage door to it.
    garage: s1 - s0 >= 8 && rand() < 0.5,
  };
}
