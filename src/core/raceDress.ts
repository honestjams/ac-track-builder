// Race-day dressing: what a real street turns into for a race weekend (the
// Gold Coast 500, Adelaide, Townsville), kept to the places that matter so
// the rest of the street stays as it is:
//
//  - the start/finish straight: concrete barriers both sides with a debris
//    fence on top and sponsor banners along it, an overhead start gantry
//    with lights (a chequered one at a separate finish), a grandstand full
//    of people where there's room, spectators along the fence, and feather
//    flags;
//  - the outside of each tight corner: barriers pulled back behind a wall
//    of tyres, and a marshal post with a flag at the entry.
//
// Side streets stay open: barriers stop either side of a junction. Sponsors
// are a list of names; known Australian motorsport brands get their colours
// as wordmarks (no logos).

import { ArtList } from "./art";
import { sponsors } from "./sponsors";
import type { HeightFn } from "./elevation";
import type { Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import type { Piece } from "./furniture";
import { KERB_BACK } from "./kerbs";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { encodePng } from "./png";
import { inRoundabout, surfaceHeight, type RoadPlan, type RoadSample } from "./road";
import { pad } from "./roadMesh";
import { ChunkedMesh, rng } from "./scenery";
import { fill, valueNoise } from "./textures";

/* ---------------- textures ---------------- */

/** Concrete barrier, 3.6 m blocks (the joint at the texture edge) by the profile's height. */
export function barrierConcreteTexture(): Uint8Array {
  const w = 256, h = 64;
  const r = rng(501), stain = valueNoise(w, h, 6, 502);
  return encodePng(fill(w, h, (x, y, i) => {
    if (x < 2) return [96, 96, 94];
    const n = (r() - 0.5) * 10, k = 0.9 + stain[i] * 0.12 - (y > 54 ? 0.12 : 0);
    return [218 * k + n, 216 * k + n, 210 * k + n];
  }), w, h, { alpha: false });
}

/** Debris fence: galvanised diamond mesh, 1 m square, cut out by alpha. */
export function catchFenceTexture(): Uint8Array {
  const w = 128, h = 128;
  const px = fill(w, h, () => [168, 172, 170]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = (x + y) % 16, b = (x - y + 128) % 16;
      const wire = a < 1.6 || b < 1.6 || y < 3;
      px[(y * w + x) * 4 + 3] = wire ? 255 : 0;
    }
  }
  return encodePng(px, w, h);
}

/** A wall of tyres seen from the front: 0.6 m columns of stacked tyres, 1 m by 0.8 m. */
export function tyreWallTexture(): Uint8Array {
  const w = 128, h = 104;
  const r = rng(511);
  return encodePng(fill(w, h, (x, y) => {
    const col = Math.floor(x / 64), tyre = Math.floor(y / 26);
    const u = (x % 64) / 64, v = (y % 26) / 26;
    // Each tyre's tread is rounded: dark at its top and bottom edge.
    const k = 0.45 + 0.55 * Math.sin(v * Math.PI) * (0.85 + 0.15 * Math.sin(u * Math.PI));
    const painted = (col + tyre) % 4 === 0;
    const n = (r() - 0.5) * 8;
    if (u < 0.03 || u > 0.97) return [14, 14, 14];
    return painted ? [210 * k + n, 210 * k + n, 206 * k + n] : [40 * k + n, 40 * k + n, 42 * k + n];
  }), w, h, { alpha: false });
}

/**
 * Spectators, cut out by alpha. Seated: heads and shoulders above the seat
 * in front, 1 m tall. Standing: whole figures, 1.8 m. 12 m of people a tile,
 * shirts in every colour, a few hats, some empty seats.
 */
