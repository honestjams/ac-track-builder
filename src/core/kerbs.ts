// Kerb and gutter, the edge of nearly every Australian town street: a
// concrete gutter beside the asphalt, a 150 mm kerb, then the nature strip.
//
// In town kerbs are the rule, and that is what decides it there: at
// 10-15 cm per pixel a kerb is a faint 0.2 m highlight that faded asphalt
// and footpaths easily drown out. On the edge of town it takes some sign of
// them in the photo, and in the country a clear one: a pale concrete band
// right at the traced asphalt edge, asphalt inside it and grass or gravel
// beyond, in enough rows over 40 m.
//
// Where a kerb is built it replaces the gravel verge on that side. The
// gutter is drivable road, the kerb has its own surface for the physics
// (cars can mount it, as in reality, but feel it), and the nature strip is
// textured from the same aerial photo so footpaths and driveways show.

import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder } from "./mesh";
import type { BuildOptions } from "./options";
import { inRoundabout, surfaceHeight, type RoadPlan, type RoadSample } from "./road";
import { chunkRanges, pad } from "./roadMesh";
import type { RasterSampler } from "./trace";

/** Concrete gutter (channel) width, metres. */
export const GUTTER = 0.3;
/** Kerb height above the gutter lip, metres. */
export const KERB_H = 0.15;
/** Horizontal batter of the kerb face, metres. */
const FACE_RUN = 0.05;
/** Kerb top width, metres. */
const KERB_TOP = 0.15;
/** The gutter falls this much toward the kerb, metres. */
const GUTTER_DIP = 0.03;
/** How much wider than the gravel verge the nature strip runs, metres. */
export const STRIP_EXTRA = 1.5;
const SKIRT = 0.8;
/** The gravel verge's fall from the road edge, which the strip meets where a kerb ends. */
const VERGE_DROP = 0.2;
/** Concrete texture repeats (one pour between joints) every this many metres. */
const POUR = 3;

/** How much of the kerb's height a driveway layback takes away. */
export const LAYBACK = 0.65;

/** Lateral offset of the kerb's back edge (start of the nature strip) from the road edge. */
export const KERB_BACK = GUTTER + FACE_RUN + KERB_TOP;

const DU = 0.05;

/**
 * Photo evidence per sample and side ([left, right]): 1 = a kerb band seen,
 * 0 = looked and none seen, NaN = the road couldn't be read there.
 */
export function kerbEvidence(plan: RoadPlan, raster: RasterSampler, trusted: (i: number) => boolean): [number[], number[]] {
  const out: [number[], number[]] = [[], []];
  for (const [k, sg] of [[0, 1], [1, -1]] as const) {
    for (let i = 0; i < plan.samples.length; i++) {
      if (!trusted(i)) {
        out[k].push(NaN);
        continue;
      }
      out[k].push(kerbAt(plan.samples[i], sg, raster) ? 1 : 0);
    }
  }
  return out;
}

