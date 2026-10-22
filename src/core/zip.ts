import { zipSync, type Zippable } from "fflate";

/** Zips the track folder. Images and the kn5 (mostly PNG data) are stored, not deflated again. */
export function zipTrack(files: Record<string, Uint8Array>): Uint8Array {
  const z: Zippable = {};
  for (const [path, data] of Object.entries(files)) {
    const stored = /\.(png|jpg|kn5)$/i.test(path);
    z[path] = [data, { level: stored ? 0 : 6 }];
  }
  return zipSync(z);
}
