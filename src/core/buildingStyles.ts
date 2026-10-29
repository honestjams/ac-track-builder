// What buildings are made of, and which kinds of building wear what.
//
// A facade is a wall finish (brick, weatherboard, fibro, render, cladding,
// Colorbond, tilt-up concrete, curtain glass, lattice) in one colour, with a
// layout of windows and doors that repeats every `period` metres along the
// wall and every `storey` metres up it. Its texture is painted from that
// spec at 32 px a metre; glass panes (the "window" material, which CSP
// lights at night) go over the same openings.
//
// A building type picks facades, a roof shape and finish, storeys and extras
// (stumps and a verandah on a Queenslander, an awning and parapet on a shop)
// from what's known about the building: OSM tags, its height and footprint,
// and points of interest inside it.

import { encodePng } from "./png";
import { rng } from "./scenery";
import { fill, valueNoise } from "./textures";

type RGB = [number, number, number];

export type WallKind = "brick" | "weatherboard" | "fibro" | "render" | "cladding" | "corrugated" | "panel" | "glass" | "lattice";

/** A window or door in a layout: metres along the period, and up from the storey's floor. */
export interface Opening {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  kind?: "window" | "shop" | "door";
}

export interface Layout {
  period: number;
  storey: number;
  openings: Opening[];
  /** Glass panes over the windows (CSP lights the rooms behind them at night). */
  panes: boolean;
  /** A band up the storey with no openings, for gable ends. */
  plain: [number, number];
  /** Extra painting: a shop sign above the windows, balcony slabs and balustrades, hoods over windows. */
  band?: "sign" | "balcony" | "hood";
}

export const LAYOUTS = {
  // A wide living-room window and a small, higher one (bathroom or bedroom).
  house: { period: 8, storey: 3, openings: [{ x0: 1.125, x1: 3.375, z0: 0.94, z1: 2.25 }, { x0: 5.31, x1: 6.56, z0: 1.44, z1: 2.25 }], panes: true, plain: [0.1, 0.85] },
  // Floor-to-ceiling sliders and a tall slot window.
  modern: { period: 8, storey: 3, openings: [{ x0: 0.8, x1: 3.8, z0: 0.15, z1: 2.45 }, { x0: 5.6, x1: 6.2, z0: 0.6, z1: 2.45 }], panes: true, plain: [2.5, 2.95] },
  // Pairs of tall double-hung windows under hoods.
  queenslander: { period: 4, storey: 3, openings: [{ x0: 0.9, x1: 1.75, z0: 0.75, z1: 2.3 }, { x0: 2.25, x1: 3.1, z0: 0.75, z1: 2.3 }], panes: true, plain: [0.1, 0.7], band: "hood" },
  // Brick walk-up flats: living window and a small bathroom window, 2.8 m storeys.
  flats: { period: 6, storey: 2.8, openings: [{ x0: 0.8, x1: 2.6, z0: 0.9, z1: 2.2 }, { x0: 4, x1: 4.9, z0: 1.3, z1: 2.2 }], panes: true, plain: [0.1, 0.85] },
  // Modern apartments: full-height glass behind a balcony, and a bedroom window.
  apartment: { period: 7, storey: 3, openings: [{ x0: 0.4, x1: 5, z0: 0.25, z1: 2.7 }, { x0: 5.6, x1: 6.6, z0: 0.9, z1: 2.4 }], panes: true, plain: [2.75, 2.95], band: "balcony" },
  // Offices: a ribbon of glass along each floor.
  office: { period: 3, storey: 3.6, openings: [{ x0: 0.08, x1: 2.92, z0: 0.95, z1: 3.15 }], panes: true, plain: [0.1, 0.9] },
  // Curtain wall: glass from floor to floor between mullions.
  curtain: { period: 1.5, storey: 3.6, openings: [{ x0: 0.04, x1: 1.46, z0: 0.06, z1: 3.54 }], panes: false, plain: [0, 0.05] },
  // Shopfront: two display windows and a glass door, a sign above.
  shopfront: { period: 6, storey: 4, openings: [{ x0: 0.3, x1: 2.6, z0: 0.35, z1: 3, kind: "shop" }, { x0: 2.8, x1: 3.9, z0: 0, z1: 2.4, kind: "door" }, { x0: 4.1, x1: 5.7, z0: 0.35, z1: 3, kind: "shop" }], panes: true, plain: [3.9, 4], band: "sign" },
  // Above the shops: two sash windows a bay.
  shopupper: { period: 5, storey: 3.2, openings: [{ x0: 0.9, x1: 2.1, z0: 0.9, z1: 2.5 }, { x0: 2.9, x1: 4.1, z0: 0.9, z1: 2.5 }], panes: true, plain: [0.1, 0.85] },
  // Sheds and warehouses: a strip of high windows, nothing low down.
  industrial: { period: 12, storey: 6, openings: [{ x0: 1, x1: 4, z0: 3.6, z1: 4.2 }], panes: false, plain: [0, 3.5] },
  // Churches, halls, schools: tall windows.
  hall: { period: 4, storey: 4.5, openings: [{ x0: 1.4, x1: 2.6, z0: 1, z1: 3.6 }], panes: true, plain: [0.1, 0.95] },
  blank: { period: 4, storey: 3, openings: [], panes: false, plain: [0, 3] },
} satisfies Record<string, Layout>;

