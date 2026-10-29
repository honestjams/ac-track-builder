import { describe, expect, it } from "vitest";
import { ArtList } from "../src/core/art";
import type { Vec2 } from "../src/core/geo";
import type { Kn5MeshNode } from "../src/core/kn5";
import { withDefaults } from "../src/core/options";
import { raceDressing, raceZones } from "../src/core/raceDress";
import { planRoad } from "../src/core/road";
import { sponsors } from "../src/core/sponsors";

// 300 m east, a 90 degree left turn of radius 25 m, then 200 m north.
function route(): Vec2[] {
  const pts: Vec2[] = [];
  for (let x = 0; x <= 300; x += 5) pts.push([x, 0]);
  for (let a = 5; a <= 90; a += 5) pts.push([300 + 25 * Math.sin((a * Math.PI) / 180), 25 - 25 * Math.cos((a * Math.PI) / 180)]);
  for (let y = 30; y <= 225; y += 5) pts.push([325, y]);
  return pts;
}

const opts = withDefaults({ widthOverride: 8 });
const plan = planRoad(route(), opts);
const ground = () => 0;
const verts = (nodes: Kn5MeshNode[], re: RegExp) => nodes.filter((n) => re.test(n.name)).flatMap((n) =>
  Array.from({ length: n.positions.length / 3 }, (_, i) => [n.positions[i * 3], -n.positions[i * 3 + 2], n.positions[i * 3 + 1]] as [number, number, number]));
/** Distance from a point to the road's centreline. */
const fromCentre = (x: number, y: number) => Math.min(...plan.samples.map((s) => Math.hypot(s.pos[0] - x, s.pos[1] - y)));

describe("race-day zones", () => {
  it("covers the start straight both sides and the outside of the tight corner", () => {
    const zones = raceZones(plan);
    expect(zones.filter((z) => z.s0 < 10 && z.s1 > 200).map((z) => z.side).sort()).toEqual([-1, 1]);
    const corner = zones.find((z) => z.tyres);
    expect(corner).toBeDefined();
    expect(corner!.side).toBe(-1); // a left turn: the outside is on the right
  });
});

describe("race-day dressing", () => {
  const art = new ArtList();
  const race = raceDressing(plan, opts, art, { ground, blocked: () => false }, "Supercheap Auto, Repco, Made Up Motors");

  it("keeps every barrier, tyre wall and fence off the road", () => {
    for (const [x, y] of verts(race.nodes, /^(1WALL_RACE|RACE_FENCE)/)) expect(fromCentre(x, y)).toBeGreaterThan(4 + 0.5);
    expect(race.stats.barrierMetres).toBeGreaterThan(400);
  });

  it("faces the barrier's road side toward the road", () => {
    for (const n of race.nodes.filter((m) => /^1WALL_RACE_BARRIER/.test(m.name))) {
      for (let t = 0; t < n.indices.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => [n.positions[n.indices[t + k] * 3], -n.positions[n.indices[t + k] * 3 + 2], n.positions[n.indices[t + k] * 3 + 1]]);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
        if (cz > 0.25 || Math.hypot(nrm[0], nrm[1]) < 1e-6) continue;
        // The low, road-side face: its normal leans toward the centreline.
        const d0 = fromCentre(cx, cy), l = Math.hypot(nrm[0], nrm[1], nrm[2]);
        const d1 = fromCentre(cx + (nrm[0] / l) * 0.2, cy + (nrm[1] / l) * 0.2);
        if (d0 < Math.min(...[a, b, c].map((p) => fromCentre(p[0], p[1]))) + 0.02) expect(d1).toBeLessThan(d0);
      }
    }
  });

  it("puts a tyre wall on the outside of the corner only", () => {
    const tyres = verts(race.nodes, /^1WALL_RACE_TYRES/);
    expect(tyres.length).toBeGreaterThan(0);
    // Outside of a left turn east-then-north: south and east of the corner's centre (300, 25).
    for (const [x, y] of tyres) expect(Math.hypot(x - 300, y - 25)).toBeGreaterThan(25 + 4);
  });

  it("builds a start gantry with lights and sponsor banners, a grandstand and spectators", () => {
    const keys = art.list.map((r) => r.key);
    expect(keys).toContain("lights");
    expect(art.list.filter((r) => r.kind === "banner").map((r) => r.text)).toEqual(["Supercheap Auto", "Repco", "Made Up Motors"]);
    expect(race.pieces.some((p) => p.kind === "face" && p.art === "lights")).toBe(true);
    expect(race.stats.grandstand).toBe(true);
    expect(race.stats.spectators).toBeGreaterThan(100);
    expect(race.nodes.some((n) => /^RACE_CROWD_/.test(n.name))).toBe(true);
    expect(race.nodes.some((n) => /^RACE_SPECTATORS_/.test(n.name))).toBe(true);
  });

  it("leaves a gap where a side street joins, and no grandstand where there's no room", () => {
    // A side street on the left (north) at x 100-112, and buildings everywhere beyond 9 m.
    const blocked = ([x, y]: Vec2) => (y > 0 && x > 100 && x < 112 && y < 30) || fromCentre(x, y) > 9;
    const r = raceDressing(plan, opts, new ArtList(), { ground, blocked: (x, y) => blocked([x, y]) }, "Repco");
    const left = verts(r.nodes, /^1WALL_RACE_BARRIER/).filter(([x, y]) => y > 0 && x < 290);
    expect(left.length).toBeGreaterThan(0);
    expect(left.some(([x]) => x > 101 && x < 111)).toBe(false);
    expect(r.stats.grandstand).toBe(false);
  });
});

describe("sponsors", () => {
  it("gives known brands their colours and anything else a colour of its own", () => {
    const s = sponsors("Supercheap Auto,  , Bob Jane T-Marts, Fred's Tyres");
    expect(s.map((x) => x.name)).toEqual(["Supercheap Auto", "Bob Jane T-Marts", "Fred's Tyres"]);
    expect(s[0].bg).toBe("#e2231a");
    expect(s[1].ink).toBe("#141414");
    expect(s[2].bg).toMatch(/^hsl\(/);
  });
});