/** Looks across one edge of the road for the kerb and gutter band. */
function kerbAt(s: RoadSample, sg: 1 | -1, raster: RasterSampler): boolean {
  const half = s.width / 2;
  const u0 = half - 1.6, u1 = half + 1.4;
  const n = Math.round((u1 - u0) / DU) + 1;
  const L = new Float32Array(n), S = new Float32Array(n), G = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = (u0 + j * DU) * sg;
    const c = raster(s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t);
    if (!c) return false;
    const [r, g, b] = c;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    L[j] = (r + g + b) / 3;
    S[j] = mx > 0 ? (mx - mn) / mx : 0;
    G[j] = (2 * g - r - b) / (r + g + b + 1e-4);
  }
  // Asphalt brightness from the outer lane, clear of the edge.
  const inner: number[] = [];
  for (let j = 0; u0 + j * DU < half - 0.7; j++) inner.push(L[j]);
  inner.sort((a, b) => a - b);
  const ref = inner[inner.length >> 1];
  if (!(ref > 0.02)) return false;
  const bright = (j: number) => L[j] > ref * 1.25 + 0.03 && S[j] < 0.2 && G[j] < 0.03;
  const asphalt = (j: number) => Math.abs(L[j] / ref - 1) < 0.3 && S[j] < 0.22 && G[j] < 0.04;
  for (let j = 1; j < n;) {
    if (!bright(j)) { j++; continue; }
    let e = j;
    // One dull pixel inside the band (the gutter's dirty invert) doesn't end it.
    while (e < n && (bright(e) || (e + 1 < n && bright(e + 1)))) e++;
    const start = u0 + j * DU, w = (e - j) * DU;
    if (start > half + 0.6) break;
    if (start >= half - 0.8 && w >= 0.1 && w <= 1.2) {
      let inA = 0, inN = 0, outA = 0, outN = 0;
      for (let q = j - 6; q <= j - 2; q++) if (q >= 0) { inN++; if (asphalt(q)) inA++; }
      for (let q = e + 3; q <= e + 12 && q < n; q++) { outN++; if (asphalt(q)) outA++; }
      // Asphalt inside, something else beyond: the edge of the street, not a painted line.
      if (inN && inA / inN >= 0.6 && outN >= 4 && outA / outN < 0.5) return true;
    }
    j = e;
  }
  return false;
}

/**
 * Kerb amount per sample and side, 0 or 1 ([left, right]). Geometry ramps
 * over one section where it changes, so a kerb starts and ends as a slope.
 */
export function planKerbs(
  plan: RoadPlan,
  evidence: [number[], number[]] | null,
  /** How built-up: 2 = town, 1 = edge of town, 0 = country. */
  town: (i: number) => number,
  /** No kerb here (a side street's mouth). */
  blocked: (i: number, side: 1 | -1) => boolean,
): [number[], number[]] {
  const n = plan.samples.length;
  const wrap = (i: number) => (plan.closed ? ((i % n) + n) % n : i);
  const W = 10; // +-20 m at 2 m spacing
  const out: [number[], number[]] = [[], []];
  for (const [k, side] of [[0, 1], [1, -1]] as const) {
    const ev = evidence?.[k];
    const on: boolean[] = [];
    for (let i = 0; i < n; i++) {
      let seen = 0, hits = 0;
      if (ev) {
        for (let d = -W; d <= W; d++) {
          const q = wrap(i + d);
          if (q < 0 || q >= n || Number.isNaN(ev[q])) continue;
          seen++;
          hits += ev[q];
        }
      }
      const frac = seen ? hits / seen : 0;
      // In town kerbs are the rule; the photo can't see them reliably enough
      // to overrule that. On the edge of town it takes some sign of them in
      // the photo, and in the country a clear one.
      const tw = town(i);
      const yes = tw >= 2 || (seen >= 6 && frac >= (tw === 1 ? 0.1 : 0.4));
      on.push(yes && !blocked(i, side) && !inRoundabout(plan, plan.samples[i].pos[0], plan.samples[i].pos[1], 3));
    }
    // Close short gaps (shadows, a parked truck) and drop short stubs.
    const runs = (val: boolean, max: number, set: boolean) => {
      for (let i = 0; i < n;) {
        if (on[i] !== val) { i++; continue; }
        let j = i;
        while (j < n && on[j] === val) j++;
        const bounded = val ? true : i > 0 && j < n;
        if (bounded && j - i < max) {
          for (let q = i; q < j; q++) if (set || !blocked(q, side)) on[q] = set;
        }
        i = j;
      }
    };
    runs(false, 8, true);
    for (let i = 0; i < n; i++) if (blocked(i, side)) on[i] = false;
    runs(true, 8, false);
    out[k] = on.map((v) => (v ? 1 : 0));
  }
  return out;
}

export interface KerbMeshes {
  gutter: Kn5MeshNode[];
  kerb: Kn5MeshNode[];
  strip: Kn5MeshNode[];
}

