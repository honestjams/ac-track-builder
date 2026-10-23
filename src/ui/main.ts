import "leaflet/dist/leaflet.css";
import "./style.css";
import L from "leaflet";
import type { LngLat } from "../core/geo";
import { buildTrack, type TrackResult } from "../core/track";
import { zipTrack } from "../core/zip";
import type { BuildOptions } from "../core/options";
import { fetchOsm, reverseGeocode, route, widthLookup, searchPlaces, type Place, type Route } from "../services/osm";
import { IMAGERY, imageryChain, loadChunkImagery, loadDem, type ImagerySource } from "../services/tiles";
import { createPreview, type PreviewScene } from "./preview";
import { renderArt } from "../services/art";
import { loadRouteRaster } from "../services/raster";
import { fetchSeen, savedToken, saveToken } from "../services/mapillary";
import { classWidths, fetchTileFeatures, roadClassLookup } from "../services/vectorTiles";

const MAX_KM = 30;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------------- map ---------------- */

const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([-27.95, 153.2], 11);
const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
});
const aerial = L.tileLayer(IMAGERY.esri.template, {
  maxZoom: 19,
  attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
});
street.addTo(map);
const stateLayer = (src: ImagerySource) => L.tileLayer(IMAGERY[src].template, { maxZoom: 21, maxNativeZoom: IMAGERY[src].maxZoom, attribution: IMAGERY[src].label });
L.control.layers({
  Street: street,
  "Aerial (Esri)": aerial,
  "Aerial (Queensland)": stateLayer("qld"),
  "Aerial (NSW)": stateLayer("nsw"),
}, undefined, { position: "topright" }).addTo(map);

