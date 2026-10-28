import { describe, expect, it } from "vitest";
import { buildTrack, type DataSources } from "../src/core/track";
import { DemGrid } from "../src/core/elevation";
import type { LngLat } from "../src/core/geo";
import { readKn5, type Kn5MeshNode, type Kn5Node } from "../src/core/kn5";
import type { ArtRequest } from "../src/core/art";

const lat0 = -27.5, lng0 = 152.9;
const mLat = 111_320, mLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
const at = (x: number, y: number): LngLat => [lng0 + x / mLng, lat0 + y / mLat];

function meshes(n: Kn5Node): Kn5MeshNode[] {
  return n.kind === "mesh" ? [n] : n.children.flatMap(meshes);
}

describe("side streets, signs and furniture", async () => {
  const requested: ArtRequest[] = [];
  const route = Array.from({ length: 41 }, (_, i) => at(i * 20 - 400, 0));
  const sources: DataSources = {
    dem: async (p, b, z) => DemGrid.fromFunction(p, z, b, () => 40).sample,
    streets: {
      lines: [
        { pts: [at(-400, 0), at(400, 0)], cls: "secondary" }, // the route itself
        { pts: [at(-200, 0), at(-200, 80)], cls: "minor" }, // T junction on the left (north)
        { pts: [at(100, -80), at(100, 80)], cls: "minor" }, // crossroads
        { pts: [at(250, -80), at(250, 80)], cls: "motorway" }, // grade separated: skipped
        { pts: [at(-100, -80), at(-100, 80)], cls: "minor", brunnel: "bridge" }, // overpass: skipped
      ],
      names: [
        { pts: [at(-400, 0), at(400, 0)], name: "Main Road" },
        { pts: [at(-200, 5), at(-200, 80)], name: "Smith Street" },
        { pts: [at(100, -80), at(100, 80)], name: "Cross Street" },
      ],
    },
    pois: [
      { at: at(0, 12), cls: "bus", subclass: "bus_stop" },
      { at: at(-300, -30), cls: "fuel", subclass: "fuel", name: "Ampol Foodary" },
      { at: at(300, 20), cls: "cafe", subclass: "cafe", name: "Bean There" },
    ],
    seen: [
      { at: at(-350, -6), value: "regulatory--stop--g1" },
      { at: at(-50, 9), value: "regulatory--maximum-speed-limit-60--g1" },
      { at: at(150, -14), value: "object--support--utility-pole" },
      { at: at(160, 1), value: "object--street-light" }, // on the road: pushed to the verge
    ],
    renderArt: async (items) => {
      requested.push(...items);
      const cells = Object.fromEntries(items.map((r, i) => [r.key, { u0: 0, v0: i / items.length, u1: 1, v1: (i + 1) / items.length, aspect: 3 }]));
      return { data: new Uint8Array([137, 80, 78, 71]), cells };
    },
  };
  const result = await buildTrack(route, { name: "Streets", corridor: 60, horizon: 0, imageryZoom: 0, widthOverride: 7 }, sources);
  const kn5 = readKn5(result.files["streets/streets.kn5"]);
  const all = meshes(kn5.root);

  it("draws the T junction and both arms of the crossroads, not the overpasses", () => {
    expect(result.stats.sideStreets).toBe(3);
    const side = all.filter((m) => m.name.startsWith("1STREET_"));
    expect(side.length).toBeGreaterThan(0);
    // nothing drawn along x = 250 (motorway) or x = -100 (bridge); AC x = east
    for (const m of side) {
      for (let i = 0; i < m.positions.length; i += 3) {
        expect(Math.abs(m.positions[i] - 250)).toBeGreaterThan(6);
        expect(Math.abs(m.positions[i] + 100)).toBeGreaterThan(6);
      }
    }
  });

  it("runs side streets right up to the route's edge", () => {
    const side = all.filter((m) => m.name.startsWith("1STREET_"));
    let reaches = false;
    for (const m of side) {
      for (let i = 0; i < m.positions.length; i += 3) {
        if (Math.abs(m.positions[i] + 200) < 4 && Math.abs(-m.positions[i + 2] - 3.45) < 0.2) reaches = true;
      }
    }
    expect(reaches).toBe(true);
  });

  it("opens the verge at junction mouths", () => {
    const verge = all.filter((m) => m.name.startsWith("1GRASS_VERGE_"));
    for (const m of verge) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const cx = (m.positions[m.indices[t] * 3] + m.positions[m.indices[t + 1] * 3] + m.positions[m.indices[t + 2] * 3]) / 3;
        const cn = -(m.positions[m.indices[t] * 3 + 2] + m.positions[m.indices[t + 1] * 3 + 2] + m.positions[m.indices[t + 2] * 3 + 2]) / 3;
        // the T junction is on the north (left) side at x = -200
        if (cn > 0) expect(Math.abs(cx + 200)).toBeGreaterThan(2.5);
      }
    }
  });

  it("puts up street name blades for both streets at each named junction", () => {
    const names = requested.filter((r) => r.kind === "street").map((r) => r.text).sort();
    expect(names).toEqual(["Cross Street", "Main Road", "Smith Street"]);
    expect(result.stats.streetSigns).toBe(6); // 3 junction mouths x (side street + Main Road)
    expect(kn5.materials.find((m) => m.name === "signart")?.shader).toBe("ksPerPixelAT");
  });

  it("adds a bus stop, a servo, a cafe sign and the street-level objects", () => {
    const kinds = requested.map((r) => r.key);
    for (const k of ["bus", "stop", "speed:60", "back"]) expect(kinds).toContain(k);
    expect(kinds.some((k) => k.startsWith("poi:fuel:Ampol"))).toBe(true);
    expect(kinds.some((k) => k.startsWith("poi:cafe:Bean There"))).toBe(true);
    // Wide meshes are split into tiles (…_000_T0, …_000_T1), so match the start of the name.
    const names = all.map((m) => m.name);
    for (const m of ["FURNITURE_CANOPY_000", "FURNITURE_TIMBER_000", "FURNITURE_LAMP_000", "FURNITURE_SIGNART_000"]) {
      expect(names.some((n) => n === m || n.startsWith(`${m}_T`))).toBe(true);
    }
  });

  it("pushes objects that land on the road back onto the verge", () => {
    const steel = all.filter((m) => m.name.startsWith("FURNITURE_STEEL_"));
    expect(steel.length).toBeGreaterThan(0);
    for (const lamp of steel) {
      for (let i = 0; i < lamp.positions.length; i += 3) {
        const x = lamp.positions[i], n = -lamp.positions[i + 2];
        // the street light post near x = 160 must not stand on the 7 m road
        if (Math.abs(x - 160) < 0.2 && lamp.positions[i + 1] < 45) expect(Math.abs(n)).toBeGreaterThan(3.5);
      }
    }
  });
});