/**
 * Picks the nature strip material for chunk `ci` (sections a..b). With
 * `photo`, u runs across both strips (left outer edge 0 to 0.5 at the left
 * kerb, right kerb 0.5 to right outer edge 1) and v along the chunk.
 */
export type StripMaterialFn = (ci: number, a: number, b: number) => { material: string; photo: boolean };

type Seg = { mesh: "gutter" | "kerb" | "strip"; a: [number, number]; b: [number, number]; ua: number; ub: number };

/** The kerb cross-section on one side, left to right, as (t, z) pairs. */
function profile(s: RoadSample, side: 1 | -1, k: number, opts: BuildOptions, photo: boolean, drop = 0): Seg[] {
  const half = s.width / 2;
  const e = surfaceHeight(s, half * side, opts.crown);
  // At a driveway the kerb is laid back: lower, with a long gentle face.
  const top = e + KERB_H * k * (1 - LAYBACK * drop), inv = e - GUTTER_DIP * k;
  const full = e + KERB_H * k;
  // The strip keeps its width where a kerb starts or ends and slopes down to verge level instead.
  const tOut = half + opts.vergeWidth + STRIP_EXTRA;
  const zOut = full + 0.02 * k - VERGE_DROP * (1 - k);
  const tIn = half + KERB_BACK * k, tFace = half + (GUTTER + FACE_RUN + (KERB_TOP - 0.02) * drop) * k, tLip = half + GUTTER * k;
  // Photo u for the strip: left strip 0..0.5 (outer to kerb), right 0.5..1 (kerb to outer).
  const uOut = photo ? (side === 1 ? 0 : 1) : 0, uIn = photo ? 0.5 : (opts.vergeWidth + STRIP_EXTRA - KERB_BACK) / 4;
  const segs: Seg[] = [
    { mesh: "strip", a: [tOut, zOut - SKIRT], b: [tOut, zOut], ua: uOut, ub: uOut },
    { mesh: "strip", a: [tOut, zOut], b: [tIn, top], ua: uOut, ub: uIn },
    { mesh: "kerb", a: [tIn, top], b: [tFace, top], ua: 0, ub: 0.25 },
    { mesh: "kerb", a: [tFace, top], b: [tLip, inv], ua: 0.25, ub: 0.5 },
    { mesh: "gutter", a: [tLip, inv], b: [half, e], ua: 0.5, ub: 1 },
  ];
  if (side === 1) return segs;
  // Right side: mirror, then reverse so it still runs left to right.
  return segs.reverse().map((g) => ({ ...g, a: [-g.b[0], g.b[1]], b: [-g.a[0], g.a[1]], ua: g.ub, ub: g.ua }));
}

