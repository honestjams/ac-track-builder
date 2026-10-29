// The build, off the page's thread: a long road takes tens of seconds of
// mesh, texture and file work that would otherwise freeze the map and the
// progress bar. Messages in: a BuildJob. Out: progress, then the outcome
// (or an error). Workers that can't draw (no OffscreenCanvas) say so, and
// the page builds itself instead.

import { runBuild, type BuildJob } from "../services/pipeline";

export type WorkerMessage =
  | { type: "unsupported" }
  | { type: "progress"; stage: string; fraction: number }
  | { type: "trace"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; outcome: Omit<import("../services/pipeline").BuildOutcome, "chunkImages">; images: [string, ImageBitmap][] };

const post = (m: WorkerMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<BuildJob>) => {
  if (typeof OffscreenCanvas === "undefined" || !new OffscreenCanvas(1, 1).getContext("2d")) {
    post({ type: "unsupported" });
    return;
  }
  try {
    const { chunkImages, ...outcome } = await runBuild(
      e.data,
      async (stage, fraction = 0) => post({ type: "progress", stage, fraction }),
      (text) => post({ type: "trace", text }),
    );
    const images: [string, ImageBitmap][] = [...chunkImages].map(([k, c]) => [k, c.transferToImageBitmap()]);
    // Hand over the big buffers (files, textures) rather than copying them.
    const buffers = new Set<ArrayBuffer>();
    const r = outcome.result;
    for (const a of [...Object.values(r.files), ...r.model.textures.map((t) => t.data), ...Object.values(r.previewTextures).map((t) => t.rgba)]) {
      if (a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
    }
    post({ type: "done", outcome, images }, [...images.map(([, b]) => b), ...buffers]);
  } catch (err) {
    console.error(err);
    post({ type: "error", message: (err as Error).message });
  }
};