// Open near the visitor's region, guessed from the time zone (no location prompt).
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
const views: [RegExp, [number, number], number][] = [
  [/^Australia\//, [-27.95, 153.2], 10],
  [/^Pacific\/Auckland/, [-41.2, 174.8], 8],
  [/^Asia\/Tokyo/, [35.36, 138.73], 9],
  [/^Europe\//, [47.0, 10.0], 6],
  [/^America\//, [39.0, -100.0], 4],
];
const view = views.find(([re]) => re.test(zone));
if (view) map.setView(view[1], view[2]);

/* ---------------- pins and route ---------------- */

let pins: LngLat[] = [];
let markers: L.Marker[] = [];
let current: Route | null = null;
let routeLine: L.Polyline | null = null;
let routeSeq = 0;
let nameTouched = false;
let placeMeta: { country?: string; city?: string } = {};

function pinIcon(kind: "start" | "via" | "finish", label: string): L.DivIcon {
  const color = kind === "start" ? "var(--start)" : kind === "finish" ? "var(--finish)" : "var(--via)";
  return L.divIcon({
    className: "",
    html: `<div class="pin-icon" style="background:${color}">${label}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function kindOf(i: number): "start" | "via" | "finish" {
  if (i === 0) return "start";
  return i === pins.length - 1 ? "finish" : "via";
}

function renderPins(): void {
  markers.forEach((m) => m.remove());
  markers = pins.map((p, i) => {
    const kind = kindOf(i);
    const m = L.marker([p[1], p[0]], {
      draggable: true,
      icon: pinIcon(kind, kind === "start" ? "A" : kind === "finish" ? "B" : String(i)),
      keyboard: true,
      title: kind === "via" ? `Via ${i}` : kind === "start" ? "Start" : "Finish",
    }).addTo(map);
    m.on("dragend", () => {
      const ll = m.getLatLng();
      pins[i] = [ll.lng, ll.lat];
      refreshRoute();
    });
    m.on("contextmenu", () => removePin(i));
    return m;
  });

  const list = $("pins");
  list.innerHTML = "";
  pins.forEach((p, i) => {
    const kind = kindOf(i);
    const li = document.createElement("li");
    const label = kind === "start" ? "Start" : kind === "finish" ? "Finish" : `Via ${i}`;
    li.innerHTML = `<span class="dot" style="background:var(--${kind})"></span><span>${label}</span><span class="coord">${p[1].toFixed(5)}, ${p[0].toFixed(5)}</span>`;
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.setAttribute("aria-label", `Remove ${label}`);
    del.onclick = () => removePin(i);
    li.append(del);
    list.append(li);
  });
  $<HTMLButtonElement>("reverse").disabled = pins.length < 2;
  $<HTMLButtonElement>("clear").disabled = pins.length === 0;
  $("pin-hint").textContent = pins.length === 0
    ? "Click the map where the road starts, then where it finishes. More clicks extend the route through those points."
    : pins.length === 1
      ? "Now click where the road finishes."
      : "Drag pins to adjust. Click to extend the route; right-click a pin to remove it.";
}

function removePin(i: number): void {
  pins.splice(i, 1);
  renderPins();
$<HTMLInputElement>("mapillaryToken").value = savedToken();

// Test hook for the browser smoke test (dev server only).
if (import.meta.env.DEV) {
  (window as unknown as { __app: object }).__app = {
    map,
    addPin(p: LngLat) {
      pins.push(p);
      renderPins();
      refreshRoute();
    },
    result: () => lastResult,
    preview: () => preview,
  };
}
  refreshRoute();
}

map.on("click", (e: L.LeafletMouseEvent) => {
  pins.push([e.latlng.lng, e.latlng.lat]);
  renderPins();

// Test hook for the browser smoke test (dev server only).
if (import.meta.env.DEV) {
  (window as unknown as { __app: object }).__app = {
    map,
    addPin(p: LngLat) {
      pins.push(p);
      renderPins();
      refreshRoute();
    },
    result: () => lastResult,
    preview: () => preview,
  };
}
  refreshRoute();
});

$("reverse").onclick = () => {
  pins.reverse();
  renderPins();

// Test hook for the browser smoke test (dev server only).
if (import.meta.env.DEV) {
  (window as unknown as { __app: object }).__app = {
    map,
    addPin(p: LngLat) {
      pins.push(p);
      renderPins();
      refreshRoute();
    },
    result: () => lastResult,
    preview: () => preview,
  };
}
  refreshRoute();
};
$("clear").onclick = () => {
  pins = [];
  renderPins();

// Test hook for the browser smoke test (dev server only).
if (import.meta.env.DEV) {
  (window as unknown as { __app: object }).__app = {
    map,
    addPin(p: LngLat) {
      pins.push(p);
      renderPins();
      refreshRoute();
    },
    result: () => lastResult,
    preview: () => preview,
  };
}
  refreshRoute();
};
$<HTMLInputElement>("loop").onchange = () => refreshRoute();

let routeTimer: number | undefined;
function refreshRoute(): void {
  clearTimeout(routeTimer);
  routeTimer = window.setTimeout(doRoute, 250);
}

async function doRoute(): Promise<void> {
  const seq = ++routeSeq;
  const err = $("route-error");
  err.hidden = true;
  current = null;
  updateBuildButton();
  if (pins.length < 2) {
    routeLine?.remove();
    routeLine = null;
    $("route-stats").hidden = true;
    return;
  }
  const loop = $<HTMLInputElement>("loop").checked;
  const through = loop ? [...pins, pins[0]] : pins;
  try {
    const r = await route(through);
    if (seq !== routeSeq) return;
    current = r;
    routeLine?.remove();
    routeLine = L.polyline(r.coords.map(([lng, lat]) => [lat, lng] as [number, number]), {
      color: "#f5c442", weight: 5, opacity: 0.95,
    }).addTo(map);
    const km = r.distance / 1000;
    $("route-length").textContent = km >= 1 ? `${km.toFixed(2)} km` : `${Math.round(r.distance)} m`;
    $("route-kind").textContent = loop ? "Circuit" : "A to B";
    $("route-stats").hidden = false;
    if (km > MAX_KM) {
      err.textContent = `That's ${km.toFixed(1)} km. Browser builds are limited to ${MAX_KM} km: move the pins closer.`;
      err.hidden = false;
    } else if (r.distance < 300) {
      err.textContent = "Make the road at least 300 m long.";
      err.hidden = false;
    }
    updateBuildButton();
    suggestName(r);
  } catch (e) {
    if (seq !== routeSeq) return;
    err.textContent = `Couldn't route between those pins: ${(e as Error).message}`;
    err.hidden = false;
  }
}

async function suggestName(r: Route): Promise<void> {
  const mid = r.coords[Math.floor(r.coords.length / 2)];
  try {
    const place = await reverseGeocode(mid);
    placeMeta = { country: place.country, city: place.town };
    if (nameTouched || current !== r) return;
    const name = [place.road, place.town].filter(Boolean).join(", ");
    if (name) $<HTMLInputElement>("name").value = name.slice(0, 60);
  } catch {
    // names are a nicety
  }
}
$("name").addEventListener("input", () => (nameTouched = true));

function updateBuildButton(): void {
  const ok = !!current && current.distance >= 300 && current.distance <= MAX_KM * 1000 && !building;
  $<HTMLButtonElement>("build").disabled = !ok;
}

/* ---------------- search ---------------- */

const searchInput = $<HTMLInputElement>("search");
const results = $<HTMLUListElement>("search-results");
let found: Place[] = [];
let activeResult = -1;
let searchCtl: AbortController | null = null;
let searchTimer: number | undefined;

function showResults(): void {
  results.innerHTML = "";
  found.forEach((p, i) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === activeResult));
    li.innerHTML = `${escapeHtml(p.label)}<small>${escapeHtml(p.detail)}</small>`;
    li.onmousedown = (e) => {
      e.preventDefault();
      choose(p);
    };
    results.append(li);
  });
  results.hidden = found.length === 0;
}