export function buildKerbs(
  plan: RoadPlan,
  opts: BuildOptions,
  kerb: [number[], number[]],
  stripMaterial: StripMaterialFn,
  /** Sections (`${i}:${side}`, from sample i to i + 1) whose start or end slope a kerb return replaces. */
  noRamp: Set<string> = new Set(),
  /** Laybacks: 1 where a driveway crosses the kerb, per sample and side ([left, right]). */
  drops?: [number[], number[]],
): KerbMeshes {
  const samples = plan.samples;
  const n = samples.length;
  const at = (i: number) => samples[i % n];
  const sAt = (i: number) => (i >= n ? plan.length : samples[i].s);
  const out: KerbMeshes = { gutter: [], kerb: [], strip: [] };
  chunkRanges(plan).forEach(([a, b], ci) => {
    let any = false;
    for (let i = a; i <= b && !any; i++) any = kerb[0][i % n] > 0 || kerb[1][i % n] > 0;
    if (!any) return;
    const strip = stripMaterial(ci, a, b);
    const sa = sAt(a), sb = sAt(b);
    const builders = { gutter: new MeshBuilder(), kerb: new MeshBuilder(), strip: new MeshBuilder() };
    for (const [k, side] of [[0, 1], [1, -1]] as const) {
      let here = false;
      for (let i = a; i <= b && !here; i++) here = kerb[k][i % n] > 0;
      if (!here) continue;
      // Each segment of the profile is its own ribbon, so creases stay sharp.
      const rows = [] as { segs: Seg[]; v: number; vs: number }[];
      for (let i = a; i <= b; i++) {
        rows.push({ segs: profile(at(i), side, kerb[k][i % n], opts, strip.photo, drops?.[k][i % n] ?? 0), v: sAt(i) / POUR, vs: strip.photo ? (sAt(i) - sa) / Math.max(1e-6, sb - sa) : sAt(i) / 4 });
      }
      const nSeg = rows[0].segs.length;
      for (let g = 0; g < nSeg; g++) {
        const mesh = rows[0].segs[g].mesh;
        const mb = builders[mesh];
        const base = mb.vertexCount;
        rows.forEach((row, r) => {
          const sg = row.segs[g], s = at(a + r);
          const v = mesh === "strip" ? row.vs : row.v;
          for (const [[t, z], u] of [[sg.a, sg.ua], [sg.b, sg.ub]] as const) {
            mb.vertex([s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t, z], u, v);
          }
        });
        for (let r = 0; r < rows.length - 1; r++) {
          const i = a + r;
          if (!(kerb[k][i % n] > 0 || kerb[k][(i + 1) % n] > 0)) continue;
          if (noRamp.has(`${i % n}:${side}`)) continue;
          const p = base + r * 2, q = p + 2;
          mb.quad(p, p + 1, q + 1, q);
        }
      }
    }
    const id = pad(ci);
    if (builders.gutter.indices.length) out.gutter.push(builders.gutter.toKn5(`1ROAD_GUTTER_${id}`, "concrete"));
    if (builders.kerb.indices.length) out.kerb.push(builders.kerb.toKn5(`1KERB_${id}`, "concrete"));
    if (builders.strip.indices.length) out.strip.push(builders.strip.toKn5(`1GRASS_STRIP_${id}`, strip.material));
  });
  return out;
}

/**
 * Aerial photo of both nature strips along sections a..b, for the strip
 * mesh's photo UVs: 32 px per side, left strip outer edge to kerb, then
 * right kerb to outer edge.
 */
export function stripPhotoTexture(plan: RoadPlan, raster: RasterSampler, opts: BuildOptions, a: number, b: number, H = 2048): { rgba: Uint8Array; width: number; height: number } {
  const W = 64, half = W / 2;
  const samples = plan.samples;
  const n = samples.length;
  const sAt = (i: number) => (i >= n ? plan.length : samples[i].s);
  const sa = sAt(a), sb = sAt(b);
  const rgba = new Uint8Array(W * H * 4);
  const span = opts.vergeWidth + STRIP_EXTRA - KERB_BACK;
  let i = a;
  for (let y = 0; y < H; y++) {
    const s = sa + ((y + 0.5) / H) * (sb - sa);
    while (i < b - 1 && sAt(i + 1) <= s) i++;
    const p = samples[i % n], q = samples[(i + 1) % n];
    const f = Math.max(0, Math.min(1, (s - sAt(i)) / Math.max(1e-6, sAt(i + 1) - sAt(i))));
    const px = p.pos[0] + (q.pos[0] - p.pos[0]) * f, py = p.pos[1] + (q.pos[1] - p.pos[1]) * f;
    const hw = (p.width + (q.width - p.width) * f) / 2;
    for (let x = 0; x < W; x++) {
      // Left half: outer (x = 0) to kerb; right half: kerb to outer.
      const t = x < half
        ? hw + KERB_BACK + span * (1 - (x + 0.5) / half)
        : -(hw + KERB_BACK + span * ((x - half + 0.5) / half));
      const c = raster(px + p.left[0] * t, py + p.left[1] * t) ?? [0.33, 0.4, 0.24];
      const o = (y * W + x) * 4;
      rgba[o] = c[0] * 255;
      rgba[o + 1] = c[1] * 255;
      rgba[o + 2] = c[2] * 255;
      rgba[o + 3] = 255;
    }
  }
  return { rgba, width: W, height: H };
}

