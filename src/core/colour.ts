// Colour matching between aerial imagery sources. Some state mosaics carry
// a strong cast (NSW's can make bushland look navy blue), which also fools
// the vegetation tests that find trees. Matching each channel's mean and
// spread to Esri's imagery of the same area keeps the sharper source's
// detail with a natural colour balance.

/** Per-channel out = in * gain + offset, on 0..255 values. */
export interface ColourTransform {
  gain: [number, number, number];
  offset: [number, number, number];
}

function stats(px: Uint8Array | Uint8ClampedArray): { mean: number[]; sd: number[] } | null {
  const sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    for (let k = 0; k < 3; k++) {
      sum[k] += px[i + k];
      sq[k] += px[i + k] * px[i + k];
    }
    n++;
  }
  if (n < 64) return null;
  const mean = sum.map((s) => s / n);
  return { mean, sd: sq.map((s, k) => Math.sqrt(Math.max(1, s / n - mean[k] * mean[k]))) };
}

/** The transform that gives `src` the colour statistics of `ref` (same area, any size). */
export function matchColours(src: Uint8Array | Uint8ClampedArray, ref: Uint8Array | Uint8ClampedArray): ColourTransform | null {
  const a = stats(src), b = stats(ref);
  if (!a || !b) return null;
  const gain = [0, 1, 2].map((k) => Math.max(0.5, Math.min(2, b.sd[k] / a.sd[k]))) as [number, number, number];
  const offset = [0, 1, 2].map((k) => b.mean[k] - a.mean[k] * gain[k]) as [number, number, number];
  return { gain, offset };
}

/** Applies a transform in place (RGBA). */
export function applyColours(px: Uint8Array | Uint8ClampedArray, t: ColourTransform): void {
  for (let i = 0; i < px.length; i += 4) {
    for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, Math.round(px[i + k] * t.gain[k] + t.offset[k])));
  }
}