function choose(p: Place): void {
  results.hidden = true;
  searchInput.value = p.label;
  if (p.extent) {
    const [w, n, e, s] = p.extent;
    map.fitBounds([[s, w], [n, e]], { maxZoom: 16 });
  } else {
    map.setView([p.lngLat[1], p.lngLat[0]], 15);
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 3) {
    found = [];
    showResults();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    searchCtl?.abort();
    searchCtl = new AbortController();
    const c = map.getCenter();
    try {
      found = await searchPlaces(q, [c.lng, c.lat], searchCtl.signal);
      activeResult = found.length ? 0 : -1;
      showResults();
    } catch {
      // superseded or offline
    }
  }, 250);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!found.length) return;
    activeResult = (activeResult + (e.key === "ArrowDown" ? 1 : -1) + found.length) % found.length;
    showResults();
  } else if (e.key === "Enter" && found[activeResult]) {
    choose(found[activeResult]);
  } else if (e.key === "Escape") {
    results.hidden = true;
  }
});
searchInput.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 150));

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/* ---------------- build ---------------- */

let building = false;
let lastResult: TrackResult | null = null;
let preview: PreviewScene | null = null;
let downloadUrl: string | null = null;

function readOptions(): Partial<BuildOptions> {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  const imagery = $<HTMLSelectElement>("imagery").value;
  return {
    name: $<HTMLInputElement>("name").value.trim() || "Real road",
    widthOverride: num("width"),
    corridor: num("corridor"),
    wallOffset: num("walls"),
    horizon: num("horizon"),
    lineSmoothing: num("lineSmoothing"),
    elevationSmoothing: num("elevationSmoothing"),
    pitCount: Math.max(1, Math.min(24, Math.round(num("pitCount")))),
    vergeWidth: num("vergeWidth"),
    banking: $<HTMLInputElement>("banking").checked,
    imageryZoom: imagery === "off" ? 0 : imagery === "ultra" ? 20 : imagery === "high" ? 19 : 18,
    textureSize: imagery === "ultra" ? 2048 : imagery === "high" ? 1024 : 512,
    trees: imagery === "off" ? 0 : num("trees"),
    guardRails: $<HTMLInputElement>("guardRails").checked,
    guidePosts: $<HTMLInputElement>("guidePosts").checked,
    buildings: $<HTMLSelectElement>("buildings").value !== "off",
    detectBuildings: $<HTMLSelectElement>("buildings").value === "all",
    roadSurface: $<HTMLSelectElement>("surface").value as BuildOptions["roadSurface"],
    markings: $<HTMLInputElement>("markings").checked,
    sideStreets: $<HTMLInputElement>("sideStreets").checked,
    streetSigns: $<HTMLInputElement>("streetSigns").checked,
    landmarks: $<HTMLInputElement>("landmarks").checked,
    traceRoads: $<HTMLInputElement>("traceRoads").checked,
    kerbs: $<HTMLInputElement>("kerbs").checked,
  };
}