/** Radius of a kerb return round the corner of a side street's mouth, metres. */
export const RETURN_R = 4;

/**
 * Kerb returns: where a kerbed road meets a side street, the kerb curves
 * round the corner into it on a 4 m radius, instead of stopping short. A
 * small fan of asphalt fills the corner between the curve and the two
 * road edges. Only for side streets meeting the road at about right angles.
 */
export function buildKerbReturns(
  plan: RoadPlan,
  opts: BuildOptions,
  junctions: { seg: number; side: 1 | -1; width: number; dir: [number, number] }[],
  kerb: [number[], number[]],
  fillMaterial: string,
  /** The aerial photo: the strips inside the returns are textured from it (one atlas cell per corner). */
  photo?: RasterSampler,
  /**
   * Where the side street is kerbed too: its edge on the corner's side
   * (corner c = -1 before the mouth, 1 after), from R metres in from the
   * road's edge, as points with the street surface height there and the
   * direction away from the street. The return then runs on along it.
   */
  streetEdge?: (j: number, c: -1 | 1, R: number) => { pos: [number, number]; out: [number, number]; z: number }[] | null,
  /** Photo for the strips along side streets (they reach beyond the route photo): one atlas column per run. */
  streetPhoto?: RasterSampler,
): {
  nodes: Kn5MeshNode[];
  noRamp: Set<string>;
  atlas?: { rgba: Uint8Array; width: number; height: number };
  sideAtlas?: { rgba: Uint8Array; width: number; height: number };
} {
  const SIDE_W = 32, SIDE_H = 512, SIDE_COLS = 64;
  const sideAtlas = streetPhoto ? new Uint8Array(SIDE_W * SIDE_COLS * SIDE_H * 4) : undefined;
  let sideRuns = 0;
  const noRamp = new Set<string>();
  const CELL = 64, PER_ROW = 16, ATLAS = CELL * PER_ROW;
  const atlas = photo ? new Uint8Array(ATLAS * ATLAS * 4) : undefined;
  let cells = 0;
  const n = plan.samples.length;
  const spacing = n > 1 ? plan.samples[1].s - plan.samples[0].s : 2;
  const gutter = new MeshBuilder(), kb = new MeshBuilder(), strip = new MeshBuilder(), fill = new MeshBuilder();
  // Along side streets: their gutter is street, not route; the strip is photo where the atlas has room, else grass.
  const sideGutter = new MeshBuilder(), sideStrip = new MeshBuilder(), sideGrass = new MeshBuilder();
  const STEPS = 8;
  junctions.forEach((j, ji) => {
    const s = plan.samples[j.seg];
    const side = j.side, k = side === 1 ? 0 : 1;
    const v: [number, number] = [s.left[0] * side, s.left[1] * side], u = s.tan;
    if (j.dir[0] * v[0] + j.dir[1] * v[1] < 0.8) return; // oblique: leave it square
    if (inRoundabout(plan, s.pos[0], s.pos[1], 15)) return;
    const half = s.width / 2, e = surfaceHeight(s, half * side, opts.crown);
    const O: [number, number] = [s.pos[0] + v[0] * half, s.pos[1] + v[1] * half];
    for (const c of [-1, 1] as const) {
      // The return starts where the road's own kerb reaches full height on this side of the mouth.
      let first = j.seg + c * Math.ceil(j.width / 2 / spacing);
      while (first >= 0 && first < n && !(kerb[k][first] > 0) && Math.abs(first - j.seg) * spacing < j.width / 2 + 3 * RETURN_R) first += c;
      if (first < 0 || first >= n || !(kerb[k][first] > 0)) continue;
      const R = Math.abs(plan.samples[first].s - s.s) - j.width / 2;
      if (R < 2 || R > 3 * RETURN_R) continue;
      // The road kerb's slope down toward the mouth is replaced by the return.
      noRamp.add(`${c > 0 ? first - 1 : first}:${side}`);
      const C: [number, number] = [O[0] + u[0] * c * (j.width / 2 + R) + v[0] * R, O[1] + u[1] * c * (j.width / 2 + R) + v[1] * R];
      const A: [number, number] = [O[0] + u[0] * c * j.width / 2, O[1] + u[1] * c * j.width / 2];
      // Point on the circle at angle th (0 on the road's edge, 90 degrees on the side street's) and radius r.
      const at = (th: number, r: number): [number, number] => {
        const dx = -v[0] * Math.cos(th) - u[0] * c * Math.sin(th), dy = -v[1] * Math.cos(th) - u[1] * c * Math.sin(th);
        return [C[0] + dx * r, C[1] + dy * r];
      };
      // This corner's square of photo (centre +-R) in its atlas cell; strip UVs map into it.
      const cell = atlas && cells < PER_ROW * PER_ROW ? cells++ : -1;
      const cx = cell % PER_ROW, cy = Math.floor(cell / PER_ROW);
      if (atlas && cell >= 0) {
        for (let py = 0; py < CELL; py++) {
          for (let px = 0; px < CELL; px++) {
            const wx = C[0] - R + ((px + 0.5) / CELL) * 2 * R, wy = C[1] + R - ((py + 0.5) / CELL) * 2 * R;
            const col = photo!(wx, wy) ?? [0.33, 0.4, 0.24];
            const o = ((cy * CELL + py) * ATLAS + cx * CELL + px) * 4;
            atlas[o] = col[0] * 255;
            atlas[o + 1] = col[1] * 255;
            atlas[o + 2] = col[2] * 255;
            atlas[o + 3] = 255;
          }
        }
      }
      const uvOf = (p: [number, number]): [number, number] => cell < 0 ? [0, 0] : [
        (cx + (p[0] - (C[0] - R)) / (2 * R)) / PER_ROW,
        (cy + ((C[1] + R) - p[1]) / (2 * R)) / PER_ROW,
      ];
      // The kerb slopes away over the last quarter of the curve, where the side street begins, unless it carries on along it.
      const edge = streetEdge?.(ji, c, R) ?? null;
      const kAt = (q: number) => (edge && edge.length > 1 ? 1 : Math.min(1, (1 - q) / 0.25));
      const profile = (q: number) => {
        const kk = kAt(q);
        const top = e + KERB_H * kk;
        return [
          { mb: gutter, r0: R, z0: e, r1: R - GUTTER * kk, z1: e - GUTTER_DIP * kk },
          { mb: kb, r0: R - GUTTER * kk, z1: top, r1: R - (GUTTER + FACE_RUN) * kk, z0: e - GUTTER_DIP * kk },
          { mb: kb, r0: R - (GUTTER + FACE_RUN) * kk, z0: top, r1: R - KERB_BACK * kk, z1: top },
          { mb: strip, r0: R - KERB_BACK * kk, z0: top, r1: 1, z1: top + 0.02 },
        ];
      };
      for (let q = 0; q < STEPS; q++) {
        const qa = q / STEPS, qb = (q + 1) / STEPS;
        const ta = qa * Math.PI / 2, tb = qb * Math.PI / 2;
        const pa = profile(qa), pb = profile(qb);
        pa.forEach((g, gi) => {
          const h = pb[gi];
          const i = g.mb.vertexCount;
          const vv = (th: number) => (th * R) / POUR;
          const put = (th: number, r: number, z: number, u: number) => {
            const p = at(th, r);
            const [pu, pv] = g.mb === strip && cell >= 0 ? uvOf(p) : [u, vv(th)];
            g.mb.vertex([...p, z], pu, pv);
          };
          put(ta, g.r0, g.z0, 0);
          put(ta, g.r1, g.z1, 1);
          put(tb, h.r1, h.z1, 1);
          put(tb, h.r0, h.z0, 0);
          // The kerb face looks out of the curve, at the road; everything else faces up.
          const mid = at((ta + tb) / 2, R);
          facingQuad(g.mb, i, gi === 1 ? [mid[0] - C[0], mid[1] - C[1], 0.3] : [0, 0, 1]);
        });
        // Asphalt between the corner of the two road edges and the curve.
        const i = fill.vertexCount;
        fill.vertex([...A, e - 0.01], 0, 0);
        fill.vertex([...at(ta, R), e - 0.01], 1, 0);
        fill.vertex([...at(tb, R), e - 0.01], 1, 1);
        upTri(fill, i);
      }
      if (edge && edge.length > 1) {
        const col = sideAtlas && sideRuns < SIDE_COLS ? sideRuns++ : -1;
        if (col >= 0) paintRun(edge, streetPhoto!, sideAtlas!, col, SIDE_W, SIDE_H, SIDE_COLS);
        alongStreet(edge, { gutter: sideGutter, kb, strip: col >= 0 ? sideStrip : sideGrass }, col >= 0 ? { col, cols: SIDE_COLS } : undefined);
      }
    }
  });
  const nodes: Kn5MeshNode[] = [];
  if (gutter.indices.length) nodes.push(gutter.toKn5("1ROAD_GUTTER_RET", "concrete"));
  if (kb.indices.length) nodes.push(kb.toKn5("1KERB_RET", "concrete"));
  if (strip.indices.length) nodes.push(strip.toKn5("1GRASS_STRIP_RET", atlas && cells ? "returns_photo" : "grass"));
  if (fill.indices.length) nodes.push(fill.toKn5("1STREET_RETFILL", fillMaterial));
  if (sideGutter.indices.length) nodes.push(sideGutter.toKn5("1STREET_GUTTER_SIDE", "concrete"));
  if (sideStrip.indices.length) nodes.push(sideStrip.toKn5("1GRASS_STRIP_SIDE", "sidestrips_photo"));
  if (sideGrass.indices.length) nodes.push(sideGrass.toKn5("1GRASS_STRIP_SIDEG", "grass"));
  return {
    nodes,
    noRamp,
    atlas: atlas && cells ? { rgba: atlas, width: ATLAS, height: ATLAS } : undefined,
    sideAtlas: sideAtlas && sideRuns ? { rgba: sideAtlas, width: SIDE_W * SIDE_COLS, height: SIDE_H } : undefined,
  };
}

