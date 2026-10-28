// Mapillary street-level detections: where its photos have located traffic
// signs, power poles, street lights and traffic lights. Read from the z14
// map feature vector tiles (one request per tile and layer). Needs the
// user's own free client access token.

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { lngLatToPixel, pixelToLngLat, type LngLat } from "../core/geo";

const Z = 14;
const LAYERS = [
  { url: "https://tiles.mapillary.com/maps/vtp/mly_map_feature_point/2", layer: "point" },
  { url: "https://tiles.mapillary.com/maps/vtp/mly_map_feature_traffic_sign/2", layer: "traffic_sign" },
];

/** Only the kinds the build knows how to place. */
const WANTED = /^(object--support--utility-pole|object--street-light|object--traffic-light|regulatory--|warning--|complementary--chevron|marking--discrete--(stop-line|crosswalk-zebra|give-way|arrow--|text--|symbol--bicycle))/;

const TOKEN_KEY = "mapillary_token";

export function savedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode: the token just isn't remembered
  }
}

export async function fetchSeen(bbox: [number, number, number, number], token: string): Promise<{ at: LngLat; value: string }[]> {
  const [w, s, e, n] = bbox;
  const a = lngLatToPixel([w, n], Z), b = lngLatToPixel([e, s], Z);
  const x0 = Math.floor(a[0] / 256), x1 = Math.floor(b[0] / 256), y0 = Math.floor(a[1] / 256), y1 = Math.floor(b[1] / 256);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 200) return [];
  const out: { at: LngLat; value: string }[] = [];
  let answered = 0;
  const jobs: Promise<void>[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      for (const L of LAYERS) {
        jobs.push((async () => {
          const r = await fetch(`${L.url}/${Z}/${tx}/${ty}?access_token=${encodeURIComponent(token)}`);
          if (!r.ok) return;
          answered++;
          const tile = new VectorTile(new PbfReader(new Uint8Array(await r.arrayBuffer())));
          const layer = tile.layers[L.layer];
          for (let i = 0; layer && i < layer.length; i++) {
            const f = layer.feature(i);
            const value = String(f.properties.value ?? "");
            if (!WANTED.test(value)) continue;
            const [p] = f.loadGeometry()[0];
            if (p.x < 0 || p.y < 0 || p.x >= layer.extent || p.y >= layer.extent) continue;
            out.push({ at: pixelToLngLat([(tx + p.x / layer.extent) * 256, (ty + p.y / layer.extent) * 256], Z), value });
          }
        })().catch(() => undefined));
      }
    }
  }
  await Promise.all(jobs);
  // A bad token gets 401/403 without CORS headers, so it surfaces as failed requests.
  if (!answered && jobs.length) throw new Error("Mapillary didn't answer: check the token");
  return out;
}