export type LayoutName = keyof typeof LAYOUTS;

export interface Facade {
  name: string;
  wall: WallKind;
  colour: RGB;
  /** Window frames (and mullions on glass). */
  trim: RGB;
  layout: LayoutName;
  /** Shop sign colour. */
  sign?: RGB;
}

const WHITE: RGB = [236, 236, 230];
const DARK: RGB = [52, 54, 56];
const f = (name: string, wall: WallKind, colour: RGB, layout: LayoutName, trim: RGB = WHITE, sign?: RGB): Facade =>
  ({ name, wall, colour, trim, layout, ...(sign ? { sign } : {}) });

export const FACADES: Facade[] = [
  // Brick veneer houses.
  f("brick_red", "brick", [150, 78, 58], "house"),
  f("brick_cream", "brick", [214, 190, 148], "house"),
  f("brick_brown", "brick", [118, 74, 56], "house"),
  f("brick_tan", "brick", [186, 128, 86], "house"),
  f("brick_dark", "brick", [86, 74, 72], "house"),
  f("brick_painted", "brick", [226, 223, 215], "house", [70, 72, 74]),
  // Weatherboard and fibro cottages.
  f("wb_white", "weatherboard", [238, 236, 226], "house"),
  f("wb_cream", "weatherboard", [236, 224, 190], "house"),
  f("wb_grey", "weatherboard", [196, 200, 200], "house"),
  f("wb_sage", "weatherboard", [168, 182, 156], "house"),
  f("wb_blue", "weatherboard", [186, 202, 214], "house"),
  f("wb_yellow", "weatherboard", [234, 218, 160], "house"),
  f("fibro_white", "fibro", [226, 224, 214], "house"),
  f("fibro_mint", "fibro", [204, 220, 200], "house"),
  f("fibro_blue", "fibro", [196, 212, 224], "house"),
  f("fibro_pink", "fibro", [228, 204, 198], "house"),
  // Modern houses: render and cladding, dark frames, big glass.
  f("render_white", "render", [238, 236, 230], "modern", DARK),
  f("render_grey", "render", [178, 180, 180], "modern", DARK),
  f("render_charcoal", "render", [86, 88, 90], "modern", [30, 30, 32]),
  f("render_sand", "render", [216, 198, 164], "modern", DARK),
  f("render_terracotta", "render", [196, 142, 112], "modern", WHITE),
  f("clad_timber", "cladding", [146, 112, 80], "modern", DARK),
  f("clad_black", "cladding", [58, 58, 60], "modern", [200, 200, 196]),
  // Queenslanders: weatherboard on stumps, with a coloured trim.
  f("qld_white", "weatherboard", [240, 238, 230], "queenslander", [60, 96, 72]),
  f("qld_cream", "weatherboard", [236, 226, 196], "queenslander", [128, 44, 40]),
  f("qld_blue", "weatherboard", [200, 214, 222], "queenslander", WHITE),
  f("qld_yellow", "weatherboard", [238, 224, 170], "queenslander", [60, 80, 110]),
  // Walk-up flats.
  f("flats_red", "brick", [150, 78, 58], "flats"),
  f("flats_cream", "brick", [214, 190, 148], "flats"),
  f("flats_brown", "brick", [118, 74, 56], "flats"),
  f("flats_render", "render", [232, 228, 218], "flats", DARK),
  // Apartments with balconies.
  f("apt_white", "render", [238, 238, 234], "apartment", DARK),
  f("apt_grey", "render", [176, 178, 178], "apartment", DARK),
  f("apt_sand", "render", [220, 204, 172], "apartment", DARK),
  f("apt_charcoal", "panel", [96, 98, 100], "apartment", [210, 210, 206]),
  // Offices.
  f("office_grey", "panel", [176, 176, 172], "office", [60, 64, 70]),
  f("office_brick", "brick", [118, 74, 56], "office", [50, 50, 52]),
  f("office_white", "render", [232, 232, 228], "office", [70, 76, 84]),
  // Glass towers: the colour is the glass, the trim the mullions.
  f("glass_blue", "glass", [70, 100, 125], "curtain", [150, 156, 162]),
  f("glass_green", "glass", [70, 110, 105], "curtain", [160, 164, 160]),
  f("glass_silver", "glass", [130, 140, 150], "curtain", [190, 194, 198]),
  f("glass_bronze", "glass", [110, 95, 80], "curtain", [70, 62, 54]),
  // Shopfronts (ground floor) and the floors above.
  f("shop_red", "render", [236, 234, 228], "shopfront", [60, 60, 62], [170, 40, 40]),
  f("shop_blue", "brick", [150, 78, 58], "shopfront", [50, 50, 52], [40, 70, 140]),
  f("shop_green", "render", [230, 220, 192], "shopfront", [60, 60, 62], [40, 110, 70]),
  f("shop_black", "render", [86, 88, 90], "shopfront", [30, 30, 32], [30, 30, 30]),
  f("shop_yellow", "panel", [200, 196, 186], "shopfront", [60, 60, 62], [220, 170, 30]),
  f("upper_brick", "brick", [150, 78, 58], "shopupper"),
  f("upper_cream", "render", [230, 220, 192], "shopupper"),
  f("upper_blue", "render", [196, 210, 216], "shopupper"),
  // Sheds and warehouses: Colorbond walls, or tilt-up concrete panels.
  f("shed_surfmist", "corrugated", [228, 226, 213], "industrial", [120, 122, 120]),
  f("shed_shale", "corrugated", [189, 191, 186], "industrial", [120, 122, 120]),
  f("shed_woodland", "corrugated", [75, 76, 70], "industrial", [140, 140, 136]),
  f("shed_ocean", "corrugated", [54, 66, 82], "industrial", [150, 150, 150]),
  f("shed_cream", "corrugated", [233, 220, 184], "industrial", [120, 122, 120]),
  f("tiltup", "panel", [196, 192, 182], "industrial", [110, 110, 108]),
  // Churches, halls and schools.
  f("hall_brick", "brick", [150, 78, 58], "hall"),
  f("hall_cream", "brick", [214, 190, 148], "hall"),
  // Under a Queenslander.
  f("lattice_white", "lattice", [236, 236, 230], "blank"),
  f("lattice_green", "lattice", [60, 96, 72], "blank"),
];