/**
 * Kerb along a side street's edge: the same gutter, kerb and strip as the
 * road's, sloping away over the last 4 m.
 */
const SIDE_STRIP = 2;

/** One run's strip (kerb back to 2 m beyond, along the run) painted from the photo into atlas column `col`. */
function paintRun(edge: { pos: [number, number]; out: [number, number] }[], photo: RasterSampler, atlas: Uint8Array, col: number, W: number, H: number, cols: number): void {
  const dist = [0];
  for (let i = 1; i < edge.length; i++) dist.push(dist[i - 1] + Math.hypot(edge[i].pos[0] - edge[i - 1].pos[0], edge[i].pos[1] - edge[i - 1].pos[1]));
  const total = dist[dist.length - 1] || 1;
  let i = 0;
  for (let y = 0; y < H; y++) {
    const d = ((y + 0.5) / H) * total;
    while (i < edge.length - 2 && dist[i + 1] < d) i++;
    const f = Math.max(0, Math.min(1, (d - dist[i]) / Math.max(1e-6, dist[i + 1] - dist[i])));
    const a = edge[i], b = edge[i + 1];
    const px = a.pos[0] + (b.pos[0] - a.pos[0]) * f, py = a.pos[1] + (b.pos[1] - a.pos[1]) * f;
    for (let x = 0; x < W; x++) {
      const o = KERB_BACK + ((x + 0.5) / W) * SIDE_STRIP;
      const c = photo(px + a.out[0] * o, py + a.out[1] * o) ?? [0.33, 0.4, 0.24];
      const k = (y * W * cols + col * W + x) * 4;
      atlas[k] = c[0] * 255;
      atlas[k + 1] = c[1] * 255;
      atlas[k + 2] = c[2] * 255;
      atlas[k + 3] = 255;
    }
  }
}

