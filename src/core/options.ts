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
  /** Aerial imagery zoom level for terrain textures (0 = no imagery). */
  imageryZoom: number;
  /** Texture size per terrain chunk, pixels. */
  textureSize: number;
  /** Elevation tile zoom level. */
  demZoom: number;
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
  terrainBlend: 20,
  chunkSize: 200,
  wallOffset: 10,
  banking: true,
  maxBank: 0.06,
  crown: 0.02,
  pitCount: 8,
  imageryZoom: 18,
  textureSize: 1024,
  demZoom: 14,
};

export function withDefaults(partial: Partial<BuildOptions>): BuildOptions {
  return { ...DEFAULT_OPTIONS, ...partial };
}