export const FACADE_INDEX = new Map(FACADES.map((x, i) => [x.name, i]));
const facadeIndex = (name: string) => FACADE_INDEX.get(name)!;

export type RoofKind = "metal" | "tile" | "ctile" | "membrane" | "gravel";

export interface RoofFinish {
  name: string;
  rgb: RGB;
  kind: RoofKind;
  /** Terracotta or concrete tiles (less shine). */
  tile?: boolean;
}

const roof = (name: string, rgb: RGB, kind: RoofKind): RoofFinish => ({ name, rgb, kind, ...(kind === "tile" || kind === "ctile" ? { tile: true } : {}) });

/** Australian roofs: Colorbond colours, terracotta and concrete tiles, and flat membrane or gravel. */
export const ROOF_COLOURS: RoofFinish[] = [
  roof("surfmist", [228, 226, 213], "metal"),
  roof("shalegrey", [189, 191, 186], "metal"),
  roof("windspray", [136, 139, 138], "metal"),
  roof("woodland", [75, 76, 70], "metal"),
  roof("monument", [50, 50, 51], "metal"),
  roof("cream", [233, 220, 184], "metal"),
  roof("terracotta", [181, 88, 58], "tile"),
  roof("paperbark", [203, 194, 173], "metal"),
  roof("jasper", [108, 97, 88], "metal"),
  roof("manorred", [104, 44, 34], "metal"),
  roof("deepocean", [54, 66, 82], "metal"),
  roof("basalt", [109, 108, 110], "metal"),
  roof("dune", [177, 173, 163], "metal"),
  roof("zinc", [170, 172, 170], "metal"),
  roof("terracotta_aged", [150, 84, 60], "tile"),
  roof("tile_charcoal", [72, 72, 74], "ctile"),
  roof("tile_slate", [112, 114, 118], "ctile"),
  roof("tile_brown", [118, 84, 62], "ctile"),
  roof("tile_red", [150, 70, 52], "ctile"),
  roof("tile_sand", [196, 170, 130], "ctile"),
  roof("membrane", [196, 196, 192], "membrane"),
  roof("gravel", [150, 146, 138], "gravel"),
];

