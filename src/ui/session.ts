// A session as a short URL fragment: the pins, loop, no-trace zones, the
// track name and any options changed from their defaults. The page keeps its
// address up to date, so a reload brings the road back and the link can be
// shared to reproduce a build. Secrets (the Mapillary token) never go in it.
//
//   #r=153.40000,-27.94300;153.40120,-27.95300&l=1&z=153.4,-27.95&n=Central+St&o=width:7,kerbs:0

import type { LngLat } from "../core/geo";

export interface Session {
  pins: LngLat[];
  loop: boolean;
  zones: LngLat[];
  name: string;
  /** Changed options by control id: string values, or "1"/"0" for checkboxes. */
  options: Record<string, string>;
}

const pt = ([lng, lat]: LngLat) => `${lng.toFixed(5)},${lat.toFixed(5)}`;

function points(s: string | null): LngLat[] {
  if (!s) return [];
  return s.split(";").map((p) => p.split(",").map(Number) as LngLat)
    .filter((p) => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
}

export function encodeSession(s: Session): string {
  const parts: string[] = [];
  if (s.pins.length) parts.push(`r=${s.pins.map(pt).join(";")}`);
  if (s.loop) parts.push("l=1");
  if (s.zones.length) parts.push(`z=${s.zones.map(pt).join(";")}`);
  if (s.name) parts.push(`n=${encodeURIComponent(s.name)}`);
  const opts = Object.entries(s.options).map(([k, v]) => `${k}:${encodeURIComponent(v)}`);
  if (opts.length) parts.push(`o=${opts.join(",")}`);
  return parts.join("&");
}

export function decodeSession(hash: string): Session {
  const params = new Map<string, string>();
  for (const part of hash.replace(/^#/, "").split("&")) {
    const i = part.indexOf("=");
    if (i > 0) params.set(part.slice(0, i), part.slice(i + 1));
  }
  const options: Record<string, string> = {};
  for (const kv of (params.get("o") ?? "").split(",")) {
    const i = kv.indexOf(":");
    // Control ids only: letters and digits, so nothing odd can be addressed.
    if (i > 0 && /^[A-Za-z][A-Za-z0-9]*$/.test(kv.slice(0, i))) options[kv.slice(0, i)] = safeDecode(kv.slice(i + 1));
  }
  return {
    pins: points(params.get("r") ?? null),
    loop: params.get("l") === "1",
    zones: points(params.get("z") ?? null),
    name: safeDecode(params.get("n") ?? "").slice(0, 60),
    options,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return "";
  }
}
