// Photo road surface: each road chunk textured with the aerial photo of
// that stretch of road, so patches, repairs, stains, wheel-path wear and
// surface changes are where they are in reality.
//
// The photo is resampled across the road (left edge to right edge) and
// along it, then cleaned up for driving on:
//  - paint is replaced by the surrounding asphalt (markings are geometry),
//  - cars and other non-asphalt blobs are painted out the same way,
//  - tree shadows are evened out (the game lights the road itself),
//  - fine aggregate grain is added, finer than the photo can show.
// Rows the trace couldn't trust (canopy, deep shade) get plain asphalt in
// the colour of the nearest trusted rows.

import type { RoadPlan } from "./road";
import type { RasterSampler } from "./trace";

export const PHOTO_W = 256;
export const PHOTO_H = 4096;
/** Typical brightness of real asphalt the photo is toned to (0..1). */
const ASPHALT_L = 0.3;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * RGBA (PHOTO_W x PHOTO_H) for sections a..b of the road; u runs from the
 * left edge (0) to the right edge (1), v from section a (0) to b (1).
 */
export function photoRoadTexture(
  plan: RoadPlan,
  raster: RasterSampler,
  a: number,
  b: number,
  trusted: (i: number) => boolean,
): { rgba: Uint8Array; width: number; height: number } {
  const W = PHOTO_W, H = PHOTO_H;
  const n = plan.samples.length;
  const at = (i: number) => plan.samples[Math.min(n - 1, i % n)];
  const sA = at(a).s, sB = b >= n ? plan.length : at(b).s;
  const rgb = new Float32Array(W * H * 3);
  const rowOk = new Uint8Array(H);
  let k = a;
  for (let r = 0; r < H; r++) {
    const s = sA + ((r + 0.5) / H) * (sB - sA);
    while (k < b && (k + 1 >= n ? plan.length : at(k + 1).s) <= s) k++;
    const p = at(k), q = at(k + 1);
    const qs = k + 1 >= n ? plan.length : q.s;
    const f = qs > p.s ? Math.max(0, Math.min(1, (s - p.s) / (qs - p.s))) : 0;
    const px = p.pos[0] + (q.pos[0] - p.pos[0]) * f, py = p.pos[1] + (q.pos[1] - p.pos[1]) * f;
    const lx = p.left[0] + (q.left[0] - p.left[0]) * f, ly = p.left[1] + (q.left[1] - p.left[1]) * f;
    const w = p.width + (q.width - p.width) * f;
    rowOk[r] = trusted(k % n) ? 1 : 0;
    for (let c = 0; c < W; c++) {
      // Stay 0.25 m inside the edges: kerbs and verges aren't road.
      const t = (w / 2 - 0.25) * (1 - (2 * (c + 0.5)) / W);
      const col = rowOk[r] ? raster(px + lx * t, py + ly * t) : null;
      const o = (r * W + c) * 3;
      if (col) {
        rgb[o] = col[0];
        rgb[o + 1] = col[1];
        rgb[o + 2] = col[2];
      } else rowOk[r] = 0;
    }
  }

  // Asphalt reference per row: median of the darker 70% (paint and cars are bright or coloured).
  const ref = new Float32Array(H * 3).fill(NaN);
  const tmp: number[][] = [[], [], []];
  for (let r = 0; r < H; r++) {
    if (!rowOk[r]) continue;
    const lums: [number, number][] = [];
    for (let c = 0; c < W; c += 2) {
      const o = (r * W + c) * 3;
      lums.push([(rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3, c]);
    }
    lums.sort((x, y) => x[0] - y[0]);
    const keep = lums.slice(Math.floor(lums.length * 0.25), Math.floor(lums.length * 0.75));
    for (let ch = 0; ch < 3; ch++) {
      tmp[ch] = keep.map(([, c]) => rgb[(r * W + c) * 3 + ch]).sort((x, y) => x - y);
      ref[r * 3 + ch] = tmp[ch][tmp[ch].length >> 1];
    }
  }
  // Fill untrusted rows from the nearest trusted ones (or a neutral asphalt).
  let last = -1;
  for (let r = 0; r < H; r++) if (rowOk[r]) { last = r; } else if (last >= 0) for (let ch = 0; ch < 3; ch++) ref[r * 3 + ch] = ref[last * 3 + ch];
  last = -1;
  for (let r = H - 1; r >= 0; r--) {
    if (!Number.isNaN(ref[r * 3])) { last = r; continue; }
    for (let ch = 0; ch < 3; ch++) ref[r * 3 + ch] = last >= 0 ? ref[last * 3 + ch] : [0.27, 0.27, 0.28][ch];
  }
  // Smooth the reference along the road (~6 m) so it follows surface changes, not cars.
  const span = Math.max(1, Math.round((6 / Math.max(1, sB - sA)) * H));
  const sm = new Float32Array(H * 3);
  for (let ch = 0; ch < 3; ch++) {
    let acc = 0, cnt = 0;
    for (let r = -span; r < H + span; r++) {
      const add = r + span, sub = r - span - 1;
      if (add >= 0 && add < H) { acc += ref[add * 3 + ch]; cnt++; }
      if (sub >= 0 && sub < H) { acc -= ref[sub * 3 + ch]; cnt--; }
      if (r >= 0 && r < H) sm[r * 3 + ch] = acc / Math.max(1, cnt);
    }
  }
  const globalL = (() => {
    let s = 0, c = 0;
    for (let r = 0; r < H; r++) if (rowOk[r]) { s += (ref[r * 3] + ref[r * 3 + 1] + ref[r * 3 + 2]) / 3; c++; }
    return c ? s / c : 0.27;
  })();

  const rand = rng(a * 977 + 13);
  const out = new Uint8Array(W * H * 4);
  for (let r = 0; r < H; r++) {
    const R = sm[r * 3], G = sm[r * 3 + 1], B = sm[r * 3 + 2];
    const refL = (R + G + B) / 3;
    // Shadow evening: pull the row's asphalt brightness toward the stretch's typical value,
    // and the whole stretch toward a real asphalt tone (aerials read pale and hazy).
    const tone = ASPHALT_L / Math.max(0.05, globalL);
    const gain = Math.max(0.75, Math.min(2.2, globalL / Math.max(0.02, refL))) ** 0.85 * tone;
    for (let c = 0; c < W; c++) {
      const o = (r * W + c) * 3;
      let cr = rgb[o], cg = rgb[o + 1], cb = rgb[o + 2];
      const l = (cr + cg + cb) / 3;
      const sum = cr + cg + cb + 1e-4;
      const chromaOff = Math.hypot(cr / sum - R / (refL * 3 + 1e-4), cg / sum - G / (refL * 3 + 1e-4), cb / sum - B / (refL * 3 + 1e-4));
      const notAsphalt = !rowOk[r] || l > refL * 1.3 + 0.05 || l < refL * 0.4 || chromaOff > 0.06;
      if (notAsphalt) {
        // Painted out with the surrounding asphalt.
        cr = R;
        cg = G;
        cb = B;
      }
      // Fine grain: aggregate speckle plus a little coarser mottling.
      const grain = (rand() - 0.5) * 0.07 + (rand() - 0.5) * 0.03;
      const i4 = (r * W + c) * 4;
      out[i4] = Math.max(0, Math.min(255, (cr * gain + grain) * 255));
      out[i4 + 1] = Math.max(0, Math.min(255, (cg * gain + grain) * 255));
      out[i4 + 2] = Math.max(0, Math.min(255, (cb * gain + grain * 1.02) * 255));
      out[i4 + 3] = 255;
    }
  }
  return { rgba: out, width: W, height: H };
}