const roofIndex = (name: string) => ROOF_COLOURS.findIndex((r) => r.name === name);
/** Pitched roof finishes (what a roof seen in the aerial photo can be). */
export const PITCHED = ROOF_COLOURS.map((r, i) => (r.kind === "membrane" || r.kind === "gravel" ? -1 : i)).filter((i) => i >= 0);

/* ---------------- textures ---------------- */

const PX = 32; // pixels a metre

function hash(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The bare wall at a point, metres along (x) and up (z) from the storey's floor. */
function wallAt(fc: Facade, x: number, z: number, n: number, stain: number): RGB {
  const [r, g, b] = fc.colour;
  const k = (m: number): RGB => [r * m + n, g * m + n, b * m + n];
  switch (fc.wall) {
    case "brick": {
      // 230 x 76 mm bricks with 10 mm joints, stretcher bond; each brick a slightly different fire.
      // (Joints at least a pixel wide, or they'd vanish at 32 px a metre.)
      const course = Math.floor(z / 0.086), off = (course % 2) * 0.12;
      const mortar = z % 0.086 < 0.024 || (x + off) % 0.24 < 0.028;
      if (mortar) return [196 + n, 190 + n, 176 + n];
      const tone = 0.86 + hash(course, Math.floor((x + off) / 0.24)) * 0.26;
      return k(tone * (0.96 + stain * 0.08));
    }
    case "weatherboard": {
      // 150 mm boards, each with a shadow under its lap.
      const t = (z % 0.15) / 0.15;
      return k(t < 0.12 ? 0.74 : 0.95 + t * 0.05);
    }
    case "fibro": {
      // 1.2 m fibro-cement sheets behind cover strips.
      return x % 1.2 < 0.06 ? k(0.9) : k(0.98 + stain * 0.04);
    }
    case "render":
      return k(0.95 + stain * 0.05);
    case "cladding": {
      // Vertical boards 140 mm wide with a groove between.
      const t = (x % 0.14) / 0.14;
      return k(t < 0.1 ? 0.7 : 0.92 + hash(Math.floor(x / 0.14), 7) * 0.12);
    }
    case "corrugated":
      // Ribs running up the wall (every other 76 mm rib: finer would alias at 32 px a metre).
      return k(0.86 + 0.14 * Math.sin((x / 0.152) * Math.PI * 2) + stain * 0.04);
    case "panel": {
      // Precast panels 3 m wide by a storey, with joints.
      return x % 3 < 0.03 || z % 3 < 0.03 ? k(0.72) : k(0.92 + stain * 0.12);
    }
    case "glass":
      return fc.trim;
    case "lattice": {
      // Diagonal timber lattice over a dark void.
      const d1 = ((x + z) / 0.15) % 1, d2 = ((x - z + 100) / 0.15) % 1;
      return d1 < 0.3 || d2 < 0.3 ? k(1) : [34 + n, 32 + n, 30 + n];
    }
  }
}

/** Glass seen from outside: the sky reflected, brighter up top. */
function glassAt(t: number, u: number, n: number, tint: RGB = [110, 128, 146]): RGB {
  const sky = 1.25 - t * 0.6;
  const curtain = u < 0.12 || u > 0.88 ? 0.25 : 0;
  return [tint[0] * sky + (214 - tint[0] * sky) * curtain + n, tint[1] * sky + (204 - tint[1] * sky) * curtain + n, tint[2] * sky + (184 - tint[2] * sky) * curtain + n];
}

/** A facade texture: one period wide by one storey tall, floor at the bottom. */
export function facadeTexture(fc: Facade): Uint8Array {
  const L: Layout = LAYOUTS[fc.layout];
  // Sides a multiple of 4, as block-compressed (DXT) textures need.
  const w = Math.round((L.period * PX) / 4) * 4, h = Math.round((L.storey * PX) / 4) * 4;
  const r = rng(61 + fc.name.length * 31 + fc.colour[0]);
  const stain = valueNoise(w, h, Math.max(2, Math.round(L.period)), 81 + fc.name.length);
  const frame = 0.06;
  return encodePng(fill(w, h, (px, py, i) => {
    const x = ((px + 0.5) / w) * L.period, z = ((h - py - 0.5) / h) * L.storey;
    const n = (r() - 0.5) * 10;
    // Shop sign: a coloured fascia above the windows, with lettering.
    if (L.band === "sign" && z > 3.1 && z < 3.85) {
      const s = fc.sign ?? [120, 40, 40];
      const letters = z > 3.3 && z < 3.65 && x > 1.2 && x < 4.8 && hash(Math.floor(x / 0.22), 3) > 0.3 && (x % 0.22) < 0.16;
      return letters ? [240, 238, 230] : [s[0] + n, s[1] + n, s[2] + n];
    }
    // Balcony: slab edge at the floor, glass balustrade in front of the big window.
    if (L.band === "balcony") {
      if (z < 0.22) return [Math.min(255, fc.colour[0] * 1.05) + n, Math.min(255, fc.colour[1] * 1.05) + n, Math.min(255, fc.colour[2] * 1.05) + n];
      if (z < 1.15 && x > 0.2 && x < 5.2) {
        if (z > 1.08 || x < 0.25 || x > 5.15) return [fc.trim[0] + n, fc.trim[1] + n, fc.trim[2] + n];
        const behind = L.openings.some((o) => x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1);
        const base = behind ? glassAt((z - 0.25) / 2.45, (x - 0.4) / 4.6, n) : wallAt(fc, x, z, n, stain[i]);
        return [base[0] * 0.7 + 170 * 0.3, base[1] * 0.7 + 190 * 0.3, base[2] * 0.7 + 196 * 0.3];
      }
    }
    for (const o of L.openings) {
      const inside = x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1;
      const inFrame = x > o.x0 - frame && x < o.x1 + frame && z > o.z0 - frame && z < o.z1 + frame;
      if (L.band === "hood" && x > o.x0 - 0.12 && x < o.x1 + 0.12 && z > o.z1 + 0.08 && z < o.z1 + 0.3) {
        // A sun hood over the window, in the trim colour, darker underneath.
        const k = z < o.z1 + 0.12 ? 0.6 : 1;
        return [fc.trim[0] * k + n, fc.trim[1] * k + n, fc.trim[2] * k + n];
      }
      if (!inFrame) continue;
      if (!inside) return [fc.trim[0] + n, fc.trim[1] + n, fc.trim[2] + n];
      const u = (x - o.x0) / (o.x1 - o.x0), t = (o.z1 - z) / (o.z1 - o.z0);
      const mull = (o.x1 - o.x0 > 1.6 && Math.abs(u - 0.5) * (o.x1 - o.x0) < 0.03)
        || (fc.layout === "queenslander" && Math.abs(t - 0.5) * (o.z1 - o.z0) < 0.03);
      if (mull) return [fc.trim[0] + n, fc.trim[1] + n, fc.trim[2] + n];
      if (fc.wall === "glass") {
        // Spandrel at the slab, then vision glass.
        const k = z < 0.9 ? 0.65 : 1;
        return [fc.colour[0] * k * (1.2 - t * 0.4) + n, fc.colour[1] * k * (1.2 - t * 0.4) + n, fc.colour[2] * k * (1.2 - t * 0.4) + n];
      }
      if (o.kind === "shop" || o.kind === "door") {
        // A lit interior: pale walls, shelves of goods.
        const shelf = o.kind === "shop" && t > 0.35 && (t * 6) % 1 < 0.12;
        const goods = o.kind === "shop" && t > 0.35 && hash(Math.floor(x / 0.18), Math.floor(t * 6)) > 0.55;
        if (shelf) return [90 + n, 90 + n, 92 + n];
        if (goods) {
          const c = hash(Math.floor(x / 0.18), Math.floor(t * 6) + 9);
          return [120 + c * 120 + n, 90 + (1 - c) * 100 + n, 80 + c * 60 + n];
        }
        return [196 - t * 40 + n, 198 - t * 40 + n, 196 - t * 30 + n];
      }
      return glassAt(t, u, n);
    }
    return wallAt(fc, x, z, n, stain[i]);
  }), w, h, { alpha: false });
}

/** Roof finish, 2 m x 2 m: corrugated sheet, tiles, membrane or gravel. */
export function roofTexture(rf: RoofFinish): Uint8Array {
  const w = 128, h = 128;
  const r = rng(71 + rf.rgb[0] + rf.name.length);
  const [cr, cg, cb] = rf.rgb;
  const mottle = valueNoise(w, h, 8, 91 + rf.name.length);
  return encodePng(fill(w, h, (x, y, i) => {
    let k: number;
    if (rf.kind === "tile") {
      // Terracotta: rolled tiles in rows ~0.33 m, staggered joints, each tile its own fire.
      const row = Math.floor(y / 21), inRow = (y % 21) / 21;
      const joint = (x + (row % 2) * 16) % 32 < 2;
      const roll = 0.9 + 0.12 * Math.sin(((x + (row % 2) * 16) / 32) * Math.PI * 2);
      k = (0.78 + inRow * 0.3) * roll * (0.9 + hash(row, Math.floor((x + (row % 2) * 16) / 32)) * 0.2) - (joint ? 0.25 : 0);
    } else if (rf.kind === "ctile") {
      // Concrete tiles: flatter, wider, a hard shadow under each row.
      const row = Math.floor(y / 22), inRow = (y % 22) / 22;
      const joint = (x + (row % 2) * 13) % 26 < 1.5;
      k = (inRow > 0.86 ? 0.62 : 0.92 + inRow * 0.08) * (0.93 + hash(row, Math.floor((x + (row % 2) * 13) / 26)) * 0.14) - (joint ? 0.2 : 0);
    } else if (rf.kind === "membrane") {
      // Membrane sheets 1 m wide with welded seams and weathering.
      k = (x % 64 < 2 ? 0.86 : 1) * (0.88 + mottle[i] * 0.18);
    } else if (rf.kind === "gravel") {
      k = 0.75 + r() * 0.45;
    } else {
      // Corrugations every ~76 mm running down the slope (along v).
      k = 0.9 + 0.12 * Math.sin((x / w) * Math.PI * 2 * 26) + (mottle[i] - 0.5) * 0.05;
    }
    k += (r() - 0.5) * 0.06;
    return [cr * k, cg * k, cb * k];
  }), w, h, { alpha: false });
}

/* ---------------- building types ---------------- */

export type RoofShape = "flat" | "gable" | "hip" | "skillion";

/** How a building is dressed: set by dressBuilding, read by buildBuildings. */
export interface Dress {
  /** What kind of building it is (house, queenslander, shop, ...). */
  type: string;
  facade: number;
  /** A different ground floor (shopfronts under offices or flats). */
  groundFacade?: number;
  roof: RoofShape;
  roofColour: number;
  /** Roof pitch, degrees. */
  pitch: number;
  /** Wall height to the eaves (or roof), metres, above any stumps. */
  height: number;
  /** Raised on stumps this high, with lattice (this facade) between them. */
  stumps?: number;
  under?: number;
  /** A verandah across the street front. */
  verandah?: boolean;
  /** A shop awning over the footpath. */
  awning?: boolean;
  /** Walls carried this far above a flat roof. */
  parapet?: number;
  /** A garage door on the front (a roller door on a warehouse). */
  garage?: boolean;
}

export interface DressInfo {
  /** Height known from OSM or the vector tiles, metres; undefined if a guess. */
  height?: number;
  /** OSM building=* when known. */
  kind?: string;
  /** Footprint area, m^2. */
  area: number;
  /** A point of interest inside it (vector tile class), e.g. "shop", "cafe", "place_of_worship". */
  poi?: string;
  /** Roof colour seen in the aerial photo, if any (index into ROOF_COLOURS). */
  photoRoof?: number;
  /** In Queensland, where raised timber houses are common. */
  queensland: boolean;
  /** Rectangular enough for a pitched roof. */
  rectangle: boolean;
  /** On the street front (for shops: awnings over the footpath). */
  fronted: boolean;
  seed: number;
}

const SHOP_POI = /^(shop|grocery|clothing_store|cafe|restaurant|fast_food|bar|pub|bank|pharmacy|alcohol_shop|bakery|butcher|hairdresser|beauty|ice_cream|florist|optician|newsagent|books|convenience|supermarket|hardware|furniture|jewelry|mobile_phone|post|library|cinema|laundry|car|bicycle|toys|sports|shoes|gift|music|pet|doctors|dentist|veterinary|fuel)$/;

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length];
}