export function crowdTexture(standing: boolean): Uint8Array {
  const w = 1024, h = standing ? 160 : 96;
  const mPerPx = 12 / w, scale = h / (standing ? 1.85 : 1);
  const r = rng(standing ? 521 : 522);
  const px = new Uint8Array(w * h * 4);
  const skin: [number, number, number][] = [[234, 192, 160], [214, 166, 128], [176, 124, 90], [120, 82, 58], [92, 62, 44]];
  const put = (x: number, y: number, c: [number, number, number]) => {
    const xi = ((Math.round(x) % w) + w) % w, yi = Math.round(y);
    if (yi < 0 || yi >= h) return;
    px.set([c[0], c[1], c[2], 255], (yi * w + xi) * 4);
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, c: [number, number, number]) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) put(x, y, c);
      }
    }
  };
  const rect = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number]) => {
    for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) put(x, y, c);
  };
  const spacing = (standing ? 0.55 : 0.5) / mPerPx;
  for (let x = spacing / 2; x < w; x += spacing * (0.85 + r() * 0.3)) {
    if (!standing && r() < 0.12) continue; // an empty seat
    const shirt: [number, number, number] = r() < 0.25 ? [30 + r() * 40, 40 + r() * 40, 90 + r() * 80] : r() < 0.15 ? [230, 230, 228] : [60 + r() * 190, 50 + r() * 160, 40 + r() * 160];
    const face = skin[Math.floor(r() * skin.length)];
    const hair: [number, number, number] = r() < 0.6 ? [40 + r() * 30, 30 + r() * 20, 20] : [170 + r() * 60, 140 + r() * 50, 80];
    const tall = 0.92 + r() * 0.16;
    const cx = x + (r() - 0.5) * spacing * 0.2;
    const ground = h - 1;
    const headR = 0.125 * scale, shoulder = 0.22 * scale, arm = 0.075 * scale;
    // Standing: head at ~1.6 m; seated: at ~0.8 m above the seat in front's top.
    const headY = standing ? ground - 1.6 * tall * scale : ground - 0.74 * scale;
    const top = headY + headR * 1.25; // shoulders
    const waist = standing ? ground - 0.92 * tall * scale : ground;
    if (standing) {
      const legs: [number, number, number] = r() < 0.5 ? [50 + r() * 20, 60 + r() * 20, 90 + r() * 30] : [200 * r() + 30, 180 * r() + 30, 140 * r() + 30];
      rect(cx - shoulder * 0.62, waist, cx - 1, ground, legs);
      rect(cx + 1, waist, cx + shoulder * 0.62, ground, legs);
    }
    // Torso with rounded shoulders, and arms: down at the sides, or one up waving.
    rect(cx - shoulder * 0.82, top + shoulder * 0.25, cx + shoulder * 0.82, waist, shirt);
    ellipse(cx, top + shoulder * 0.28, shoulder * 0.82, shoulder * 0.3, shirt);
    const wave = r() < 0.18;
    for (const sgn of [-1, 1]) {
      const ax = cx + sgn * (shoulder * 0.82 + arm / 2);
      if (wave && sgn === 1) {
        rect(ax - arm / 2, top - 0.5 * scale, ax + arm / 2, top + shoulder * 0.3, face);
        rect(ax - arm / 2, top - 0.05 * scale, ax + arm / 2, top + shoulder * 0.4, shirt);
      } else {
        const len = standing ? 0.62 * scale : 0.4 * scale;
        rect(ax - arm / 2, top + shoulder * 0.2, ax + arm / 2, Math.min(ground, top + len), shirt);
        rect(ax - arm / 2, Math.min(ground, top + len * 0.45), ax + arm / 2, Math.min(ground, top + len), face);
      }
    }
    rect(cx - headR * 0.4, headY + headR * 0.6, cx + headR * 0.4, top + shoulder * 0.3, face); // neck
    ellipse(cx, headY, headR * 0.85, headR, face);
    if (r() < 0.25) {
      // A cap or a broad-brimmed hat.
      const hat: [number, number, number] = [r() * 220, r() * 200, r() * 200];
      rect(cx - headR * 1.4, headY - headR * 0.9, cx + headR * 1.4, headY - headR * 0.5, hat);
      rect(cx - headR * 0.9, headY - headR * 1.4, cx + headR * 0.9, headY - headR * 0.6, hat);
    } else {
      rect(cx - headR * 0.85, headY - headR, cx + headR * 0.85, headY - headR * 0.35, hair);
    }
  }
  return encodePng(px, w, h);
}

/* ---------------- placement ---------------- */

export interface RaceContext {
  /** Something already there: a building, a side street, another stretch of the route. */
  blocked: (x: number, y: number) => boolean;
  ground: HeightFn;
}

export interface RaceDressing {
  /** Banners, flags, gantry faces and posts (drawn with the sign art). */
  pieces: Piece[];
  /** Barriers, fences, tyre walls, the grandstand and the crowds. */
  nodes: Kn5MeshNode[];
  stats: { barrierMetres: number; grandstand: boolean; spectators: number };
}