describe("Mapillary values to sign art", async () => {
  const { signArt } = await import("../src/core/furniture");
  const { ArtList } = await import("../src/core/art");
  it("maps Australian sign types and ignores the rest", () => {
    const art = new ArtList();
    expect(signArt("regulatory--maximum-speed-limit-80--g1", art)).toBe("speed:80");
    expect(signArt("regulatory--stop--g1", art)).toBe("stop");
    expect(signArt("regulatory--yield--g1", art)).toBe("giveway");
    expect(signArt("warning--curve-left--g2", art)).toBe("warning:curve-left");
    expect(signArt("information--parking--g1", art)).toBeNull();
    expect(art.list.find((r) => r.key === "speed:80")?.text).toBe("80");
  });
});

describe("merging repeat sightings", async () => {
  const { mergeSightings } = await import("../src/core/furniture");
  it("folds a traffic light seen front, back and side into one, and keeps different signs apart", () => {
    const out = mergeSightings([
      { at: [0, 0], value: "object--traffic-light--general-upright-front" },
      { at: [1.2, 0.5], value: "object--traffic-light--general-upright-back" },
      { at: [0.4, -1], value: "object--traffic-light--general-upright-side" },
      { at: [0.5, 0], value: "regulatory--stop--g1" },
      { at: [30, 0], value: "object--traffic-light--general-upright-front" },
    ]);
    expect(out.filter((f) => f.value.startsWith("object--traffic-light"))).toHaveLength(2);
    expect(out.filter((f) => f.value.startsWith("regulatory--stop"))).toHaveLength(1);
    expect(out[0].at[0]).toBeCloseTo(0.53, 1);
  });
});
