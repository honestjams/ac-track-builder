# How Street2Sim works

Research notes from reading street2sim.com's public pages and front-end
scripts (October 2026). Street2Sim was previously called Drift Maps.

## The product

- You pick a road on a map: search for a place, click a start pin and a
  finish pin, and optionally click waypoints in between. The route snaps to
  the real road network and the page shows its length.
- Pay per km ($5/km for the first 5 km, sliding to $2/km past 20 km, max
  75 km), pay per hectare for "Intersections/Area" builds, or subscribe.
- A **build rig** (a dedicated Windows machine with Assetto Corsa) queues the
  job and builds the track. You get an email with a zip and a Content Manager
  one-click install link. Most builds take hours; roads over 50 km take up
  to 48 hours.
- An optional `.blend` file (Blender 3.6+) for editing the track yourself
  suggests the rig is built on Blender, with a kn5 export at the end.
- A public library of everything already built. A road someone has already
  built is served from the library instead of being rebuilt.

## The front end (`/map.html`, `/assets/road-picker.js`)

- Leaflet map with an OpenFreeMap vector basemap via MapLibre, falling back to
  CARTO rasters, plus an Esri World Imagery layer. Comments say this is "the
  same Esri source the rig reads".
- Routing: the public OSRM server (`router.project-osrm.org`), with
  `continue_straight` so routes don't U-turn at a pin. The server re-routes
  the same pins, so the line on the map is what gets built.
- Search: Photon for search-as-you-type, Nominatim only on Enter (its policy
  forbids autocomplete), at most once a second.
- Auto-naming: a Nominatim reverse lookup of the route's midpoint, e.g.
  "Angeles Crest Highway, La Cañada Flintridge".
- The request sent to the server is just the pins (start, vias, finish), a
  name and options. All the geometry work happens on the rig.

## The build rig (from the site's own descriptions)

- Road line from OpenStreetMap, routed between the pins.
- Elevation from USGS 3DEP (lidar) in the US and Copernicus DEM elsewhere,
  "with camber".
- Asphalt edges "traced from aerial imagery", and scenery (signals,
  markings, poles, trees) detected from imagery and Street View. Area builds
  use SAM (Segment Anything) on current aerial imagery to find paved pads.
- Automatic checks on the finished track in Assetto Corsa, then packaging.
- Output: a zip with `<track>/<track>.kn5`, `ui/`, `data/`, installable with
  Content Manager.

## What we copy, and what we do differently

| | Street2Sim | AC Track Builder |
| --- | --- | --- |
| Picking the road | Pins, OSRM routing, Photon/Nominatim | Same approach |
| Where it builds | Remote rig, queued, emailed | In your browser, in about a minute |
| Road line | OSM, edges traced from imagery | OSM, smoothed, width from OSM tags |
| Elevation | 3DEP / Copernicus, with camber | Terrain Tiles (SRTM/3DEP/national lidar), crown and banking |
| Terrain | Real terrain around the road | DEM corridor blended into the road, plus horizon |
| Textures | Aerial imagery | Aerial imagery as DXT1 DDS per 200 m chunk |
| Scenery | Trees, poles, signals from imagery and Street View | Not yet (see roadmap) |
| Model export | Blender → kn5 (inferred) | Our own kn5 writer, no Blender |
| Cost | Per km | Free |

The hard parts Street2Sim's rig solves and we don't yet: tracing the true
asphalt edge from imagery, and generating scenery. Both are on the roadmap.
