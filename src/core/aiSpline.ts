// Writer (and reader, for tests) for ai/fast_lane.ai, the AI racing line.
//
// Version 7 layout, as read by Content Manager (AcTools.AiFile.AiSpline) and
// AssettoServer (FastLaneParser.FromFileV7):
//
//   i32 version = 7
//   i32 pointCount, i32 lapTime, i32 sampleCount
//   pointCount x { f32[3] position, f32 length (distance along), i32 id }
//   i32 extraCount (= pointCount)
//   extraCount x { f32 speed, f32 gas, f32 brake, f32 obsoleteLatG,
//                  f32 radius, f32 sideLeft, f32 sideRight,
//                  f32 camber, f32 direction, f32[3] normal, f32 length,
//                  f32[3] forward, f32 tag, f32 grade }
//   i32 hasGrid, then the spatial lookup grid when non-zero. We write 0:
//   Content Manager reads such files; whether the game wants the grid is
//   still to be confirmed in-game (docs/verification.md).
//
// Positions are AC world space (X east, Y up, Z south).

import { BinaryReader, BinaryWriter } from "./binary";

export interface AiPoint {
  position: [number, number, number];
  /** Distance from the first point along the line, metres. */
  distance: number;
  /** Target speed, m/s. */
  speed: number;
  gas: number;
  brake: number;
  /** Turn radius, metres (large on straights). */
  radius: number;
  /** Distance from the line to the left / right edge of the road, metres. */
  sideLeft: number;
  sideRight: number;
  /** Bank angle, radians, with its sign carried by `direction`. */
  camber: number;
  direction: 1 | -1;
  normal: [number, number, number];
  /** Length of the segment to the next point, metres. */
  length: number;
  forward: [number, number, number];
  /** Slope along the line (rise / run). */
  grade: number;
}

export const AI_SPLINE_VERSION = 7;

export function writeFastLaneAi(points: AiPoint[]): Uint8Array {
  const w = new BinaryWriter(points.length * 120 + 64);
  w.i32(AI_SPLINE_VERSION).i32(points.length).i32(0).i32(0);
  points.forEach((p, i) => {
    w.f32s(p.position).f32(p.distance).i32(i);
  });
  w.i32(points.length);
  for (const p of points) {
    w.f32(p.speed).f32(p.gas).f32(p.brake).f32(0);
    w.f32(p.radius).f32(p.sideLeft).f32(p.sideRight);
    w.f32(p.camber).f32(p.direction);
    w.f32s(p.normal).f32(p.length).f32s(p.forward);
    w.f32(0).f32(p.grade);
  }
  w.i32(0);
  return w.finish();
}

export function readFastLaneAi(data: Uint8Array): AiPoint[] {
  const r = new BinaryReader(data);
  const version = r.i32();
  if (version !== AI_SPLINE_VERSION) throw new Error(`Unsupported AI spline version ${version}`);
  const count = r.i32();
  r.i32();
  r.i32();
  const base = [];
  for (let i = 0; i < count; i++) {
    base.push({ position: r.f32s(3) as [number, number, number], distance: r.f32(), id: r.i32() });
  }
  const extraCount = r.i32();
  if (extraCount !== count) throw new Error("AI spline extra count does not match point count");
  const out: AiPoint[] = [];
  for (let i = 0; i < count; i++) {
    const speed = r.f32(), gas = r.f32(), brake = r.f32();
    r.f32();
    const radius = r.f32(), sideLeft = r.f32(), sideRight = r.f32();
    const camber = r.f32(), direction = (r.f32() < 0 ? -1 : 1) as 1 | -1;
    const normal = r.f32s(3) as [number, number, number];
    const length = r.f32();
    const forward = r.f32s(3) as [number, number, number];
    r.f32();
    const grade = r.f32();
    out.push({
      position: base[i].position, distance: base[i].distance, speed, gas, brake, radius,
      sideLeft, sideRight, camber, direction, normal, length, forward, grade,
    });
  }
  if (r.i32() !== 0) throw new Error("Grid data is not supported by this reader");
  if (r.remaining !== 0) throw new Error(`${r.remaining} trailing bytes`);
  return out;
}
