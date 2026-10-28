// Street furniture: street name signs at junctions, signs for shops and
// landmarks (from OSM points of interest), bus stops, servo canopies, and
// whatever street-level imagery (Mapillary) has seen: traffic signs and
// traffic lights. Power poles and street lights are in utilities.ts.
//
// Placement produces a list of simple pieces first (posts, boxes, sign
// faces), so the sign artwork can be requested and drawn in one go before
// any geometry is built.

import { ArtList, streetKey, type ArtAtlas, type ArtCell } from "./art";
import type { Vec2 } from "./geo";
import type { Kn5MeshNode } from "./kn5";
import { MeshBuilder, type Vec3 } from "./mesh";
import type { BuildOptions } from "./options";
import { inRoundabout, surfaceHeight, type RoadPlan, type RoadSample, type SegmentIndex } from "./road";
import { pad } from "./roadMesh";
import { box, ChunkedMesh } from "./scenery";
import type { StreetPlan } from "./sideStreets";

export type Piece =
  /** Square post or beam. */
  | { kind: "box"; at: Vec2; along: Vec2; length: number; depth: number; z0: number; z1: number; material: string }
  /** Double-sided printed blade (street name), long axis along `dir`. */
  | { kind: "blade"; at: Vec2; dir: Vec2; z: number; height: number; art: string }
  /** Sign face toward `normal`; plain grey back, or printed both sides. */
  | { kind: "face"; at: Vec2; normal: Vec2; z0: number; height: number; art: string; twoSided?: boolean };

/** Traffic keeps left: a sign on the left (t > 0) faces traffic coming forward. */
const facingTraffic = (s: RoadSample, side: 1 | -1): Vec2 => [-s.tan[0] * side, -s.tan[1] * side];

/** Height of the verge surface at lateral offset t (outside the asphalt). */
export function vergeZ(s: RoadSample, t: number, opts: BuildOptions): number {
  const side = t >= 0 ? 1 : -1;
  const half = s.width / 2;
  const f = Math.min(1, Math.max(0, (Math.abs(t) - half) / Math.max(0.1, opts.vergeWidth)));
  return surfaceHeight(s, side * half, opts.crown) - 0.2 * f;
}

