import { describe, expect, it } from "vitest";
import { decodeSession, encodeSession } from "../src/ui/session";

describe("session links", () => {
  it("round-trips pins, loop, zones, name and changed options", () => {
    const s = {
      pins: [[153.4, -27.943], [153.4012, -27.953]] as [number, number][],
      loop: true,
      zones: [[153.401, -27.95]] as [number, number][],
      name: "Central St & Co",
      options: { width: "7", kerbs: "0" },
    };
    const hash = encodeSession(s);
    expect(hash).toContain("r=153.40000,-27.94300;153.40120,-27.95300");
    expect(decodeSession(`#${hash}`)).toEqual(s);
  });

  it("ignores junk: bad points, odd option keys, broken escapes", () => {
    const s = decodeSession("#r=1,2;x,y;500,0&o=width:7,__proto__:1,a-b:2&n=%E0%A4%A");
    expect(s.pins).toEqual([[1, 2]]);
    expect(s.options).toEqual({ width: "7" });
    expect(s.name).toBe("");
    expect(decodeSession("")).toEqual({ pins: [], loop: false, zones: [], name: "", options: {} });
  });
});
