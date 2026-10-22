// The AI line: the road centreline with a speed profile from corner radii
// (lateral grip), limited by braking into corners and acceleration out.

import type { AiPoint } from "./aiSpline";
import { toAc } from "./mesh";
import type { RoadPlan } from "./road";

const G = 9.81;
const LATERAL_GRIP = 1.0; // g
const BRAKE = 7; // m/s^2
const ACCEL = 3.5; // m/s^2
const VMAX = 70; // m/s

export function buildAiLine(plan: RoadPlan): AiPoint[] {
  const s = plan.samples;
  const n = s.length;
  const radius = s.map((p) => Math.min(1000, 1 / Math.max(1e-3, Math.abs(p.curvature))));
  const seg = s.map((p, i) => {
    if (!plan.closed && i === n - 1) return 0;
    const q = s[(i + 1) % n];
    return Math.hypot(q.pos[0] - p.pos[0], q.pos[1] - p.pos[1], q.h - p.h);
  });
  let v = radius.map((r) => Math.min(VMAX, Math.sqrt(LATERAL_GRIP * G * r)));
  // Loops are run twice around so the limits carry across the start line.
  const passes = plan.closed ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = n - 2 + (plan.closed ? 1 : 0); i >= 0; i--) {
      const next = (i + 1) % n;
      v[i] = Math.min(v[i], Math.sqrt(v[next] ** 2 + 2 * BRAKE * seg[i]));
    }
  }
  // Open roads start from a standstill on the grid.
  if (!plan.closed) v[0] = Math.min(v[0], 5);
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < n + (plan.closed ? 1 : 0); i++) {
      const cur = i % n, prev = i - 1;
      v[cur] = Math.min(v[cur], Math.sqrt(v[prev] ** 2 + 2 * ACCEL * seg[prev]));
    }
  }
  v = v.map((x) => Math.max(3, x));

  let distance = 0;
  return s.map((p, i) => {
    const q = s[(i + 1) % n];
    const grade = seg[i] > 0 ? (q.h - p.h) / seg[i] : 0;
    const bankAngle = Math.atan(Math.abs(p.bank));
    const slowing = (plan.closed || i < n - 1) && v[(i + 1) % n] < v[i] - 0.05;
    const point: AiPoint = {
      position: toAc(p.pos[0], p.pos[1], p.h),
      distance,
      speed: v[i],
      gas: slowing ? 0 : 1,
      brake: slowing ? 1 : 0,
      radius: radius[i],
      sideLeft: p.width / 2,
      sideRight: p.width / 2,
      camber: bankAngle,
      direction: p.bank >= 0 ? 1 : -1,
      normal: [0, 1, 0],
      length: seg[i],
      forward: toAc(p.tan[0], p.tan[1], 0),
      grade,
    };
    distance += seg[i];
    return point;
  });
}
