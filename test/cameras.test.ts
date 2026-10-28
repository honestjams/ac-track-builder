import { describe, expect, it } from "vitest";
import { planRoad } from "../src/core/road";
import { withDefaults } from "../src/core/options";
import { camerasIni, placeCameras } from "../src/core/cameras";
import type { Vec2 } from "../src/core/geo";

describe("replay cameras", () => {
  // A road heading east, then bending left (north).
  const path: Vec2[] = [
    ...Array.from({ length: 30 }, (_, i) => [i * 20, 0] as Vec2),
    ...Array.from({ length: 20 }, (_, i) => [600 + 200 * Math.sin((i + 1) * 0.08), 200 - 200 * Math.cos((i + 1) * 0.08)] as Vec2),
  ];
  const opts = withDefaults({ widthOverride: 8 });
  const plan = planRoad(path, opts);
  plan.samples.forEach((s) => (s.h = 20));
  const cams = placeCameras(plan, opts, () => 20);

  it("covers the whole road, one stretch after another", () => {
    expect(cams.length).toBeGreaterThan(3);
    expect(cams[0].in).toBe(0);
    expect(cams.at(-1)!.out).toBe(1);
    for (let i = 1; i < cams.length; i++) expect(cams[i].in).toBeCloseTo(cams[i - 1].out, 6);
  });

  it("stands off the road, up a pole, looking back at it", () => {
    for (const c of cams) {
      const near = Math.min(...plan.samples.map((s) => Math.hypot(s.pos[0] - c.pos[0], s.pos[1] + c.pos[2])));
      expect(near).toBeGreaterThan(4 + opts.vergeWidth + 5);
      expect(c.pos[1]).toBeCloseTo(24, 5);
      expect(Math.hypot(...c.forward)).toBeCloseTo(1, 5);
      expect(c.forward[1]).toBeLessThan(0); // looking down a little
    }
  });

  it("stands on the outside of a bend", () => {
    // The last camera is on the left-hand bend: outside is the right, south-east of the centre of the turn.
    const c = cams.at(-1)!;
    expect(Math.hypot(c.pos[0] - 600, -c.pos[2] - 200)).toBeGreaterThan(200);
  });

  it("moves to the other side of the road when one side is blocked", () => {
    const blockedRight = placeCameras(plan, opts, () => 20, (_x, y) => y < -1);
    for (const c of blockedRight) expect(-c.pos[2]).toBeGreaterThan(-1);
  });

  it("writes an ini the game reads", () => {
    const ini = camerasIni(cams);
    expect(ini).toContain(`CAMERA_COUNT=${cams.length}`);
    expect(ini.match(/^\[CAMERA_\d+\]/gm)).toHaveLength(cams.length);
    expect(ini).toMatch(/IN_POINT=0\.0000/);
    expect(ini).toContain("\r\n");
  });
});
