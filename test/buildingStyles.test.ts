import { describe, expect, it } from "vitest";
import { buildBuildings, plainHouse, type Building } from "../src/core/buildings";
import { dressBuilding, FACADES, facadeTexture, LAYOUTS, ROOF_COLOURS, roofTexture, type DressInfo } from "../src/core/buildingStyles";
import { decodeOwnPng } from "../src/core/png";
import type { Kn5MeshNode } from "../src/core/kn5";

const info = (o: Partial<DressInfo>): DressInfo => ({ area: 160, queensland: false, rectangle: true, fronted: true, seed: 1, ...o });

describe("building types", () => {
  it("makes tall buildings towers or apartments, with flat roofs behind a parapet", () => {
    for (let seed = 0; seed < 20; seed++) {
      const d = dressBuilding(info({ height: 60, area: 900, seed }));
      expect(["tower", "apartments"]).toContain(d.type);
      expect(d.roof).toBe("flat");
      expect(d.parapet).toBeGreaterThan(0);
      expect(d.height).toBe(60);
    }
  });

  it("makes a building with a cafe in it a shop, with an awning over the footpath", () => {
    const d = dressBuilding(info({ poi: "cafe", area: 220 }));
    expect(d.type).toBe("shop");
    expect(d.awning).toBe(true);
    const shopfront = d.groundFacade ?? d.facade;
    expect(FACADES[shopfront].layout).toBe("shopfront");
  });

  it("makes big low footprints warehouses with a roller door, small ones sheds", () => {
    expect(dressBuilding(info({ area: 1200 })).type).toBe("warehouse");
    expect(dressBuilding(info({ area: 1200 })).garage).toBe(true);
    expect(dressBuilding(info({ area: 18 })).type).toBe("shed");
  });

  it("raises some Queensland houses on stumps with a verandah, and none elsewhere", () => {
    const qld = Array.from({ length: 200 }, (_, seed) => dressBuilding(info({ queensland: true, seed })));
    const raised = qld.filter((d) => d.type === "queenslander");
    expect(raised.length).toBeGreaterThan(15);
    for (const d of raised) {
      expect(d.stumps).toBeGreaterThan(1.5);
      expect(d.verandah).toBe(true);
      expect(ROOF_COLOURS[d.roofColour].kind).toBe("metal");
    }
    expect(Array.from({ length: 200 }, (_, seed) => dressBuilding(info({ seed }))).some((d) => d.type === "queenslander")).toBe(false);
  });

  it("uses many different facades and roofs across a suburb", () => {
    const ds = Array.from({ length: 300 }, (_, seed) => dressBuilding(info({ queensland: true, seed, area: 80 + (seed % 7) * 40 })));
    expect(new Set(ds.map((d) => d.facade)).size).toBeGreaterThan(20);
    expect(new Set(ds.map((d) => d.roofColour)).size).toBeGreaterThan(12);
  });

  it("keeps the roof colour seen in the photo", () => {
    const tile = ROOF_COLOURS.findIndex((r) => r.name === "terracotta");
    for (let seed = 0; seed < 30; seed++) {
      const d = dressBuilding(info({ photoRoof: tile, seed }));
      if (d.type === "house" && d.roof !== "flat") expect(d.roofColour).toBe(tile);
    }
  });
});

describe("facade and roof textures", () => {
  it("are one period by one storey at about 32 px a metre, sides a multiple of 4 for DXT", () => {
    for (const f of FACADES) {
      const { width, height } = decodeOwnPng(facadeTexture(f));
      const L = LAYOUTS[f.layout];
      expect(Math.abs(width - L.period * 32)).toBeLessThanOrEqual(2);
      expect(Math.abs(height - L.storey * 32)).toBeLessThanOrEqual(2);
      expect(width % 4 + height % 4).toBe(0);
    }
    for (const r of ROOF_COLOURS) expect(decodeOwnPng(roofTexture(r)).width).toBe(128);
  });

  it("keep windows out of the band used for gable ends", () => {
    for (const L of Object.values(LAYOUTS)) {
      for (const o of L.openings) expect(o.z0 >= L.plain[1] || o.z1 <= L.plain[0]).toBe(true);
    }
  });
});