/** [west, south, east, north] around the route, padded by `metres`. */
function paddedBounds(coords: LngLat[], metres: number): [number, number, number, number] {
  const lats = coords.map((p) => p[1]), lngs = coords.map((p) => p[0]);
  const dLat = metres / 111320, dLng = metres / (111320 * Math.cos((lats[0] * Math.PI) / 180));
  return [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat];
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function setProgress(text: string, fraction?: number): void {
  $("progress-text").textContent = text;
  if (fraction !== undefined) $("progress-bar").style.width = `${Math.round(fraction * 100)}%`;
}

// Overall bar: each stage owns a slice.
const STAGES: Record<string, [number, number]> = {
  "Fetching OpenStreetMap data": [0, 0.05],
  "Laying out the road": [0.05, 0.08],
  "Tracing the road in the aerial photos": [0.06, 0.08],
  "Fetching elevation": [0.08, 0.2],
  "Fetching aerial imagery": [0.2, 0.75],
  "Building road and terrain meshes": [0.75, 0.88],
  "Reading line markings from the aerial photos": [0.75, 0.8],
  "Placing scenery": [0.88, 0.9],
  "Writing track files": [0.9, 0.95],
  "Rendering preview": [0.95, 0.98],
  Done: [1, 1],
};

$("build").onclick = async () => {
  if (!current || building) return;
  building = true;
  updateBuildButton();
  const err = $("build-error");
  err.hidden = true;
  $("result").hidden = true;
  $("progress").hidden = false;
  preview?.dispose();
  preview = null;

  const opts = readOptions();
  const chunkImages = new Map<string, OffscreenCanvas>();
  const usedImagery = new Set<ImagerySource>();
  const chain = imageryChain(current.coords[Math.floor(current.coords.length / 2)], $<HTMLSelectElement>("imagerySource").value as ImagerySource | "auto");
  const report = async (stage: string, f = 0) => {
    const [a, b] = STAGES[stage] ?? [0, 1];
    setProgress(stage === "Fetching aerial imagery" ? `${stage} (${Math.round(f * 100)}%)` : stage, a + (b - a) * f);
    await nextFrame();
  };
  try {
    await report("Fetching OpenStreetMap data");
    const token = $<HTMLInputElement>("mapillaryToken").value.trim();
    saveToken(token);
    let seenError = "";
    const [osm, tiles, seen] = await Promise.all([
      fetchOsm(current.coords),
      fetchTileFeatures(paddedBounds(current.coords, (opts.buildingRadius ?? 250) + 50)).catch(() => null),
      token
        ? fetchSeen(paddedBounds(current.coords, (opts.corridor ?? 90) + 20), token).catch((e) => {
          seenError = (e as Error).message;
          return [];
        })
        : Promise.resolve([]),
    ]);
    if (tiles) osm.features.buildings = tiles.buildings;
    // Overpass widths when it answered; otherwise widths by road class from the tiles.
    const tileWidths = tiles ? classWidths(tiles.roads) : [];
    const widthAt = opts.widthOverride
      ? undefined
      : osm.widthAt ?? (tileWidths.length ? widthLookup(tileWidths, current.coords[0][1]) : undefined);
    const result = await buildTrack(current.coords, opts, {
      dem: (proj, bounds, z) => loadDem(proj, bounds, z),
      imagery: opts.imageryZoom ? (proj, chunk, z, size) => loadChunkImagery(proj, chunk, z, size, chunkImages, chain, usedImagery) : undefined,
      widthAt,
      osm: osm.features,
      roundabouts: current.roundabouts,
      streets: tiles ? { lines: tiles.roads, names: tiles.names } : undefined,
      pois: tiles?.pois,
      seen,
      renderArt,
      raster: (proj, path, reach) => loadRouteRaster(proj, path, reach, chain, 20, (d, t) => setProgress(`Tracing the road in the aerial photos (${Math.round((d / t) * 100)}%)`)),
      roadClassAt: tiles ? roadClassLookup(tiles.roads, current.coords[0][1]) : undefined,
      imageryCredit: () => [...usedImagery].map((k) => IMAGERY[k].credit).join("; "),
    }, placeMeta, report);

    await report("Rendering preview");
    preview = await createPreview($<HTMLCanvasElement>("preview-canvas"), result.model, result.plan, chunkImages, result.previewTextures);
    try {
      const shot = await preview.snapshot(1024, 576);
      result.files[`${result.slug}/ui/preview.png`] = shot;
    } catch {
      // keep the drawn fallback preview
    }

    const zip = zipTrack(result.files);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([zip as BlobPart], { type: "application/zip" }));
    const a = $<HTMLAnchorElement>("download");
    a.href = downloadUrl;
    a.download = `${result.slug}.zip`;
    a.textContent = `Download ${result.slug}.zip (${(zip.length / 1e6).toFixed(1)} MB)`;
    lastResult = result;
    showStats(result, !widthAt && !opts.widthOverride, usedImagery);
    if (token) {
      $("result-stats").insertAdjacentHTML("beforeend", `<div><dt>Mapillary</dt><dd>${seenError ? escapeHtml(seenError) : `${seen.length} objects`}</dd></div>`);
    }
    await report("Done", 1);
    $("result").hidden = false;
  } catch (e) {
    console.error(e);
    err.textContent = `Build failed: ${(e as Error).message}`;
    err.hidden = false;
  } finally {
    building = false;
    $("progress").hidden = true;
    updateBuildButton();
  }
};