function sampleAt(plan: RoadPlan, s: number): number {
  const a = plan.samples;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const off = (s: RoadSample, t: number): Vec2 => [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t];

/* ---------------- street name signs ---------------- */

/**
 * A corner sign where each named side street meets the route: a post on
 * the verge just before the junction, a blade naming the side street
 * (parallel to it) and, above it, one naming the route.
 */
export function streetSigns(sp: StreetPlan, plan: RoadPlan, opts: BuildOptions, art: ArtList): Piece[] {
  const out: Piece[] = [];
  for (const j of sp.junctions) {
    if (!j.name) continue;
    const i = sampleAt(plan, Math.max(0, j.s - (j.width / 2 + 2.5) * j.side));
    const s = plan.samples[i];
    if (inRoundabout(plan, s.pos[0], s.pos[1], 6)) continue;
    const t = j.side * (s.width / 2 + opts.vergeWidth * 0.6);
    const at = off(s, t);
    const z = vergeZ(s, t, opts);
    out.push({ kind: "box", at, along: s.tan, length: 0.065, depth: 0.065, z0: z - 0.4, z1: z + 3.0, material: "steel" });
    out.push({ kind: "blade", at, dir: j.dir, z: z + 2.62, height: 0.2, art: art.add({ key: streetKey(j.name), kind: "street", text: j.name }) });
    const own = sp.routeNames[j.seg];
    if (own && own !== j.name) {
      out.push({ kind: "blade", at, dir: s.tan, z: z + 2.86, height: 0.2, art: art.add({ key: streetKey(own), kind: "street", text: own }) });
    }
  }
  return out;
}

/* ---------------- landmarks ---------------- */

export interface Poi {
  at: Vec2;
  cls: string;
  subclass: string;
  name?: string;
}

const POI_COLOURS: Record<string, string> = {
  fast_food: "#c8102e", restaurant: "#7a2e1f", cafe: "#6b4226", ice_cream: "#d6457a", bakery: "#a0522d",
  grocery: "#1b7a3a", shop: "#2d4a6b", clothing_store: "#4a2d6b", pharmacy: "#13874a", bank: "#123a6b",
  beer: "#7a5a12", alcohol_shop: "#5a1f3a", lodging: "#24456e", car: "#3a3a3a", hospital: "#0b5ea8",
  school: "#1d4f91", college: "#1d4f91", place_of_worship: "#4b3a75", library: "#2f5d50", police: "#0a2a66",
  post: "#d22630", fire_station: "#b31b1b", cinema: "#1a1a1a", hairdresser: "#7a2f5e", doctors: "#0b5ea8",
  dentist: "#0b5ea8", veterinary: "#2f7a4a", sports_centre: "#215a8a",
};

const SIGNED = new Set(Object.keys(POI_COLOURS).concat(["fuel"]));

/**
 * Signs for named businesses and landmarks within 60 m of the route, a
 * bus stop post and shelter for each stop on it, and a canopy over each
 * service station. Signs keep 12 m apart along each side.
 */
export function landmarks(pois: Poi[], plan: RoadPlan, index: SegmentIndex, opts: BuildOptions, art: ArtList, clear: (x: number, y: number) => number): Piece[] {
  const out: Piece[] = [];
  const used: { s: number; side: number }[] = [];
  const free = (s: number, side: number) => !used.some((u) => u.side === side && Math.abs(u.s - s) < 12);
  let signs = 0;
  art.add({ key: "back", kind: "back" });

  for (const p of pois) {
    const n = index.nearest(p.at[0], p.at[1], 60);
    if (!n) continue;
    const s = plan.samples[n.seg];
    const side: 1 | -1 = n.t >= 0 ? 1 : -1;
    const half = s.width / 2;
    if (inRoundabout(plan, s.pos[0], s.pos[1], 10)) continue;

    if (p.cls === "bus" && n.dist < 25 && free(s.s, side)) {
      used.push({ s: s.s, side });
      const t = side * (half + opts.vergeWidth * 0.7);
      const at = off(s, t), z = vergeZ(s, t, opts);
      out.push({ kind: "box", at, along: s.tan, length: 0.07, depth: 0.07, z0: z - 0.4, z1: z + 2.7, material: "steel" });
      out.push({ kind: "face", at, normal: facingTraffic(s, side), z0: z + 2.0, height: 0.6, art: art.add({ key: "bus", kind: "bus" }) });
      // Shelter set back behind the verge, open toward the road.
      const st = side * (half + opts.vergeWidth + 2.3);
      const c = off(s, st), zc = vergeZ(s, side * (half + opts.vergeWidth), opts);
      if (clear(c[0], c[1]) > 2.5) {
        const back: Vec2 = [c[0] + s.left[0] * side * 0.75, c[1] + s.left[1] * side * 0.75];
        out.push({ kind: "box", at: c, along: s.tan, length: 3.6, depth: 1.7, z0: zc + 2.35, z1: zc + 2.45, material: "steel" });
        out.push({ kind: "box", at: back, along: s.tan, length: 3.6, depth: 0.06, z0: zc - 0.2, z1: zc + 2.35, material: "glass" });
        for (const e of [-1.75, 1.75]) {
          out.push({ kind: "box", at: [back[0] + s.tan[0] * e, back[1] + s.tan[1] * e], along: s.tan, length: 0.08, depth: 0.08, z0: zc - 0.2, z1: zc + 2.4, material: "steel" });
        }
        out.push({ kind: "box", at: [c[0] + s.left[0] * side * 0.4, c[1] + s.left[1] * side * 0.4], along: s.tan, length: 2.2, depth: 0.4, z0: zc + 0.4, z1: zc + 0.48, material: "steel" });
      }
      continue;
    }

    if (p.cls === "fuel" && p.subclass === "fuel") {
      // Canopy over the POI, square to the road, if it doesn't sit on the road.
      if (n.dist > half + opts.vergeWidth + 6) {
        const zc = vergeZ(s, side * (half + opts.vergeWidth), opts);
        const right: Vec2 = [s.left[0] * -1, s.left[1] * -1];
        for (const [a, b] of [[-4, -2.5], [4, -2.5], [-4, 2.5], [4, 2.5]]) {
          out.push({ kind: "box", at: [p.at[0] + s.tan[0] * a + right[0] * b, p.at[1] + s.tan[1] * a + right[1] * b], along: s.tan, length: 0.35, depth: 0.35, z0: zc - 0.5, z1: zc + 5, material: "steel" });
        }
        out.push({ kind: "box", at: p.at, along: s.tan, length: 13, depth: 8, z0: zc + 5, z1: zc + 5.8, material: "canopy" });
      }
    }

    const signed = p.cls === "attraction" || SIGNED.has(p.cls);
    if (!signed || n.dist > 60 || signs >= 80 || !free(s.s, side)) continue;
    const name = p.name ?? (p.cls === "fuel" ? "FUEL" : p.subclass === "viewpoint" ? "Lookout" : undefined);
    if (!name) continue;
    used.push({ s: s.s, side });
    signs++;
    // Pylon at the property line, between the road and the place.
    const t = side * Math.min(n.dist, half + opts.vergeWidth + 2.5);
    const at = off(s, t), z = vergeZ(s, side * (half + opts.vergeWidth), opts);
    // The whole panel (about 2.2 m across, at right angles to the road) must stand clear.
    const ends: Vec2[] = [-1.3, 0, 1.3].map((e) => [at[0] + s.left[0] * e, at[1] + s.left[1] * e]);
    if (ends.some(([x, y]) => clear(x, y) < 1)) continue;
    const key = art.add(p.cls === "attraction"
      ? { key: `tourist:${name}`, kind: "tourist", text: name }
      : { key: `poi:${p.cls}:${name}`, kind: "poi", text: name, colour: POI_COLOURS[p.cls] ?? "#2d3a4a" });
    const tall = p.cls === "fuel" ? 5.2 : 3.2, h = p.cls === "fuel" ? 1.6 : 0.9;
    const normal = facingTraffic(s, side);
    // Two legs either side of the panel, set back a touch behind it.
    for (const e of [-0.75, 0.75]) {
      const leg: Vec2 = [at[0] + s.left[0] * e - normal[0] * 0.1, at[1] + s.left[1] * e - normal[1] * 0.1];
      out.push({ kind: "box", at: leg, along: s.tan, length: 0.12, depth: 0.12, z0: z - 0.5, z1: z + tall, material: "steel" });
    }
    out.push({ kind: "face", at, normal, z0: z + tall - h, height: h, art: key, twoSided: true });
  }
  return out;
}

/* ---------------- street-level features (Mapillary) ---------------- */

export interface SeenFeature {
  at: Vec2;
  /** Mapillary object value, e.g. "regulatory--stop--g1", "object--street-light". */
  value: string;
}

/** Turns a Mapillary object value into a sign art request, or null. */
export function signArt(value: string, art: ArtList): string | null {
  const speed = /maximum-speed-limit-(\d+)/.exec(value);
  if (speed) return art.add({ key: `speed:${speed[1]}`, kind: "speed", text: speed[1] });
  if (/^regulatory--stop/.test(value)) return art.add({ key: "stop", kind: "stop" });
  if (/^regulatory--yield/.test(value)) return art.add({ key: "giveway", kind: "giveway" });
  if (/^regulatory--no-entry/.test(value)) return art.add({ key: "noentry", kind: "noentry" });
  if (/^regulatory--keep-left/.test(value)) return art.add({ key: "keepleft", kind: "keepleft" });
  const chev = /^complementary--chevron-(left|right)/.exec(value);
  if (chev) return art.add({ key: `chevron:${chev[1]}`, kind: "chevron", text: chev[1] });
  const warn = /^warning--([a-z-]+?)(--|$)/.exec(value);
  if (warn) return art.add({ key: `warning:${warn[1]}`, kind: "warning", text: warn[1] });
  return null;
}

/**
 * Objects street-level imagery has located near the route. Positions are a
 * few metres out, so anything that lands on the road is pushed back onto
 * the verge; signs face the traffic on their side.
 */
/** What kind of object a Mapillary value is, for merging repeat sightings. */
function category(value: string): { key: string; radius: number } {
  if (/^object--support--utility-pole/.test(value)) return { key: "pole", radius: 5 };
  if (/^object--street-light/.test(value)) return { key: "light", radius: 5 };
  if (/^object--traffic-light/.test(value)) return { key: "signal", radius: 4 };
  if (/^marking--/.test(value)) return { key: value, radius: 6 };
  return { key: value.replace(/--g\d+$/, ""), radius: 6 };
}

/**
 * Mapillary reports an object once per way it was seen (a traffic light's
 * front, back and side are three detections). Detections of the same kind
 * close together become one, at their average position.
 */
export function mergeSightings(features: SeenFeature[]): SeenFeature[] {
  const groups: { key: string; radius: number; pts: Vec2[]; value: string }[] = [];
  for (const f of features) {
    const c = category(f.value);
    const g = groups.find((x) => x.key === c.key && x.pts.some((p) => Math.hypot(p[0] - f.at[0], p[1] - f.at[1]) < c.radius));
    if (g) g.pts.push(f.at);
    else groups.push({ ...c, pts: [f.at], value: f.value });
  }
  return groups.map((g) => ({
    value: g.value,
    at: [g.pts.reduce((a, p) => a + p[0], 0) / g.pts.length, g.pts.reduce((a, p) => a + p[1], 0) / g.pts.length],
  }));
}

export function seenFeatures(features: SeenFeature[], plan: RoadPlan, index: SegmentIndex, opts: BuildOptions, art: ArtList): Piece[] {
  const out: Piece[] = [];
  art.add({ key: "back", kind: "back" });
  for (const f of mergeSightings(features)) {
    if (/^marking--/.test(f.value)) continue; // painted on the road: see markings
    if (/^object--(support--utility-pole|street-light)/.test(f.value)) continue; // see utilities.ts

    const n = index.nearest(f.at[0], f.at[1], opts.corridor - 2);
    if (!n) continue;
    const s = plan.samples[n.seg];
    const side: 1 | -1 = n.t >= 0 ? 1 : -1;
    const half = s.width / 2;
    if (inRoundabout(plan, f.at[0], f.at[1], 2)) continue;
    const onRoad = n.dist < half + opts.vergeWidth * 0.6;
    const t = onRoad ? side * (half + opts.vergeWidth * 0.7) : n.t;
    const at = onRoad ? off(s, t) : f.at;
    const z = Math.abs(t) < half + opts.vergeWidth + 0.5 ? vergeZ(s, t, opts) : surfaceHeight(s, side * half, opts.crown) - 0.2;

    if (/^object--traffic-light/.test(f.value)) {
      out.push({ kind: "box", at, along: s.tan, length: 0.14, depth: 0.14, z0: z - 0.4, z1: z + 3.5, material: "steel" });
      const head: Vec2 = [at[0] + facingTraffic(s, side)[0] * 0.2, at[1] + facingTraffic(s, side)[1] * 0.2];
      out.push({ kind: "box", at: head, along: s.tan, length: 0.36, depth: 0.3, z0: z + 2.4, z1: z + 3.4, material: "signal" });
      continue;
    }
    const key = signArt(f.value, art);
    if (!key || n.dist > 40) continue;
    const size = key.startsWith("speed") ? 0.6 : key.startsWith("chevron") ? 0.6 : 0.75;
    out.push({ kind: "box", at, along: s.tan, length: 0.065, depth: 0.065, z0: z - 0.4, z1: z + 2.2 + size, material: "steel" });
    out.push({ kind: "face", at: [at[0] + facingTraffic(s, side)[0] * 0.05, at[1] + facingTraffic(s, side)[1] * 0.05], normal: facingTraffic(s, side), z0: z + 2.1, height: size, art: key });
  }
  return out;
}

/* ---------------- geometry ---------------- */

/** One printed face toward `n`, centred on `at`, text left to right as seen from the front. */
function face(mb: MeshBuilder, at: Vec2, n: Vec2, width: number, z0: number, z1: number, cell: ArtCell, mirrorU = false): void {
  const rx = -n[1], ry = n[0]; // viewer's right
  const i = mb.vertexCount;
  const [ua, ub] = mirrorU ? [cell.u1, cell.u0] : [cell.u0, cell.u1];
  const corners: [Vec3, number, number][] = [
    [[at[0] - rx * width / 2, at[1] - ry * width / 2, z0], ua, cell.v1],
    [[at[0] + rx * width / 2, at[1] + ry * width / 2, z0], ub, cell.v1],
    [[at[0] + rx * width / 2, at[1] + ry * width / 2, z1], ub, cell.v0],
    [[at[0] - rx * width / 2, at[1] - ry * width / 2, z1], ua, cell.v0],
  ];
  for (const [p, u, v] of corners) {
    mb.vertex(p, u, v);
    mb.normals!.push(n[0], n[1], 0);
  }
  mb.quad(i, i + 1, i + 2, i + 3);
}

export function buildPieces(pieces: Piece[], atlas: ArtAtlas | null): Kn5MeshNode[] {
  const byMat = new Map<string, ChunkedMesh>();
  const mesh = (m: string, verts: number) => {
    if (!byMat.has(m)) byMat.set(m, new ChunkedMesh(0));
    return byMat.get(m)!.next(verts);
  };
  for (const p of pieces) {
    if (p.kind === "box") {
      box(mesh(p.material, 20), p.at, p.along, p.length, p.depth, p.z0, p.z1);
      continue;
    }
    const cell = atlas?.cells[p.art];
    if (!cell) continue;
    if (p.kind === "blade") {
      const w = p.height * cell.aspect;
      const n: Vec2 = [-p.dir[1], p.dir[0]];
      const mb = mesh("signart", 8);
      // Both faces read correctly: the back is the front seen from behind.
      face(mb, [p.at[0] + n[0] * 0.01, p.at[1] + n[1] * 0.01], n, w, p.z - p.height / 2, p.z + p.height / 2, cell);
      face(mb, [p.at[0] - n[0] * 0.01, p.at[1] - n[1] * 0.01], [-n[0], -n[1]], w, p.z - p.height / 2, p.z + p.height / 2, cell);
      continue;
    }
    const w = p.height * cell.aspect;
    face(mesh("signart", 4), p.at, p.normal, w, p.z0, p.z0 + p.height, cell);
    const behind: Vec2 = [p.at[0] - p.normal[0] * 0.01, p.at[1] - p.normal[1] * 0.01];
    const flip: Vec2 = [-p.normal[0], -p.normal[1]];
    if (p.twoSided) face(mesh("signart", 4), behind, flip, w, p.z0, p.z0 + p.height, cell);
    else if (atlas?.cells.back) face(mesh("signart", 4), behind, flip, w, p.z0, p.z0 + p.height, atlas.cells.back, true);
  }
  const out: Kn5MeshNode[] = [];
  for (const [m, cm] of byMat) cm.all().forEach((mb, i) => out.push(mb.toKn5(`FURNITURE_${m.toUpperCase()}_${pad(i)}`, m)));
  return out;
}

/**
 * START and FINISH signs at the timing gates: one each side of the road on
 * a pair of posts, readable from both ways.
 */
export function gateSigns(plan: RoadPlan, opts: BuildOptions, art: ArtList): Piece[] {
  if (!plan.timed) return [];
  const out: Piece[] = [];
  for (const [i, text] of [[plan.timed.start, "START"], [plan.timed.finish, "FINISH"]] as const) {
    const s = plan.samples[i];
    if (inRoundabout(plan, s.pos[0], s.pos[1], 8)) continue;
    const key = art.add({ key: `gate-${text}`, kind: "gate", text });
    for (const side of [1, -1] as const) {
      // Beyond the verge or nature strip, clear of the road.
      const t = (s.width / 2 + opts.vergeWidth + 1.8) * side;
      const at: Vec2 = [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t];
      const z = vergeZ(s, t, opts);
      for (const d of [-0.75, 0.75]) {
        // Posts at the sign's ends (it spans across the road's direction).
        out.push({ kind: "box", at: [at[0] + s.left[0] * d, at[1] + s.left[1] * d], along: s.tan, length: 0.08, depth: 0.08, z0: z - 0.4, z1: z + 2.9, material: "steel" });
      }
      out.push({ kind: "face", at, normal: [-s.tan[0], -s.tan[1]], z0: z + 2.2, height: 0.62, art: key, twoSided: true });
    }
  }
  return out;
}