/** Picks from [item, weight] pairs. */
function weighted<T>(rand: () => number, items: [T, number][]): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [item, w] of items) {
    if ((x -= w) <= 0) return item;
  }
  return items[items.length - 1][0];
}

const BRICK = ["brick_red", "brick_cream", "brick_brown", "brick_tan", "brick_dark", "brick_painted"];
const WEATHERBOARD = ["wb_white", "wb_cream", "wb_grey", "wb_sage", "wb_blue", "wb_yellow"];
const FIBRO = ["fibro_white", "fibro_mint", "fibro_blue", "fibro_pink"];
const MODERN = ["render_white", "render_grey", "render_charcoal", "render_sand", "render_terracotta", "clad_timber", "clad_black"];
const QLD = ["qld_white", "qld_cream", "qld_blue", "qld_yellow"];
const METAL = ["surfmist", "shalegrey", "windspray", "woodland", "monument", "cream", "paperbark", "jasper", "manorred", "deepocean", "basalt", "dune"];
const TILES = ["terracotta", "terracotta_aged", "tile_charcoal", "tile_slate", "tile_brown", "tile_red", "tile_sand"];

/**
 * Chooses the kind of building and dresses it: facades, roof shape, finish
 * and pitch, height, and extras. Known facts win (OSM type and height, a
 * shop inside it, the roof colour in the photo); the rest is a weighted
 * draw of what's typical in Australian towns.
 */