function alongStreet(
  edge: { pos: [number, number]; out: [number, number]; z: number }[],
  mb: { gutter: MeshBuilder; kb: MeshBuilder; strip: MeshBuilder },
  /** The strip's atlas column, when it has one. */
  photo?: { col: number; cols: number },
): void {
  const dist = [0];
  for (let i = 1; i < edge.length; i++) dist.push(dist[i - 1] + Math.hypot(edge[i].pos[0] - edge[i - 1].pos[0], edge[i].pos[1] - edge[i - 1].pos[1]));
  const total = dist[dist.length - 1];
  const row = (i: number) => {
    const { pos, out, z: e } = edge[i];
    const k = Math.max(0, Math.min(1, (total - dist[i]) / 4));
    const top = e + KERB_H * k;
    const p = (o: number): [number, number] => [pos[0] + out[0] * o, pos[1] + out[1] * o];
    return [
      { mb: mb.gutter, a: p(0), za: e, b: p(GUTTER * k), zb: e - GUTTER_DIP * k },
      { mb: mb.kb, a: p(GUTTER * k), za: e - GUTTER_DIP * k, b: p((GUTTER + FACE_RUN) * k), zb: top },
      { mb: mb.kb, a: p((GUTTER + FACE_RUN) * k), za: top, b: p(KERB_BACK * k), zb: top },
      { mb: mb.strip, a: p(KERB_BACK * k), za: top, b: p(KERB_BACK + SIDE_STRIP), zb: top + 0.02 },
    ];
  };
  for (let i = 0; i < edge.length - 1; i++) {
    const ra = row(i), rb = row(i + 1);
    ra.forEach((g, gi) => {
      const h = rb[gi];
      const q = g.mb.vertexCount;
      // The strip maps into its atlas column (u across, v along the run); the rest tiles.
      const atlasUV = photo && gi === 3;
      const u0 = atlasUV ? photo.col / photo.cols : 0, u1 = atlasUV ? (photo.col + 1) / photo.cols : 1;
      const va = atlasUV ? dist[i] / total : dist[i] / POUR, vb = atlasUV ? dist[i + 1] / total : dist[i + 1] / POUR;
      g.mb.vertex([...g.a, g.za], u0, va);
      g.mb.vertex([...g.b, g.zb], u1, va);
      g.mb.vertex([...h.b, h.zb], u1, vb);
      g.mb.vertex([...h.a, h.za], u0, vb);
      // The kerb face looks back at the street; everything else faces up.
      const o = edge[i].out;
      facingQuad(g.mb, q, gi === 1 ? [-o[0], -o[1], 0.3] : [0, 0, 1]);
    });
  }
}

/** Quad from four vertices starting at i, wound so its normal leans toward `want`. */
function facingQuad(mb: MeshBuilder, i: number, want: [number, number, number]): void {
  const p = mb.positions, o = i * 3;
  const a = [p[o + 3] - p[o], p[o + 4] - p[o + 1], p[o + 5] - p[o + 2]];
  const b = [p[o + 6] - p[o], p[o + 7] - p[o + 1], p[o + 8] - p[o + 2]];
  const nrm = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  if (nrm[0] * want[0] + nrm[1] * want[1] + nrm[2] * want[2] >= 0) mb.quad(i, i + 1, i + 2, i + 3);
  else mb.quad(i, i + 3, i + 2, i + 1);
}

function upTri(mb: MeshBuilder, i: number): void {
  const p = mb.positions;
  const ax = p[(i + 1) * 3] - p[i * 3], ay = p[(i + 1) * 3 + 1] - p[i * 3 + 1];
  const bx = p[(i + 2) * 3] - p[i * 3], by = p[(i + 2) * 3 + 1] - p[i * 3 + 1];
  if (ax * by - ay * bx >= 0) mb.tri(i, i + 1, i + 2);
  else mb.tri(i, i + 2, i + 1);
}
