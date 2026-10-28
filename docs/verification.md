# In-game verification checklist

The exporters are tested against independent readers (Content Manager's
AcTools and AssettoServer's parser), but only the game itself can confirm the
track loads and drives. Use a short road (1–3 km) for the first test.

## Setup

1. Build a track, download the zip.
2. Content Manager → drag the zip in → Install. Or unzip into
   `assettocorsa/content/tracks/`.
3. Content Manager → Drive → Practice, pick the track, any base-game car.

## Checklist

| # | Check | If it fails, look at |
| --- | --- | --- |
| 1 | The track shows in Content Manager with name, length, country, outline and preview | `ui/ui_track.json`, `ui/*.png` |
| 2 | The game loads without a crash | kn5 layout (`src/core/kn5.ts`), material shader names |
| 3 | The car spawns on the road, facing up the road, not in the air or under it | `AC_PIT_n` / `AC_START_n` transforms in `track.ts`: the game faces the car along the dummy's -Z (Y up). With +Z, cars spawned facing back down the road |
| 4 | Driving feels like asphalt; the verge and terrain feel like grass | `data/surfaces.ini`, mesh name prefixes `1ROAD_`, `1GRASS_` |
| 5 | The invisible walls stop the car, and you can't see them | `1WALL_*` meshes with `renderable=false` |
| 6 | Aerial textures show on the terrain (not black or pink) | DDS DXT1 encoder (`src/core/dds.ts`) |
| 7 | Road markings run the right way and aren't mirrored | UV `v` direction (kn5 `v = 0` is the image top) |
| 8 | Crossing the painted start line starts the timer; crossing the chequered finish line stops it (Practice and Hotlap) | `AC_AB_START_L/R`, `AC_AB_FINISH_L/R` on the pins; run-up and run-off from `extend.ts` |
| 22 | Cutting through a side street or across grass invalidates the run; the route, its gutters and kerbs don't | `STREET` / `GRASS` (`IS_VALID_TRACK=0`) in `surfaces.ini` |
| 23 | Nothing solid on the driving line: you can drive straight through every roundabout entry and exit, turn and junction without touching a kerb | `kerbBlocked` in `track.ts`, ring openings, and the last-pass `clearance.ts` |
| 9 | The in-game map (F-key apps / map app) shows the road in the right place | `data/map.ini` offsets and `SCALE_FACTOR` |
| 10 | AI cars drive the road (Race / Track Day with AI) | `ai/fast_lane.ai`; see note below |
| 11 | Horizon hills show and there's no visible ledge where they meet the near terrain | `src/core/backdrop.ts` `SINK` |
| 12 | Performance is fine (FPS similar to a Kunos track); markings, signs and posts fade out in the distance without popping in close | chunk sizes, texture size, `maxTrees`; tiles and draw distances in `cull.ts` |
| 13 | Trees show cut-out foliage (not solid rectangles), lit on both sides | `trees` material: `ksPerPixelAT`, alpha-tested |
| 14 | Guard rails stop the car and sit on the verge, not floating or buried | `1WALL_RAIL_*`, `buildGuardRails` |
| 15 | Buildings stand on the ground and are solid | `1WALL_BLD_*`, `buildBuildings` |
| 16 | Line markings don't flicker against the road at a distance | `LIFT` in `markings.ts` (15 mm) |
| 17 | Roundabouts drive as a smooth circle; the kerb is mountable; no bump where the road meets the ring | `roundabout.ts`, connectors in `roadMesh.ts` |
| 18 | Side streets meet the route without a step or a gap at the mouth | `buildSideStreets` junction blend |
| 19 | Street name blades and shop signs read correctly (not mirrored) from both sides | `face()` in `furniture.ts`, atlas UVs |
| 20 | Sign cut-outs (stop, give way, warning diamonds) have clean edges, no square backgrounds | `signart` material, `ksPerPixelAT` |
| 21 | Kerbs jolt the car when mounted at speed but can be driven over slowly; the gutter drives like road; no gap between gutter and asphalt | `KERB` in `surfaces.ini`, `1KERB_*` / `1ROAD_GUTTER_*` in `kerbs.ts` |
| 25 | Power poles stand on the nature strip, not the road; wires sag between them without flickering badly up close; street lights reach out over the road | `utilities.ts`, `WIRES_*` draw distance in `cull.ts` |
| 26 | Footpaths and driveway slabs sit just proud of the grass (no gaps, no floating); the kerb dips at each driveway and the car rolls over a layback gently | `1STREET_PATH_*`, `1STREET_DRIVE_*`, `LAYBACK` in `kerbs.ts` |
| 27 | Houses have eaves with white soffits, doors and garage doors on the street side, windows at sill height (none cut off by the ground) | `buildBuildings` in `buildings.ts` |
| 28 | With CSP and night time: street lights light the road in pools beneath them and the lanterns glow; off by day | `extension/ext_config.ini`, `cspConfig.ts` |
| 30 | With CSP and Grass FX on: grass blades grow on lawns and nature strips near the car, never through the road, footpaths or driveways | `[GRASS_FX]` in `extension/ext_config.ini` |
| 29 | Running wide into a tree or a fence stops the car; nothing solid on the road | `1WALL_TREE_*`, `1WALL_FENCE_*` |
| 24 | A replay switches between trackside cameras that follow the car (not stuck on the chase cam), none inside a building or the ground | `data/cameras_1.ini`, `cameras.ts` |

## Known unknowns

- **AI line grid.** We write `fast_lane.ai` with no spatial lookup grid
  (`hasGrid = 0`). Content Manager reads that fine. If AI misbehaves, record a
  line in game (AI line helper or CSP's AI tools) as a workaround, and we'll
  add grid generation.
- **Map scale.** Tracks under about 2 km across use `SCALE_FACTOR=1`, which
  is unambiguous. Longer roads scale the image down; if their in-game map
  marker drifts, the scale is the wrong way round.
- **Trees are not solid.** You can drive through them. The invisible walls
  keep you within 10 m of the road by default, which covers most of them.
- **CSP.** Nothing needs Custom Shaders Patch, but it improves lighting.