describe("building geometry", () => {
  // A 12 x 8 m footprint at ground level 10, the front wall along y = 0 (facing south, toward a road).
  const ring: [number, number][] = [[0, 0], [12, 0], [12, 8], [0, 8]];
  const build = (d: Partial<Building>) => buildBuildings([{ ring, ...plainHouse("hip", 0, 2.8), source: "osm", front: [[0, 0], [12, 0]], setback: 6, ...d }], () => 10);
  const verts = (nodes: Kn5MeshNode[], re: RegExp) => nodes.filter((n) => re.test(n.name)).flatMap((n) =>
    Array.from({ length: n.positions.length / 3 }, (_, i) => [n.positions[i * 3], -n.positions[i * 3 + 2], n.positions[i * 3 + 1]]));
  const normals = (nodes: Kn5MeshNode[], re: RegExp) => nodes.filter((n) => re.test(n.name)).flatMap((n) =>
    Array.from({ length: n.normals.length / 3 }, (_, i) => [n.normals[i * 3], -n.normals[i * 3 + 2], n.normals[i * 3 + 1]]));
  const facade = (name: string) => FACADES.findIndex((f) => f.name === name);

  it("raises a Queenslander on stumps behind lattice, with a verandah, deck and posts out front", () => {
    const nodes = build({ type: "queenslander", facade: facade("qld_white"), stumps: 2, under: facade("lattice_white"), verandah: true, pitch: 30, height: 2.9 });
    const lattice = verts(nodes, /^1WALL_BLD_lattice_white/);
    expect(Math.max(...lattice.map((p) => p[2]))).toBeCloseTo(12, 3); // up to the floor
    const wall = verts(nodes, /^1WALL_BLD_qld_white/);
    expect(Math.min(...wall.map((p) => p[2]))).toBeCloseTo(12, 3); // walls start at the floor
    expect(Math.max(...wall.map((p) => p[2]))).toBeCloseTo(14.9, 3);
    const deck = verts(nodes, /^DECK_/);
    expect(deck.every((p) => Math.abs(p[2] - 12) < 1e-3)).toBe(true);
    expect(Math.min(...deck.map((p) => p[1]))).toBeLessThan(-2); // out in front (south)
    expect(normals(nodes, /^DECK_/).every((n) => n[2] > 0.99)).toBe(true);
    const posts = verts(nodes, /^POSTS_/);
    expect(posts.length).toBeGreaterThan(0);
    // The verandah roof slopes down away from the house.
    const roofFront = verts(nodes, /^ROOF_/).filter((p) => p[1] < -1);
    expect(roofFront.length).toBeGreaterThan(0);
    expect(Math.max(...roofFront.map((p) => p[2]))).toBeLessThan(14.9);
  });

  it("gives a shop a shopfront, a parapet above its flat roof and an awning facing up and out", () => {
    const nodes = build({ type: "shop", facade: facade("shop_red"), roof: "flat", roofColour: ROOF_COLOURS.findIndex((r) => r.name === "membrane"), height: 4.2, parapet: 1.1, awning: true });
    const roof = verts(nodes, /^ROOF_/);
    expect(Math.max(...roof.map((p) => p[2]))).toBeCloseTo(14.2, 3);
    const wall = verts(nodes, /^1WALL_BLD_shop_red/);
    expect(Math.max(...wall.map((p) => p[2]))).toBeCloseTo(15.3, 3);
    const aw = verts(nodes, /^AWNING_/);
    expect(Math.min(...aw.map((p) => p[1]))).toBeCloseTo(-3, 3);
    expect(Math.min(...aw.map((p) => p[2]))).toBeCloseTo(13, 3);
    const n = normals(nodes, /^AWNING_/);
    expect(n.some((v) => v[2] > 0.99)).toBe(true); // top
    expect(n.some((v) => v[2] < -0.99)).toBe(true); // underside
    expect(n.some((v) => v[1] < -0.99)).toBe(true); // fascia, facing the street
  });

  it("puts shops under apartments on their own band of wall", () => {
    const nodes = build({ type: "apartments", facade: facade("apt_white"), groundFacade: facade("shop_blue"), roof: "flat", height: 13, parapet: 0.9 });
    const shop = verts(nodes, /^1WALL_BLD_shop_blue/), apt = verts(nodes, /^1WALL_BLD_apt_white/);
    expect(Math.max(...shop.map((p) => p[2]))).toBeCloseTo(14, 3);
    expect(Math.min(...apt.filter((p) => p[2] > 13).map((p) => p[2]))).toBeCloseTo(14, 3);
  });

  it("slopes a skillion roof one way, high side over the long front wall", () => {
    const nodes = build({ roof: "skillion", pitch: 6, facade: facade("render_white") });
    const roof = verts(nodes, /^ROOF_/);
    const hi = roof.filter((p) => p[1] < 1), lo = roof.filter((p) => p[1] > 7);
    expect(Math.min(...hi.map((p) => p[2]))).toBeGreaterThan(Math.max(...lo.map((p) => p[2])));
    expect(normals(nodes, /^ROOF_/).every((n) => n[2] > 0.9)).toBe(true);
  });

  it("gives a warehouse a big roller door and no front door", () => {
    const nodes = build({ type: "warehouse", facade: facade("shed_surfmist"), roof: "gable", pitch: 6, height: 7, garage: true });
    const door = verts(nodes, /^GARAGE_/);
    expect(Math.max(...door.map((p) => p[2])) - 10).toBeCloseTo(4.2, 2);
    expect(nodes.some((n) => /^DOOR_/.test(n.name))).toBe(false);
  });
});
