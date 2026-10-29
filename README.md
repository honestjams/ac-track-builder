# AC Track Builder

Turn any real road into an Assetto Corsa track, in your browser. Search for a
road, drop a start and a finish pin, press **Build**, and download a zip that
installs straight into Content Manager.

It is a from-scratch take on what [Street2Sim](https://www.street2sim.com/)
does (see [docs/how-street2sim-works.md](docs/how-street2sim-works.md)), but
everything runs client-side: no server, no account, no queue.

## What you get

- The real road, routed along the OpenStreetMap network between your pins
  (add pins in between to force a route, or tick **Loop back to start** for a
  circuit).
- The road traced from the aerial photos: where the asphalt can be seen,
  the road follows its real line and width (OSM is often a metre or two
  off); under tree canopy it falls back to OpenStreetMap. Where the trace
  goes wrong, a "No-trace zone" on the map keeps the mapped line there.
- Line markings read off the photos (lane lines, edge lines, dashed or
  solid, in phase with the real ones), generated from sight distance where
  the photos can't show them.
- Optional photo road surface: each stretch of road textured with its own
  aerial photo (cars and paint removed, shadows evened, fine grain added).
- Real elevation from open terrain data, smoothed along the road, with a 2%
  crown and banking in corners.
- Road width from OSM `width` / `lanes` / road class, or a width you choose.
- Asphalt with edge lines and a dashed centre line, gravel verges, and terrain
  each side of the road textured with aerial imagery.
- Kerb and gutter in town: a concrete gutter, a 150 mm kerb (its own
  physics surface, mountable but felt) and a nature strip textured from the
  aerial photo, so footpaths and driveways show. Out of town only where the
  photo clearly shows one. Kerbs curve round the corners into side
  streets and carry on along them for 40 m, and roundabouts in town get a
  kerbed ring too, open wherever a road joins it. A kerb never stands on
  drivable road.
- Low-detail horizon terrain out to 1.5 km so the world doesn't end at the
  roadside.
- Australian road surfaces: chip seal on rural roads, dense asphalt on major
  roads and in town, with wheel-path wear, patch repairs and sealed cracks.
- Line markings as real geometry: white edge lines, and a dividing line that
  is broken where there's overtaking sight distance and becomes a barrier
  line on blind bends and crests, plus raised pavement markers.
- Real roundabouts: the full circulating carriageway, a mountable kerb and a
  planted island, instead of a hairpin where the route goes round one.
  Give-way lines across each entry, and on two-lane roundabouts (from the
  OSM `lanes` tag, or a ring wider than 9.5 m) a wider ring with a lane line
  round it.
- Side streets: the other roads around the route are drawn too, joined to
  it at proper junction mouths (motorways, bridges and tunnels are left out).
- Street name signs (white on blue blades) at every named junction, plus
  signs for shops, servos, schools and landmarks, bus stops with shelters
  and servo canopies, from OpenStreetMap.
- Street-level detail from Mapillary (optional, free token): real traffic
  signs (speed limits, give way, stop, warnings, chevron alignment
  markers), power poles, street lights, traffic lights, stop lines, zebra
  crossings, turn arrows (centred in their lane, facing their traffic) and
  painted speed numbers where its photos found them.
- Sharper aerial imagery from the Queensland and NSW governments where
  available (up to 0.1 m/px), falling back to Esri elsewhere. NSW imagery
  is colour-matched to Esri's at the zoom in use, as some of its surveys
  carry a strong blue haze.
- Bare-earth elevation from the Queensland, NSW and Victorian government
  models (lidar where captured) instead of SRTM, which measures the tree
  tops.
- Scenery: trees wherever the aerial imagery shows tree canopy, guard rails
  where the ground drops away beside the road (or where OSM maps one), white
  guide posts, and buildings: OSM footprints where mapped, plus placeholder
  houses wherever the imagery shows a roof, with Colorbond or terracotta
  roofs in the matching colour. In built-up areas every street frontage is
  read from the photo too, so each lot gets its house, square to the street
  at the setback and depth the photo shows.
- A wide range of building types, each with its own walls, windows and
  roof: brick veneer, weatherboard, fibro and rendered or clad modern
  houses (some two-storey, some with skillion roofs); Queenslanders on
  stumps behind lattice, with a verandah and deck (in Queensland);
  townhouses, brick walk-up flats and apartments with balconies; glass
  towers; offices; shops with a shopfront, sign, parapet and awning over
  the footpath (shops under the flats and offices on main streets);
  warehouses and sheds in Colorbond or tilt-up concrete with a roller door;
  brick churches, halls and schools. About 60 wall finishes and 20 roofs
  (Colorbond colours, terracotta and concrete tiles, membrane and gravel).
  The type comes from what's known: OSM's building type and height, a
  shop, cafe, church or school mapped inside it, the roof colour in the
  photo, its size and whether it fronts the street. Only the finishes a
  track uses go in its file.
- Invisible walls that keep you on the road and pull in where switchbacks
  pass close to each other.
- Time trial ready: on an A-to-B road the timed section is exactly the road
  between your pins. A run-up is added before the start pin (the grid,
  plus room for a flying start in Hotlap mode) and a 150 m run-off after
  the finish pin, along the real streets where they carry on. The start
  line is painted across the road and the finish line is chequered, with
  START and FINISH signs each side. Side
  streets and grass are off track, so cutting through them invalidates the
  run. "Back to pits" or "Restart" puts you on the grid 8 m behind the
  line. Loops get a start/finish line instead.
- Pit boxes, a starting grid, a hotlap start and an AI line (`fast_lane.ai`).
- Content Manager extras: `ui_track.json` with name, length, geotags and
  country, an outline, a preview render, and the in-game map.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # format round-trips + a full synthetic build
npm run build      # static site in dist/, host it anywhere
```

The page keeps your road in its address: the pins, no-trace zones, track
name and any settings you changed. Reloading brings it back, and **Copy
link** gives a link that reproduces the build (your Mapillary token is
never in it).

## Installing a track

Drag the downloaded zip onto Content Manager and click **Install**, or unzip
it into `steamapps/common/assettocorsa/content/tracks/`. The zip contains one
folder (`<track>/` with `ui/`, `data/`, `ai/` and the `.kn5`), so nothing ends
up nested too deep.

## Making it look its best in game

The track works in plain Assetto Corsa. The ground is the aerial photo,
which is a blur up close (30 cm a pixel at best), so with **Detail shaders**
on (the default) it carries tiling grass, dirt and paving detail as well,
picked per spot from the photo's colour: the photo gives the colour, the
detail the close-up texture, as on hand-made tracks.

With
[Custom Shaders Patch](https://acstuff.ru/patch/) (CSP) it also reads the
track's `extension/ext_config.ini`, so turn these on in CSP's settings:

- **Lighting FX**: the street lights light the road at night, lanterns glow,
  house windows show lit rooms, and a built-up area glows on the skyline.
- **Grass FX**: real grass blades on lawns and nature strips near the car,
  where the aerial photo alone is a blur.
- **Rain FX**: puddles and soaked asphalt, darker concrete, slippery paint.

Ambient occlusion makes the biggest single difference to how solid a scene
looks (soft shadow where walls meet the ground, under eaves, along kerbs),
and CSP expects tracks to have it. It is baked per track on your PC with
CSP's [vertex AO bakery](https://github.com/ac-custom-shaders-patch/acc-bakeryoptix)
(runs on any hardware: on the CPU, or the GPU on recent cards): put the
track in `content/tracks` and run the bakery on its `.kn5`.

If the road or the ground looks wrong up close (too dark or bright, shiny or black),
untick **Detail shaders** and build again: that goes back to plain
textures.

## How a build works

```
pins ──OSRM──▶ route polyline ──▶ local metres (scaled Web Mercator)
                                   │
  Overpass (widths, rails, buildings) ─┤
                                   ▼
                     smoothed centreline, sampled every 2 m
                     width · banking · crown
                                   │
        Terrarium elevation tiles ─┤──▶ smoothed height profile
                                   ▼
   road ribbon · verges · terrain grid (blended into the road) · walls
   horizon terrain · spawn/timing dummies · AI line
                                   │
           Esri aerial tiles ──────┤──▶ one DXT1 .dds per 200 m chunk
                                   ▼
            .kn5 + fast_lane.ai + data/ + ui/ + map.png ──▶ zip
```

| Path | What it does |
| --- | --- |
| `src/core/kn5.ts` | `.kn5` writer and reader (textures, materials, node tree) |
| `src/core/aiSpline.ts` | `fast_lane.ai` v7 writer and reader |
| `src/core/dds.ts`, `png.ts` | DXT1 DDS and PNG encoders |
| `src/core/geo.ts` | Local projection that lines up exactly with web map tiles |
| `src/core/road.ts`, `polyline.ts` | Centreline smoothing, widths, banking, nearest-point index |
| `src/core/roadMesh.ts` | Road, verge and wall meshes |
| `src/core/terrain.ts`, `backdrop.ts` | Drivable terrain corridor and horizon scenery |
| `src/core/scenery.ts` | Trees from imagery, guard rails, guide posts |
| `src/core/buildings.ts` | OSM footprints and roofs detected in imagery; walls, roofs (hip, gable, skillion, flat behind a parapet), verandahs, awnings, doors |
| `src/core/buildingStyles.ts` | Building types, facades (walls and window layouts) and roof finishes, and the textures painted from them |
| `src/core/frontage.ts` | Houses read off the photo along each street frontage |
| `src/core/markings.ts` | Edge and dividing lines from sight distance, pavement markers |
| `src/core/sideStreets.ts` | Other streets near the route and their junctions |
| `src/core/furniture.ts`, `art.ts` | Street name signs, landmarks, bus stops, Mapillary objects; the sign artwork atlas |
| `src/core/trace.ts` | Road line and width traced from the aerial photo |
| `src/core/paintLines.ts` | Line markings read off the aerial photo |
| `src/core/photoSurface.ts` | Photo road surface textures |
| `src/core/kerbs.ts` | Where kerbs are (photo evidence and how built-up it is), kerb, gutter and nature strip meshes |
| `src/core/roundabout.ts` | Roundabout circles, ring carriageway, island, connectors |
| `src/core/aiLine.ts` | AI line with a grip-limited speed profile |
| `src/core/acFiles.ts` | `ui_track.json`, `surfaces.ini`, `map.ini`/`map.png`, outline, preview |
| `src/core/cameras.ts` | Replay cameras (`cameras_1.ini`) |
| `src/core/utilities.ts` | Power poles, overhead wires and street lights (Mapillary, OSM, or default lights in town) |
| `src/core/footpaths.ts` | Footpaths, driveway crossovers, kerb laybacks and letterboxes read off the aerial photo |
| `src/core/fences.ts` | Fences, garden walls and hedges from OSM, kept off the road |
| `src/core/cspConfig.ts` | Custom Shaders Patch config (`extension/ext_config.ini`): night lighting, lit windows, light pollution, Grass FX, Rain FX, shadow fixes |
| `src/core/cull.ts` | Splits wide meshes into tiles and sets draw distances, so the game can skip what's out of sight |
| `src/core/track.ts` | The whole pipeline; network access is injected |
| `src/services/` | OSRM, Photon/Nominatim, Overpass, OpenFreeMap vector tiles, tile fetching (browser only) |
| `src/services/pipeline.ts` | One build: fetch the map data, then `buildTrack` with the real data sources |
| `src/ui/buildWorker.ts` | Runs the build in a Web Worker so the page stays responsive (the page builds itself where a worker can't draw) |
| `src/ui/` | Map UI and three.js preview |

`src/core` has no DOM or network code, so the whole pipeline runs under
Node in the tests with synthetic terrain.

## Data sources and licences

- Roads and buildings: © OpenStreetMap contributors, ODbL, via Overpass and
  [OpenFreeMap](https://openfreemap.org) vector tiles. Routing by the public
  [OSRM](https://project-osrm.org) demo server; place search by
  [Photon](https://photon.komoot.io) and Nominatim.
- Elevation: [Terrain Tiles on AWS Open Data](https://registry.opendata.aws/terrain-tiles/)
  (SRTM, USGS 3DEP, GMTED and national lidar where available).
- Elevation in Queensland, NSW and Victoria: the State of Queensland's bare-earth
  [Queensland Digital Elevation Model](https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer)
  (0.5 m lidar where captured) and NSW Spatial Services'
  [5 m elevation](https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_5M_Elevation/ImageServer),
  used instead of the tiles there because SRTM-based tiles include the tree
  canopy. In Victoria, the [Vicmap Elevation 10 m DEM](https://tiles-ap1.arcgis.com/P744lA0wf4LlBZ84/arcgis/rest/services/Vicmap_10m_DEM/ImageServer)
  (c) State of Victoria, decoded with Esri's [lerc](https://github.com/Esri/lerc).
- Aerial imagery: Queensland Government and NSW Spatial Services imagery
  where available, else Esri World Imagery.
- Street-level detections: [Mapillary](https://www.mapillary.com), CC BY-SA,
  with your own client token. Fine for building tracks for yourself;
  **don't publish or sell tracks that contain it.** Pick
  **Aerial imagery → Off** for a track you want to share, and it uses a
  procedural grass texture instead.

The public OSRM, Nominatim and Overpass servers are free community services
with fair-use policies. They're fine for personal use. If this ever gets
real traffic, run your own instances or use a paid provider.

Assetto Corsa is a trademark of Kunos Simulazioni. This project is not
affiliated with or endorsed by Kunos.

## Status

Every file format is cross-checked against Content Manager's and
AssettoServer's readers and round-trip tested, but nothing has been loaded
in the game yet. [docs/verification.md](docs/verification.md) is the
checklist for the first in-game test, and [docs/roadmap.md](docs/roadmap.md)
lists what comes next.
