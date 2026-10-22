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
| 3 | The car spawns on the road, facing up the road, not in the air or under it | `AC_PIT_n` / `AC_START_n` transforms in `track.ts` (Z = forward, Y = up) |
| 4 | Driving feels like asphalt; the verge and terrain feel like grass | `data/surfaces.ini`, mesh name prefixes `1ROAD_`, `1GRASS_` |
| 5 | The invisible walls stop the car, and you can't see them | `1WALL_*` meshes with `renderable=false` |
| 6 | Aerial textures show on the terrain (not black or pink) | DDS DXT1 encoder (`src/core/dds.ts`) |
| 7 | Road markings run the right way and aren't mirrored | UV `v` direction (kn5 `v = 0` is the image top) |
| 8 | Crossing the start line starts the timer; crossing the finish stops it | `AC_AB_START_L/R`, `AC_AB_FINISH_L/R` |
| 9 | The in-game map (F-key apps / map app) shows the road in the right place | `data/map.ini` offsets and `SCALE_FACTOR` |
| 10 | AI cars drive the road (Race / Track Day with AI) | `ai/fast_lane.ai`; see note below |
| 11 | Horizon hills show and there's no visible ledge where they meet the near terrain | `src/core/backdrop.ts` `SINK` |
| 12 | Performance is fine (FPS similar to a Kunos track) | chunk sizes, texture size, `maxTrees` |
| 13 | Trees show cut-out foliage (not solid rectangles), lit on both sides | `trees` material: `ksPerPixelAT`, alpha-tested |
| 14 | Guard rails stop the car and sit on the verge, not floating or buried | `1WALL_RAIL_*`, `buildGuardRails` |
| 15 | Buildings stand on the ground and are solid | `1WALL_BLD_*`, `buildBuildings` |
| 16 | Line markings don't flicker against the road at a distance | `LIFT` in `markings.ts` (15 mm) |
| 17 | Roundabouts drive as a smooth circle; the kerb is mountable; no bump where the road meets the ring | `roundabout.ts`, connectors in `roadMesh.ts` |

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
