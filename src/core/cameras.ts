// Replay cameras (data/cameras_1.ini): trackside cameras every so often
// along the road, each covering the stretch of road around it, so a saved
// hotlap plays back like television coverage instead of from the chase cam.
//
// Each camera stands beyond the verge on the outside of the bend where there
// is one (the side the car comes toward), up on a 4 m pole, and covers from
// a little before it to a little after it, by normalised distance along the
// AI line (IN_POINT and OUT_POINT). The game aims it at the car and zooms
// between MIN_FOV and MAX_FOV.

import type { BuildOptions } from "./options";
import type { RoadPlan } from "./road";

const SPACING = 160; // metres of road per camera
const HEIGHT = 4;
const BACK = 7; // metres beyond the verge

export interface CameraSpot {
  /** AC world position: x east, y up, z south. */
  pos: [number, number, number];
  forward: [number, number, number];
  in: number;
  out: number;
}

/**
 * Cameras along the road. `ground` is the finished ground height at a local
 * point; `blocked` says a spot is no good (inside a building, say).
 */
export function placeCameras(
  plan: RoadPlan,
  opts: BuildOptions,
  ground: (x: number, y: number) => number,
  blocked: (x: number, y: number) => boolean = () => false,
): CameraSpot[] {
  const total = plan.length;
  if (total < 50 || plan.samples.length < 2) return [];
  const n = Math.max(1, Math.round(total / SPACING));
  const out: CameraSpot[] = [];
  for (let k = 0; k < n; k++) {
    const s0 = (k * total) / n, s1 = ((k + 1) * total) / n;
    // Stand two thirds of the way along: the car comes toward the camera, then past it.
    const at = sampleAt(plan, s0 + (s1 - s0) * 0.65);
    const s = plan.samples[at];
    // Outside of the bend over the stretch (curvature > 0 bends left, so stand right).
    let curve = 0;
    for (const q of plan.samples) if (q.s >= s0 && q.s <= s1) curve += q.curvature;
    const prefer: 1 | -1 = curve > 0 ? -1 : curve < 0 ? 1 : k % 2 ? 1 : -1;
    const spot = ([prefer, -prefer] as const)
      .map((side) => {
        const t = (s.width / 2 + opts.vergeWidth + BACK) * side;
        return [s.pos[0] + s.left[0] * t, s.pos[1] + s.left[1] * t] as [number, number];
      })
      .find(([x, y]) => !blocked(x, y));
    if (!spot) continue;
    const y = ground(spot[0], spot[1]) + HEIGHT;
    // Aim at the road where the camera's stretch begins.
    const look = plan.samples[sampleAt(plan, s0 + (s1 - s0) * 0.3)];
    const f = [look.pos[0] - spot[0], look.h + 1 - y, -(look.pos[1] - spot[1])];
    const l = Math.hypot(f[0], f[1], f[2]) || 1;
    out.push({
      pos: [spot[0], y, -spot[1]],
      forward: [f[0] / l, f[1] / l, f[2] / l],
      in: s0 / total,
      out: s1 / total,
    });
  }
  // No gaps: each camera picks up where the last one left off.
  for (let i = 0; i < out.length; i++) {
    out[i].in = i === 0 ? 0 : out[i - 1].out;
    if (i === out.length - 1) out[i].out = 1;
  }
  return out;
}

function sampleAt(plan: RoadPlan, s: number): number {
  let lo = 0, hi = plan.samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (plan.samples[mid].s < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const f3 = (v: number[]) => v.map((x) => x.toFixed(3)).join(", ");

export function camerasIni(cams: CameraSpot[], setName = "Trackside"): string {
  const lines = ["[HEADER]", "VERSION=3", `CAMERA_COUNT=${cams.length}`, `SET_NAME=${setName}`, ""];
  cams.forEach((c, i) => {
    lines.push(
      `[CAMERA_${i}]`,
      `NAME=Camera ${i + 1}`,
      `POSITION=${f3(c.pos)}`,
      `FORWARD=${f3(c.forward)}`,
      "UP=0, 1, 0",
      "MIN_FOV=8",
      "MAX_FOV=50",
      `IN_POINT=${c.in.toFixed(4)}`,
      `OUT_POINT=${c.out.toFixed(4)}`,
      "SHADOW_SPLIT0=50",
      "SHADOW_SPLIT1=250",
      "SHADOW_SPLIT2=1800",
      "NEAR_PLANE=1",
      "FAR_PLANE=2500",
      "MIN_EXPOSURE=0",
      "MAX_EXPOSURE=10000",
      "DOF_FACTOR=10",
      "DOF_RANGE=10000",
      "DOF_FOCUS=0",
      "DOF_MANUAL=0",
      "SPLINE=",
      "SPLINE_ROTATION=0",
      "FOV_GAMMA=0",
      "SPLINE_ANIMATION_LENGTH=0",
      "IS_FIXED=0",
      "",
    );
  });
  return lines.join("\r\n");
}