interface Zone {
  s0: number;
  s1: number;
  side: 1 | -1;
  /** Tyre wall in front of the barrier from tyre0 to tyre1 (a corner). */
  tyres?: [number, number];
}

const BARRIER_H = 0.82;
/** The barrier's cross-section: metres back from its road face, metres up. */
const PROFILE: [number, number][] = [[0, 0], [0.06, 0.08], [0.18, 0.3], [0.2, BARRIER_H], [0.42, BARRIER_H], [0.44, 0.3], [0.56, 0.08], [0.62, 0]];
const FENCE_H = 2.8;
const TYRES = 0.75; // depth of the tyre wall

function sampleAt(plan: RoadPlan, s: number): RoadSample {
  const a = plan.samples;
  const L = plan.length;
  if (plan.closed) s = ((s % L) + L) % L;
  else s = Math.max(0, Math.min(a[a.length - 1].s, s));
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  return a[lo];
}

/** The start/finish straight and the outside of every tight corner. */
export function raceZones(plan: RoadPlan): Zone[] {
  const sStart = plan.samples[plan.timed?.start ?? 0].s;
  const zones: Zone[] = [];
  for (const side of [1, -1] as const) zones.push({ s0: sStart - 50, s1: sStart + 220, side });
  if (plan.timed) {
    const sFinish = plan.samples[plan.timed.finish].s;
    if (Math.abs(sFinish - sStart) > 320) for (const side of [1, -1] as const) zones.push({ s0: sFinish - 150, s1: sFinish + 40, side });
  }
  // Corners tighter than a 45 m radius (and tighter than 35 m somewhere), not roundabouts.
  const tight = plan.samples.map((s) => Math.abs(s.curvature) > 1 / 45 && !inRoundabout(plan, s.pos[0], s.pos[1], 4));
  let i = 0;
  while (i < plan.samples.length) {
    if (!tight[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < plan.samples.length && (tight[j + 1] || (j + 6 < plan.samples.length && tight.slice(j + 1, j + 6).some(Boolean)))) j++;
    const run = plan.samples.slice(i, j + 1);
    const apex = run.reduce((a, b) => (Math.abs(b.curvature) > Math.abs(a.curvature) ? b : a));
    const turn = run.reduce((a, b) => a + b.curvature, 0);
    if (Math.abs(apex.curvature) > 1 / 35) {
      zones.push({ s0: run[0].s - 35, s1: run[run.length - 1].s + 25, side: turn > 0 ? -1 : 1, tyres: [apex.s - 15, apex.s + 30] });
    }
    i = j + 1;
  }
  return zones;
}

export function raceDressing(plan: RoadPlan, opts: BuildOptions, art: ArtList, ctx: RaceContext, sponsorList: string): RaceDressing {
  const brands = sponsors(sponsorList);
  const brandArt = brands.map((b, k) => ({
    banner: art.add({ key: `banner:${k}`, kind: "banner", text: b.name, colour: b.bg, ink: b.ink }),
    feather: art.add({ key: `feather:${k}`, kind: "feather", text: b.name, colour: b.bg, ink: b.ink }),
  }));
  let nextBrand = 0;
  const brand = () => brandArt[nextBrand++ % Math.max(1, brandArt.length)];
  const pieces: Piece[] = [];
  const barrier = new ChunkedMesh(0), fence = new ChunkedMesh(0), tyres = new ChunkedMesh(0);
  const crowd = new ChunkedMesh(0), standing = new ChunkedMesh(0), stand = new ChunkedMesh(0);
  let barrierMetres = 0, spectators = 0;

  /** How far behind the road edge the barrier's face is: just behind the kerb, or on the gravel verge. */
  const baseOffset = (s: RoadSample, side: 1 | -1) => ((s.kerb?.[side === 1 ? 0 : 1] ?? 0) > 0 ? KERB_BACK + 0.25 : 0.9);
  const edgeZ = (s: RoadSample, side: 1 | -1) => surfaceHeight(s, side * s.width / 2, opts.crown);

  // Barrier runs: walk each zone every 2 m, break where something's in the way.
  type Pt = { p: Vec2; out: Vec2; z: number; s: number; sample: RoadSample };
  const runs: { pts: Pt[]; zone: Zone }[] = [];
  for (const zone of raceZones(plan)) {
    let cur: Pt[] = [];
    const flush = () => {
      if (cur.length >= 4) runs.push({ pts: cur, zone });
      cur = [];
    };
    for (let s = zone.s0; s <= zone.s1; s += 2) {
      if (!plan.closed && (s < 0 || s > plan.length)) {
        flush();
        continue;
      }
      const smp = sampleAt(plan, s);
      const side = zone.side;
      const tyresHere = zone.tyres && s >= zone.tyres[0] && s <= zone.tyres[1];
      const t = side * (smp.width / 2 + baseOffset(smp, side) + (zone.tyres ? TYRES + 0.1 : 0));
      const p: Vec2 = [smp.pos[0] + smp.left[0] * t, smp.pos[1] + smp.left[1] * t];
      const out: Vec2 = [smp.left[0] * side, smp.left[1] * side];
      const back: Vec2 = [p[0] + out[0] * 0.62, p[1] + out[1] * 0.62];
      const front: Vec2 = tyresHere ? [p[0] - out[0] * TYRES, p[1] - out[1] * TYRES] : p;
      if (inRoundabout(plan, p[0], p[1], 2) || ctx.blocked(p[0], p[1]) || ctx.blocked(back[0], back[1]) || ctx.blocked(front[0], front[1])) {
        flush();
        continue;
      }
      const z = Math.max(ctx.ground(p[0], p[1]), edgeZ(smp, side)) - 0.05;
      // (Past the ends of the road the samples repeat: no zero-length steps.)
      const prev = cur[cur.length - 1];
      if (!prev || Math.hypot(p[0] - prev.p[0], p[1] - prev.p[1]) > 0.3) cur.push({ p, out, z, s, sample: smp });
    }
    flush();
  }

  for (const { pts, zone } of runs) {
    const mb = barrier.next(pts.length * PROFILE.length * 4);
    // The barrier: the profile swept along the run. u counts 3.6 m blocks.
    let along = 0;
    const base = mb.vertexCount;
    pts.forEach((pt, i) => {
      if (i) along += Math.hypot(pt.p[0] - pts[i - 1].p[0], pt.p[1] - pts[i - 1].p[1]);
      PROFILE.forEach(([b, h], j) => mb.vertex([pt.p[0] + pt.out[0] * b, pt.p[1] + pt.out[1] * b, pt.z + h], along / 3.6, j / (PROFILE.length - 1)));
    });
    barrierMetres += along;
    const P = PROFILE.length;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d: Vec2 = [pts[i + 1].p[0] - pts[i].p[0], pts[i + 1].p[1] - pts[i].p[1]];
      // Faces the road on the road side whichever side of the road the run is on.
      const outLeft = d[0] * pts[i].out[1] - d[1] * pts[i].out[0] > 0;
      for (let j = 0; j + 1 < P; j++) {
        const a = base + i * P + j, b = base + (i + 1) * P + j, c = b + 1, e = a + 1;
        if (outLeft) mb.quad(a, b, c, e);
        else mb.quad(a, e, c, b);
      }
    }
    // Debris fence above the barrier, both faces; posts every 3 m.
    const fm = fence.next(pts.length * 8);
    let fAlong = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const A = pts[i], B = pts[i + 1];
      const seg = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
      const at = (pt: Pt, z: number): Vec3 => [pt.p[0] + pt.out[0] * 0.31, pt.p[1] + pt.out[1] * 0.31, pt.z + z];
      // Each face its own vertices: shared ones would average the two normals to nothing.
      for (const back of [false, true]) {
        const k = fm.vertexCount;
        fm.vertex(at(A, BARRIER_H), fAlong, 0);
        fm.vertex(at(B, BARRIER_H), fAlong + seg, 0);
        fm.vertex(at(B, BARRIER_H + FENCE_H), fAlong + seg, -FENCE_H);
        fm.vertex(at(A, BARRIER_H + FENCE_H), fAlong, -FENCE_H);
        if (back) fm.quad(k, k + 3, k + 2, k + 1);
        else fm.quad(k, k + 1, k + 2, k + 3);
      }
      fAlong += seg;
    }
    for (let m = 0; m < pts.length; m += 1.5) {
      const pt = pts[Math.floor(m)];
      if (Math.floor(m) !== m) continue;
      pieces.push({ kind: "box", at: [pt.p[0] + pt.out[0] * 0.31, pt.p[1] + pt.out[1] * 0.31], along: [pt.out[1], -pt.out[0]], length: 0.06, depth: 0.06, z0: pt.z + BARRIER_H, z1: pt.z + BARRIER_H + FENCE_H, material: "steel" });
    }
    // Sponsor banners on the fence (5.4 m), and wraps on the barrier's face (2.7 m) in between.
    for (let i = 2; i + 2 < pts.length; i += 3) {
      const pt = pts[i], toRoad: Vec2 = [-pt.out[0], -pt.out[1]];
      const art = brand();
      pieces.push({ kind: "face", at: [pt.p[0] + pt.out[0] * 0.27, pt.p[1] + pt.out[1] * 0.27], normal: toRoad, z0: pt.z + BARRIER_H + 0.08, height: 0.9, art: art.banner });
      if (i % 6 === 2) pieces.push({ kind: "face", at: [pt.p[0] + pt.out[0] * 0.17, pt.p[1] + pt.out[1] * 0.17], normal: toRoad, z0: pt.z + 0.34, height: 0.45, art: art.banner, twoSided: true });
    }
    // A wall of tyres in front of the barrier through the corner.
    if (zone.tyres) {
      const tp = pts.filter((pt) => pt.s >= zone.tyres![0] && pt.s <= zone.tyres![1]);
      if (tp.length >= 2) {
        const tm = tyres.next(tp.length * 8);
        let u = 0;
        for (let i = 0; i + 1 < tp.length; i++) {
          const A = tp[i], B = tp[i + 1];
          const seg = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
          const f = (pt: Pt, back: number, z: number): Vec3 => [pt.p[0] - pt.out[0] * back, pt.p[1] - pt.out[1] * back, pt.z + z];
          const d: Vec2 = [B.p[0] - A.p[0], B.p[1] - A.p[1]];
          const outLeft = d[0] * A.out[1] - d[1] * A.out[0] > 0;
          const quad = (q: Vec3[], uv: [number, number][]) => {
            const k = tm.vertexCount;
            q.forEach((v, j) => tm.vertex(v, uv[j][0], uv[j][1]));
            if (outLeft) tm.quad(k, k + 1, k + 2, k + 3);
            else tm.quad(k, k + 3, k + 2, k + 1);
          };
          // Front (toward the road) and top.
          quad([f(A, TYRES, 0), f(B, TYRES, 0), f(B, TYRES, 0.8), f(A, TYRES, 0.8)], [[u, 1], [u + seg, 1], [u + seg, 0], [u, 0]]);
          quad([f(A, TYRES, 0.8), f(B, TYRES, 0.8), f(B, 0, 0.8), f(A, 0, 0.8)], [[u, 0], [u + seg, 0], [u + seg, 0.3], [u, 0.3]]);
          u += seg;
        }
      }
      // A marshal post at the corner entry: an orange box behind the barrier, a yellow flag on a pole.
      const entry = pts[Math.min(3, pts.length - 1)];
      const mp: Vec2 = [entry.p[0] + entry.out[0] * 2.2, entry.p[1] + entry.out[1] * 2.2];
      if (!ctx.blocked(mp[0], mp[1])) {
        const z = ctx.ground(mp[0], mp[1]);
        const along: Vec2 = [entry.out[1], -entry.out[0]];
        pieces.push({ kind: "box", at: mp, along, length: 1.6, depth: 1.2, z0: z - 0.2, z1: z + 1.15, material: "marshal" });
        const pole: Vec2 = [mp[0] - entry.out[0] * 0.4 + along[0] * 0.6, mp[1] - entry.out[1] * 0.4 + along[1] * 0.6];
        pieces.push({ kind: "box", at: pole, along, length: 0.05, depth: 0.05, z0: z + 1.15, z1: z + 3, material: "steel" });
        pieces.push({ kind: "face", at: [pole[0] + along[0] * 0.42, pole[1] + along[1] * 0.42], normal: [-entry.out[0], -entry.out[1]], z0: z + 2.35, height: 0.6, art: art.add({ key: "flag:yellow", kind: "flag", text: "yellow" }), twoSided: true });
      }
    }
  }
  // Gantries over the start (sponsors and lights) and a separate finish (chequered).
  const gantry = (i: number, finish: boolean) => {
    const s = plan.samples[i];
    if (inRoundabout(plan, s.pos[0], s.pos[1], 10)) return;
    const reach = s.width / 2 + Math.max(baseOffset(s, 1), baseOffset(s, -1)) + 1.4;
    const road = s.h;
    for (const side of [1, -1] as const) {
      const at: Vec2 = [s.pos[0] + s.left[0] * reach * side, s.pos[1] + s.left[1] * reach * side];
      pieces.push({ kind: "box", at, along: s.tan, length: 0.9, depth: 0.9, z0: ctx.ground(at[0], at[1]) - 0.3, z1: road + 7.3, material: "canopy" });
    }
    pieces.push({ kind: "box", at: s.pos, along: s.left, length: reach * 2 + 0.9, depth: 0.9, z0: road + 6.2, z1: road + 7.3, material: "canopy" });
    for (const dir of [-1, 1] as const) {
      const normal: Vec2 = [s.tan[0] * dir, s.tan[1] * dir];
      const at: Vec2 = [s.pos[0] + normal[0] * 0.46, s.pos[1] + normal[1] * 0.46];
      if (finish) pieces.push({ kind: "face", at, normal, z0: road + 6.25, height: 1, art: art.add({ key: "gate-FINISH", kind: "gate", text: "FINISH" }) });
      else pieces.push({ kind: "face", at, normal, z0: road + 6.25, height: 1, art: brand().banner });
    }
    if (!finish) {
      // Start lights hanging under the middle, facing the grid.
      const back: Vec2 = [-s.tan[0], -s.tan[1]];
      pieces.push({ kind: "box", at: s.pos, along: s.left, length: 2.6, depth: 0.3, z0: road + 5.25, z1: road + 6.2, material: "signal" });
      pieces.push({ kind: "face", at: [s.pos[0] + back[0] * 0.16, s.pos[1] + back[1] * 0.16], normal: back, z0: road + 5.3, height: 0.85, art: art.add({ key: "lights", kind: "lights" }) });
      // The flag marshal's chequered flag, on a pole by the line.
      const t = s.width / 2 + baseOffset(s, 1) + 2.4;
      const pole: Vec2 = [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t];
      if (!ctx.blocked(pole[0], pole[1])) {
        const z = ctx.ground(pole[0], pole[1]);
        pieces.push({ kind: "box", at: pole, along: s.tan, length: 0.05, depth: 0.05, z0: z - 0.2, z1: z + 3.2, material: "steel" });
        pieces.push({ kind: "face", at: [pole[0] - s.tan[0] * 0.45, pole[1] - s.tan[1] * 0.45], normal: [-s.left[0], -s.left[1]], z0: z + 2.5, height: 0.65, art: art.add({ key: "flag:chequered", kind: "flag", text: "chequered" }), twoSided: true });
      }
    }
  };
  const iStart = plan.timed?.start ?? 0;
  gantry(iStart, false);
  if (plan.timed && Math.abs(plan.samples[plan.timed.finish].s - plan.samples[iStart].s) > 50) gantry(plan.timed.finish, true);

  // A grandstand beside the start straight, on whichever side has room; spectators along the other.
  const sStart = plan.samples[iStart].s;
  let grandstand = false, standSide: 1 | -1 | 0 = 0;
  for (const len of [48, 30]) {
    for (const side of [1, -1] as const) {
      if (grandstand) break;
      const a = sampleAt(plan, sStart + 6), b = sampleAt(plan, sStart + 6 + len), mid = sampleAt(plan, sStart + 6 + len / 2);
      const tFront = mid.width / 2 + baseOffset(mid, side) + 2.2, depth = 9;
      const ex = b.pos[0] - a.pos[0], ey = b.pos[1] - a.pos[1], el = Math.hypot(ex, ey);
      if (el < len * 0.9) continue; // only on a straight
      const tan: Vec2 = [ex / el, ey / el], out: Vec2 = [-tan[1] * side, tan[0] * side];
      const origin: Vec2 = [(a.pos[0] + b.pos[0]) / 2 + out[0] * tFront, (a.pos[1] + b.pos[1]) / 2 + out[1] * tFront];
      const at = (u: number, v: number): Vec2 => [origin[0] + tan[0] * u + out[0] * v, origin[1] + tan[1] * u + out[1] * v];
      let clear = true;
      for (let u = -el / 2; u <= el / 2 && clear; u += 3) for (let v = 0; v <= depth && clear; v += 3) if (ctx.blocked(...at(u, v))) clear = false;
      if (!clear) continue;
      grandstand = true;
      standSide = side;
      const z0 = Math.min(...[-el / 2, 0, el / 2].flatMap((u) => [0, depth].map((v) => ctx.ground(...at(u, v))))) - 0.3;
      const rows = 9, rise = 0.42, tread = 0.85, first = 1.3;
      const sm = stand.next(rows * 24 + 64);
      const cm = crowd.next(rows * 4);
      const P = (u: number, v: number, z: number): Vec3 => [...at(u, v), z];
      const L = el / 2;
      // Quads are given in a canonical order (along +u first, then up or out); their faces
      // point right of the road's direction (or up), so on the right-hand side they flip.
      const flip = side === -1;
      const quad = (mb: MeshBuilder, q: Vec3[], uv: [number, number][], reverse: boolean) => {
        const k = mb.vertexCount;
        q.forEach((v, j) => mb.vertex(v, uv[j][0], uv[j][1]));
        if (reverse) mb.quad(k, k + 3, k + 2, k + 1);
        else mb.quad(k, k + 1, k + 2, k + 3);
      };
      const flat: [number, number][] = [[0, 0], [el / 4, 0], [el / 4, 0.25], [0, 0.25]];
      const upright: [number, number][] = [[0, 1], [el / 4, 1], [el / 4, 0], [0, 0]];
      for (let i = 0; i < rows; i++) {
        // Tread i: its front edge i treads back, i rises up; the riser below it faces the road.
        const zt = z0 + 0.3 + first + i * rise, v0 = i * tread, v1 = v0 + tread;
        quad(sm, [P(-L, v0, zt), P(L, v0, zt), P(L, v1, zt), P(-L, v1, zt)], flat, flip);
        const zPrev = i ? zt - rise : z0;
        quad(sm, [P(-L, v0, zPrev), P(L, v0, zPrev), P(L, v0, zt), P(-L, v0, zt)], upright, flip);
        // The row of people sitting on this tread, set back a little, facing the road.
        const zc = zt - 0.05, vc = v0 + tread * 0.55, w = (el - 0.8) / 12;
        quad(cm, [P(-L + 0.4, vc, zc), P(L - 0.4, vc, zc), P(L - 0.4, vc, zc + 1), P(-L + 0.4, vc, zc + 1)], [[0, 1], [w, 1], [w, 0], [0, 0]], flip);
        spectators += Math.round(((el - 0.8) / 0.5) * 0.88);
      }
      // Back wall (facing away from the road), ends, and a roof over the top rows on posts.
      const zTop = z0 + 0.3 + first + rows * rise, vBack = rows * tread;
      quad(sm, [P(-L, vBack, z0), P(L, vBack, z0), P(L, vBack, zTop + 3.2), P(-L, vBack, zTop + 3.2)], upright, !flip);
      for (const u of [-L, L]) {
        quad(sm, [P(u, 0, z0), P(u, vBack, z0), P(u, vBack, zTop + 3.2), P(u, 0, z0 + 0.3 + first)], [[0, 1], [2, 1], [2, 0], [0, 0.6]], (u < 0) === !flip);
      }
      const roofFront = 2.2, zRoofF = zTop + 2.4;
      const roof = [P(-L, roofFront, zRoofF), P(L, roofFront, zRoofF), P(L, vBack, zTop + 3.2), P(-L, vBack, zTop + 3.2)];
      quad(sm, roof, flat, flip);
      quad(sm, roof, flat, !flip);
      for (let u = -L; u <= L + 0.01; u += Math.max(6, el / Math.round(el / 8))) {
        const pp = at(u, roofFront + 0.2);
        pieces.push({ kind: "box", at: pp, along: tan, length: 0.2, depth: 0.2, z0: ctx.ground(pp[0], pp[1]) - 0.2, z1: zRoofF, material: "steel" });
      }
      // Sponsor boards along the front.
      for (let u = -L + 3; u + 3 <= L; u += 6.2) {
        pieces.push({ kind: "face", at: at(u, -0.02), normal: [-out[0], -out[1]], z0: z0 + 0.35, height: 0.9, art: brand().banner });
      }
    }
  }
  // Spectators standing behind the fence along the straight (the other side from the grandstand), and feather flags.
  for (const side of [1, -1] as const) {
    if (side === standSide) continue;
    let row: { p: Vec2; z: number; out: Vec2 }[] = [];
    const flushRow = () => {
      if (row.length >= 5) {
        const mb = standing.next(row.length * 8);
        let u = 0;
        for (const back of [0, 0.7]) {
          u = back * 3;
          for (let i = 0; i + 1 < row.length; i++) {
            const A = row[i], B = row[i + 1];
            const seg = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1]);
            const at = (q: typeof A, z: number): Vec3 => [q.p[0] + q.out[0] * back, q.p[1] + q.out[1] * back, q.z + z];
            const k = mb.vertexCount;
            mb.vertex(at(A, 0), u / 12, 1);
            mb.vertex(at(B, 0), (u + seg) / 12, 1);
            mb.vertex(at(B, 1.8), (u + seg) / 12, 0);
            mb.vertex(at(A, 1.8), u / 12, 0);
            const d: Vec2 = [B.p[0] - A.p[0], B.p[1] - A.p[1]];
            // Facing the road (away from `out`): that's to the right of d when `out` is to its left.
            if (d[0] * A.out[1] - d[1] * A.out[0] > 0) mb.quad(k, k + 1, k + 2, k + 3);
            else mb.quad(k, k + 3, k + 2, k + 1);
            u += seg;
          }
          spectators += Math.round(u / 0.55 * 0.8);
        }
      }
      row = [];
    };
    for (let s = sStart - 30; s <= sStart + 160; s += 2) {
      const smp = sampleAt(plan, s);
      const t = side * (smp.width / 2 + baseOffset(smp, side) + 1.5);
      const p: Vec2 = [smp.pos[0] + smp.left[0] * t, smp.pos[1] + smp.left[1] * t];
      const out: Vec2 = [smp.left[0] * side, smp.left[1] * side];
      const far: Vec2 = [p[0] + out[0], p[1] + out[1]];
      if ((!plan.closed && (s < 0 || s > plan.length)) || ctx.blocked(p[0], p[1]) || ctx.blocked(far[0], far[1])) {
        flushRow();
        continue;
      }
      const last = row[row.length - 1];
      if (!last || Math.hypot(p[0] - last.p[0], p[1] - last.p[1]) > 0.3) row.push({ p, z: ctx.ground(p[0], p[1]) - 0.02, out });
      // A feather flag every 16 m, just behind the crowd.
      if (Math.round(s - sStart) % 16 === 0) {
        const fp: Vec2 = [p[0] + out[0] * 1.6, p[1] + out[1] * 1.6];
        if (!ctx.blocked(fp[0], fp[1])) {
          const z = ctx.ground(fp[0], fp[1]);
          pieces.push({ kind: "box", at: fp, along: smp.tan, length: 0.04, depth: 0.04, z0: z - 0.2, z1: z + 3.6, material: "steel" });
          pieces.push({ kind: "face", at: [fp[0] - smp.tan[0] * 0.42, fp[1] - smp.tan[1] * 0.42], normal: [-out[0], -out[1]], z0: z + 0.3, height: 3.2, art: brand().feather, twoSided: true });
        }
      }
    }
    flushRow();
  }

  const nodes: Kn5MeshNode[] = [];
  // Normals from the faces (none were given explicitly).
  const emit = (cm: ChunkedMesh, name: string, material: string, extra = {}) =>
    cm.all().forEach((m, i) => {
      m.normals = null;
      nodes.push(m.toKn5(`${name}_${pad(i)}`, material, extra));
    });
  emit(barrier, "1WALL_RACE_BARRIER", "race_concrete");
  emit(tyres, "1WALL_RACE_TYRES", "race_tyres");
  emit(fence, "RACE_FENCE", "race_fence", { castShadows: false });
  emit(stand, "RACE_GRANDSTAND", "concrete");
  emit(crowd, "RACE_CROWD", "race_crowd", { castShadows: false });
  emit(standing, "RACE_SPECTATORS", "race_spectators", { castShadows: false });
  return { pieces, nodes, stats: { barrierMetres: Math.round(barrierMetres), grandstand, spectators } };
}