function showStats(r: TrackResult, widthFallback: boolean, usedImagery: Set<ImagerySource>): void {
  const s = r.stats;
  const rows: [string, string][] = [
    ["Length", `${(s.length / 1000).toFixed(2)} km`],
    ["Layout", s.closed ? "Circuit" : "A to B"],
    ["Elevation", `${Math.round(s.minElevation)}–${Math.round(s.maxElevation)} m`],
    ["Climb", `${Math.round(s.climb)} m`],
    ["Avg width", `${s.meanWidth.toFixed(1)} m${widthFallback ? " (default)" : ""}`],
    ["Trees", s.trees.toLocaleString()],
    ["Buildings", `${s.buildings.toLocaleString()}${s.buildingsDetected ? ` (${s.buildingsDetected} from imagery)` : ""}`],
    ["Imagery", [...usedImagery].map((k) => IMAGERY[k].label.replace(" Government", "")).join(" + ") || "none"],
    ["Traced from photos", `${Math.round(s.traced * 100)}% of the road, ${s.photoLines} lines${s.photoChunks ? `, ${s.photoChunks} photo-surfaced stretches` : ""}`],
    ["Side streets", `${s.sideStreets.toLocaleString()} (${s.sideTraced} traced)`],
    ["Kerb & gutter", `${(s.kerbMetres / 1000).toFixed(2)} km`],
    ["Signs", `${s.streetSigns} street, ${s.signs} other`],
    ["Guard rail", `${Math.round(s.railMetres)} m`],
    ["Triangles", s.triangles.toLocaleString()],
  ];
  $("result-stats").innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

$("open-preview").onclick = () => {
  if (!preview || !lastResult) return;
  $("preview").hidden = false;
  preview.open();
};
$("preview-close").onclick = () => {
  $("preview").hidden = true;
  preview?.close();
};
$("preview-drive").onclick = () => preview?.toggleDrive();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("preview").hidden) $("preview-close").click();
});

renderPins();

// Test hook for the browser smoke test (dev server only).
if (import.meta.env.DEV) {
  (window as unknown as { __app: object }).__app = {
    map,
    addPin(p: LngLat) {
      pins.push(p);
      renderPins();
      refreshRoute();
    },
    result: () => lastResult,
    preview: () => preview,
  };
}