export function dressBuilding(info: DressInfo): Dress {
  const rand = rng(info.seed);
  const h = info.height;
  const kind = info.kind ?? "";
  const poi = info.poi ?? "";
  const rooftop = (fallback: string[]) => (info.photoRoof !== undefined ? info.photoRoof : roofIndex(pick(rand, fallback)));
  const flatTop = () => roofIndex(rand() < 0.65 ? "membrane" : "gravel");
  const levels = (storey: number, fallback: number) => Math.max(1, Math.round((h ?? fallback * storey) / storey));

  // Places of worship, schools and halls.
  if (/^(church|chapel|cathedral|school|civic|public|hall)$/.test(kind) || /^(place_of_worship|school|college|kindergarten|community_centre|town_hall)$/.test(poi)) {
    return { type: "hall", facade: facadeIndex(pick(rand, ["hall_brick", "hall_cream"])), roof: info.rectangle ? "gable" : "flat", roofColour: info.rectangle ? rooftop(["terracotta", "tile_red", "manorred", "zinc"]) : flatTop(), pitch: 30, height: Math.min(h ?? 5.5, 9) };
  }
  // Towers: curtain glass, or apartments with balconies.
  if ((h ?? 0) >= 30 || /^(office|commercial)$/.test(kind) && (h ?? 0) >= 18) {
    const glass = /^(office|commercial)$/.test(kind) || rand() < 0.45;
    const facade = glass ? pick(rand, ["glass_blue", "glass_green", "glass_silver", "glass_bronze"]) : pick(rand, ["apt_white", "apt_grey", "apt_sand", "apt_charcoal"]);
    return { type: glass ? "tower" : "apartments", facade: facadeIndex(facade), roof: "flat", roofColour: flatTop(), pitch: 0, height: h ?? 40, parapet: 1.2 };
  }
  // Mid-rise: apartments, offices, or walk-up flats.
  if ((h ?? 0) >= 9 || /^(apartments|residential|dormitory|hotel|office)$/.test(kind) && info.area > 300) {
    const type = /^(office)$/.test(kind) ? "office" : /^(apartments|residential|dormitory)$/.test(kind) ? (rand() < 0.6 ? "apartments" : "flats") : weighted(rand, [["apartments", 5], ["office", 3], ["flats", 2]] as [string, number][]);
    const shopsBelow = SHOP_POI.test(poi) || (type !== "flats" && info.fronted && rand() < 0.35);
    const facade = type === "office" ? pick(rand, ["office_grey", "office_brick", "office_white"]) : type === "flats" ? pick(rand, ["flats_red", "flats_cream", "flats_brown", "flats_render"]) : pick(rand, ["apt_white", "apt_grey", "apt_sand", "apt_charcoal"]);
    const storey = LAYOUTS[FACADES[facadeIndex(facade)].layout].storey;
    const flatsHip = type === "flats" && info.rectangle && rand() < 0.5;
    return {
      type, facade: facadeIndex(facade),
      ...(shopsBelow ? { groundFacade: facadeIndex(pick(rand, ["shop_red", "shop_blue", "shop_green", "shop_black", "shop_yellow"])), awning: info.fronted } : {}),
      roof: flatsHip ? "hip" : "flat", roofColour: flatsHip ? rooftop(TILES) : flatTop(), pitch: 20,
      height: h ?? levels(storey, type === "flats" ? 3 : 5) * storey + (shopsBelow ? 1 : 0), ...(flatsHip ? {} : { parapet: 0.9 }),
    };
  }
  // Shops: a shopfront and sign, a parapet hiding the roof, an awning over the footpath, sometimes a floor above.
  if (SHOP_POI.test(poi) || /^(retail|commercial|kiosk|supermarket)$/.test(kind)) {
    const upper = (h ?? 0) > 6.5 || rand() < 0.3;
    return {
      type: "shop", facade: facadeIndex(upper ? pick(rand, ["upper_brick", "upper_cream", "upper_blue"]) : pick(rand, ["shop_red", "shop_blue", "shop_green", "shop_black", "shop_yellow"])),
      groundFacade: upper ? facadeIndex(pick(rand, ["shop_red", "shop_blue", "shop_green", "shop_black", "shop_yellow"])) : undefined,
      roof: "flat", roofColour: rooftop(["zinc", "surfmist", "shalegrey"]), pitch: 0, height: upper ? 7.2 : 4.2, parapet: 1.1, awning: info.fronted,
    };
  }
  // Warehouses and big sheds; small sheds and garages.
  if (/^(industrial|warehouse|manufacture|factory|hangar|barn|farm_auxiliary)$/.test(kind) || info.area > 700) {
    return {
      type: "warehouse", facade: facadeIndex(pick(rand, ["shed_surfmist", "shed_shale", "shed_woodland", "shed_ocean", "shed_cream", "tiltup", "tiltup"])),
      roof: info.rectangle ? "gable" : "flat", roofColour: info.rectangle ? rooftop(["zinc", "surfmist", "shalegrey", "windspray"]) : flatTop(), pitch: 6,
      height: Math.max(5, Math.min(h ?? 7, 10)), garage: true,
    };
  }
  if (/^(garage|garages|shed|carport|hut|cabin|roof)$/.test(kind) || info.area < 30) {
    return { type: "shed", facade: facadeIndex(pick(rand, ["shed_surfmist", "shed_shale", "shed_woodland", "shed_cream"])), roof: info.rectangle ? pick(rand, ["gable", "skillion"] as const) : "flat", roofColour: rooftop(["zinc", "surfmist", "shalegrey", "woodland"]), pitch: 10, height: 2.4 };
  }
  // Mid-size low buildings on the street: shops or offices.
  if (info.area > 350 && info.fronted && rand() < 0.5) {
    return { type: "shop", facade: facadeIndex(pick(rand, ["shop_red", "shop_blue", "shop_green", "shop_black", "shop_yellow"])), roof: "flat", roofColour: flatTop(), pitch: 0, height: 4.2, parapet: 1.1, awning: true };
  }
  // Houses.
  const style = weighted(rand, [
    ["brick", 34], ["modern", 16], ["weatherboard", 14], ["fibro", 7], ["queenslander", info.queensland ? 16 : 0], ["townhouse", info.area > 140 ? 9 : 0],
  ] as [string, number][]);
  const twoStorey = style === "townhouse" || (style !== "queenslander" && style !== "fibro" && info.area > 150 && rand() < 0.25);
  const wallHeight = twoStorey ? 5.7 : 2.7;
  if (style === "queenslander") {
    return {
      type: "queenslander", facade: facadeIndex(pick(rand, QLD)), roof: info.rectangle ? (rand() < 0.7 ? "hip" : "gable") : "flat",
      roofColour: info.photoRoof !== undefined && ROOF_COLOURS[info.photoRoof].kind === "metal" ? info.photoRoof : roofIndex(pick(rand, METAL)),
      pitch: 30, height: 2.9, stumps: 1.6 + rand() * 0.8, under: facadeIndex(rand() < 0.7 ? "lattice_white" : "lattice_green"), verandah: info.fronted,
    };
  }
  if (style === "modern" || style === "townhouse") {
    const shape = info.rectangle ? weighted(rand, [["skillion", 4], ["flat", 3], ["hip", 2], ["gable", 1]] as [RoofShape, number][]) : "flat";
    return {
      type: style === "townhouse" ? "townhouse" : "house", facade: facadeIndex(pick(rand, MODERN)), roof: shape,
      roofColour: shape === "flat" ? flatTop() : rooftop(METAL), pitch: shape === "skillion" ? 6 : 20, height: wallHeight, ...(shape === "flat" ? { parapet: 0.5 } : {}),
    };
  }
  const facades = style === "brick" ? BRICK : style === "weatherboard" ? WEATHERBOARD : FIBRO;
  return {
    type: "house", facade: facadeIndex(pick(rand, facades)), roof: info.rectangle ? (rand() < 0.68 ? "hip" : "gable") : "flat",
    roofColour: info.rectangle ? rooftop(style === "brick" ? [...TILES, ...METAL.slice(0, 6)] : METAL) : flatTop(),
    pitch: style === "brick" && info.photoRoof !== undefined && ROOF_COLOURS[info.photoRoof].tile ? 22 : 20, height: wallHeight,
    verandah: style === "weatherboard" && info.fronted && rand() < 0.4,
  };
}
