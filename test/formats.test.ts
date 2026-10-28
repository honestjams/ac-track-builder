import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { frameTransform, IDENTITY, readKn5, writeKn5, type Kn5Model } from "../src/core/kn5";
import { readFastLaneAi, writeFastLaneAi, type AiPoint } from "../src/core/aiSpline";
import { decodeOwnPng, encodePng } from "../src/core/png";

function quad(): Kn5Model {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, -1, 0, 0, -1]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  return {
    textures: [{ name: "grass.png", data: encodePng(new Uint8Array(4 * 4 * 4).fill(128), 4, 4) }],
    materials: [{
      name: "grass", shader: "ksPerPixel",
      properties: [{ name: "ksDiffuse", a: 0.4 }],
      textures: { txDiffuse: "grass.png" },
    }],
    root: {
      kind: "node", name: "track", transform: IDENTITY, children: [
        { kind: "mesh", name: "1GRASS_0", positions, normals, uvs, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), material: "grass" },
        { kind: "node", name: "AC_START_0", transform: frameTransform([0.5, 1, -0.5], [0, 0, -1]), children: [] },
      ],
    },
  };
}

describe("kn5", () => {
  it("starts with the sc6969 magic and version 5", () => {
    const bytes = writeKn5(quad());
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe("sc6969");
    expect(new DataView(bytes.buffer).getUint32(6, true)).toBe(5);
  });

  it("round-trips textures, materials, meshes and dummies", () => {
    const model = quad();
    const back = readKn5(writeKn5(model));
    expect(back.textures[0].name).toBe("grass.png");
    expect(back.textures[0].data).toEqual(model.textures[0].data);
    expect(back.materials[0]).toMatchObject({ name: "grass", shader: "ksPerPixel", textures: { txDiffuse: "grass.png" } });
    const [mesh, start] = back.root.children;
    expect(mesh.kind).toBe("mesh");
    if (mesh.kind !== "mesh") return;
    expect(Array.from(mesh.positions)).toEqual(Array.from(model.root.children[0].kind === "mesh" ? model.root.children[0].positions : []));
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(mesh.material).toBe("grass");
    expect(start.kind === "node" && start.transform.slice(12, 15)).toEqual([0.5, 1, -0.5]);
  });

  it("puts the driving direction on the dummy's Z axis and up on Y", () => {
    const t = frameTransform([0, 0, 0], [1, 0, 0]);
    expect(t.slice(4, 7).map((v) => v + 0)).toEqual([0, 1, 0]);
    expect(t.slice(8, 11).map((v) => v + 0)).toEqual([1, 0, 0]);
    // proper rotation: X = Y x Z
    expect(t.slice(0, 3).map((v) => Math.round(v) + 0)).toEqual([0, 0, -1]);
  });

  it("rejects meshes that reference missing materials or overflow u16 indices", () => {
    const m = quad();
    const mesh = m.root.children[0];
    if (mesh.kind === "mesh") mesh.material = "nope";
    expect(() => writeKn5(m)).toThrow(/missing material/);
    const big = quad();
    const bm = big.root.children[0];
    if (bm.kind === "mesh") {
      bm.positions = new Float32Array(70000 * 3);
      bm.normals = new Float32Array(70000 * 3);
      bm.uvs = new Float32Array(70000 * 2);
    }
    expect(() => writeKn5(big)).toThrow(/vertices/);
  });
});

describe("kn5 texture registers", () => {
  it("binds each texture slot to the shader's register, whatever order they're listed in", () => {
    const tex = (name: string) => ({ name, data: encodePng(new Uint8Array(4).fill(255), 1, 1) });
    const model: Kn5Model = {
      textures: [tex("d.png"), tex("n.png"), tex("m.png"), tex("x.png")],
      materials: [{
        name: "road", shader: "ksPerPixelMultiMap", properties: [],
        textures: { txDetail: "x.png", txMaps: "m.png", txDiffuse: "d.png", txNormal: "n.png" },
      }],
      root: { kind: "node", name: "root", transform: IDENTITY, children: [] },
    };
    const back = readKn5(writeKn5(model));
    expect(back.materials[0].registers).toEqual({ txDetail: 3, txMaps: 2, txDiffuse: 0, txNormal: 1 });
  });
});

describe("fast_lane.ai", () => {
  it("round-trips a version 7 spline", () => {
    const pts: AiPoint[] = [0, 1, 2].map((i) => ({
      position: [i * 2, 0, 0], distance: i * 2, speed: 20, gas: 1, brake: 0, radius: 1000,
      sideLeft: 3, sideRight: 3, camber: 0, direction: 1, normal: [0, 1, 0], length: 2,
      forward: [1, 0, 0], grade: 0,
    }));
    const bytes = writeFastLaneAi(pts);
    // header 16 + 3 * 20 base + 4 + 3 * 72 extra + 4 grid flag
    expect(bytes.length).toBe(16 + 60 + 4 + 216 + 4);
    expect(readFastLaneAi(bytes)).toEqual(pts);
  });
});

describe("png", () => {
  it("writes a valid signature, header and decodable pixel data", () => {
    const px = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 4]);
    const png = encodePng(px, 2, 2);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(2);
    expect(view.getUint32(20)).toBe(2);
    const idatLen = view.getUint32(33);
    const raw = unzlibSync(png.subarray(41, 41 + idatLen));
    // row 0 filter byte then pixels unchanged ("up" against zero row)
    expect(raw[0]).toBe(2);
    expect(Array.from(raw.subarray(1, 9))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    // row 1 stored as difference from row 0
    expect(raw[10 + 0]).toBe((0 - 255) & 0xff);
  });
});

describe("dds", () => {
  it("writes a DXT1 header and a full mip chain", async () => {
    const { encodeDdsDxt1 } = await import("../src/core/dds");
    const px = new Uint8Array(8 * 8 * 4);
    for (let i = 0; i < 64; i++) px.set([255, 0, 0, 255], i * 4);
    const dds = encodeDdsDxt1(px, 8, 8);
    const v = new DataView(dds.buffer);
    expect(new TextDecoder().decode(dds.subarray(0, 4))).toBe("DDS ");
    expect(v.getUint32(4, true)).toBe(124);
    expect(v.getUint32(28, true)).toBe(4); // 8, 4, 2, 1
    expect(new TextDecoder().decode(dds.subarray(84, 88))).toBe("DXT1");
    expect(dds.length).toBe(128 + (4 + 1 + 1 + 1) * 8);
    expect(v.getUint16(128, true)).toBe(0xf800); // pure red endpoint
  });
});

describe("png round trip", () => {
  it("decodes what it encodes, RGB and RGBA", () => {
    const w = 5, h = 3;
    const px = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 37) % 256);
    const back = decodeOwnPng(encodePng(px, w, h));
    expect(back.width).toBe(w);
    expect(Array.from(back.rgba)).toEqual(Array.from(px));
    const rgb = decodeOwnPng(encodePng(px, w, h, { alpha: false }));
    for (let i = 0; i < w * h; i++) {
      expect([rgb.rgba[i * 4], rgb.rgba[i * 4 + 1], rgb.rgba[i * 4 + 2], rgb.rgba[i * 4 + 3]]).toEqual([px[i * 4], px[i * 4 + 1], px[i * 4 + 2], 255]);
    }
  });
});
