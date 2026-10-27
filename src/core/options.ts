// Everything a build can be tuned by. Defaults aim at a two-lane mountain
// road; the UI exposes the ones people actually change.

export interface BuildOptions {
  /** Track name shown in Content Manager. */
  name: string;
  /** Road width when OSM has no width/lanes tag, metres. */
  defaultWidth: number;
  /** Override every road width, metres (0 = use OSM). */
  widthOverride: number;
  /** Centreline sample spacing, metres. */
  spacing: number;
  /** Horizontal smoothing of the OSM line, metres (Gaussian sigma). */
  lineSmoothing: number;
  /** Vertical smoothing of the elevation profile, metres (Gaussian sigma). */
  elevationSmoothing: number;
  /** Gravel/grass strip each side of the asphalt, metres. */
  vergeWidth: number;
  /** Terrain kept each side of the road, metres. */
  corridor: number;
  /** Terrain grid spacing, metres. */
  terrainStep: number;
  /**
   * How far the terrain under the road and verges is dropped below them, metres,
   * so it never pokes through. On a coarse grid the drop drags the ground
   * beside the road down with it (a ditch at the edge); on flat ground use a
   * finer terrainStep and a small drop.
   */
  terrainUnderRoad: number;
  /** Distance over which terrain blends from the road level to the real ground, metres. */
  terrainBlend: number;
  /** Terrain / texture chunk size, metres. */
  chunkSize: number;
  /** Invisible wall distance from the road edge, metres (0 = no walls). */
  wallOffset: number;
  /** Superelevation in corners. */
  banking: boolean;
  /** Maximum cross-slope from banking (0.06 = 6%). */
  maxBank: number;
  /** Crown: fall from the centre to each edge (0.02 = 2%). */
  crown: number;
  /** Number of pit boxes / grid slots. */
  pitCount: number;
  /**
   * Point to point roads: metres of run-up added before the grid (for a
   * flying hotlap) and of run-off after the finish line, along the real
   * streets. The timed section is exactly the road between the pins.
   */
  runUp: number;
  runOff: number;
  /** Aerial imagery zoom level for terrain textures (0 = no imagery). */
  imageryZoom: number;
  /** Texture size per terrain chunk, pixels. */
  textureSize: number;
  /** Elevation tile zoom level. */
  demZoom: number;
  /** Non-drivable horizon terrain out to this distance from the road, metres (0 = none). */
  horizon: number;
  /** Aerial imagery zoom for the horizon terrain. */
  horizonZoom: number;
  /** Trees from aerial imagery: 0 off, 1 normal, 2 dense. */
  trees: number;
  /** Upper bound on tree count, for frame rate. */
  maxTrees: number;
  /** Guard rails at drop-offs and where OSM maps them. */
  guardRails: boolean;
  /** White guide posts along the verges. */
  guidePosts: boolean;
  /** Buildings from OSM footprints. */
  buildings: boolean;
  /** Placeholder buildings where the aerial imagery shows a roof. */
  detectBuildings: boolean;
  /** Buildings are placed up to this far from the road, metres. */
  buildingRadius: number;
  /**
   * Road surface: by road class and surroundings, one kind everywhere, or
   * the aerial photo of the road itself where it was traced.
   */
  roadSurface: "auto" | "asphalt" | "chipseal" | "photo";
  /** Edge lines, dividing lines and raised markers. */
  markings: boolean;
  /** Draw the other streets near the route. */
  sideStreets: boolean;
  /** Street name signs where named streets meet the route. */
  streetSigns: boolean;
  /** Signs, bus stops and servo canopies from OSM points of interest. */
  landmarks: boolean;
  /** Move the road to where the aerial photos show it, at their width. */
  traceRoads: boolean;
  /**
   * Places where the photo trace is ignored and the road keeps the OSM line
   * (wide main streets with angled parking can pull the trace onto the
   * parking bays): centre [lng, lat] and radius in metres. Fades out over 30 m.
   */
  noTrace: { at: [number, number]; radius: number }[];
  /** Kerb and gutter where the photos (or a built-up area) show them, instead of a gravel verge. */
  kerbs: boolean;
}

export const DEFAULT_OPTIONS: BuildOptions = {
  name: "My road",
  defaultWidth: 6.5,
  widthOverride: 0,
  spacing: 2,
  lineSmoothing: 4,
  elevationSmoothing: 15,
  vergeWidth: 1.5,
  corridor: 90,
  terrainStep: 3,
  terrainUnderRoad: 0.6,
  terrainBlend: 20,
  chunkSize: 200,
  wallOffset: 10,
  banking: true,
  maxBank: 0.06,
  crown: 0.02,
  pitCount: 8,
  runUp: 60,
  runOff: 150,
  imageryZoom: 18,
  textureSize: 1024,
  demZoom: 14,
  horizon: 1500,
  horizonZoom: 16,
  trees: 1,
  maxTrees: 12000,
  guardRails: true,
  guidePosts: true,
  buildings: true,
  detectBuildings: true,
  buildingRadius: 250,
  roadSurface: "auto",
  markings: true,
  sideStreets: true,
  streetSigns: true,
  landmarks: true,
  traceRoads: true,
  noTrace: [],
  kerbs: true,
};

export function withDefaults(partial: Partial<BuildOptions>): BuildOptions {
  return { ...DEFAULT_OPTIONS, ...partial };
}
