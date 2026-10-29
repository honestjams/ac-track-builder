# Roadmap

Rough priority order. Each chunk is a self-contained change.

## Now: time trial ready

1. **In-game test of the time-trial build.** Run through
   [verification.md](verification.md) (items 21-23 especially: spawn
   direction, the timer starting at START and stopping at FINISH, kerbs at
   roundabouts and turns, side streets counting as off track) and fix
   whatever it turns up.
2. ~~U-turn spurs~~ (cut out of the route automatically) and ~~the ditch
   along road edges~~ (terrain ramps up to the verge or kerb). Done.
3. ~~Photo trace walking off onto grey roofs and parking~~, ~~performance
   pass~~ (wide meshes split into tiles, draw distances on small detail),
   ~~replay cameras~~. Done. Still open: setting `noTrace` zones from the map.

## Next: realism

6. ~~Power poles, wires, street lights; footpaths, driveways, laybacks,
   letterboxes; painted words; houses with hip roofs, eaves, doors and
   garages; gum trees and palms.~~ Done.
7. ~~CSP night lighting, CSP Grass FX on lawns and strips, bicycle
   symbols, fences/walls/hedges from OSM, solid tree trunks, no-trace zones
   from the map.~~ Done.
8. ~~Close-range detail without CSP~~: detail-mapped road and ground
   (ksPerPixelMultiMap, set up from the shader source). ~~CSP rain, lit
   windows, light pollution, shadow fixes~~. Done; see
   [realism.md](realism.md). ~~ksMultilayer ground~~ (grass, dirt and
   paving detail over the photo by a small mask, on the terrain and the
   nature strips) and ~~normal maps for the road and walls~~. Next from that
   research: a CSP tree list for instanced 3D trees, normal maps on the
   ground details.
9. **Scenery.** ~~Multi-lane roundabouts~~ (wider ring, lane line, give-way
   lines at every entry), ~~house windows lit at night~~, ~~many building
   types and finishes~~ (houses, Queenslanders, flats, apartments, towers,
   shops, offices, warehouses, halls). Still open: front fences where OSM
   has none (read off the photo), balconies as geometry on apartments.

9b. ~~**Race day.**~~ Barriers, debris fence and sponsor banners on the
   start straight and the outside of tight corners, tyre walls, gantries,
   grandstand and crowds, marshal posts (Done). Next: a pit lane and garages
   where a car park or wide street allows, a full-circuit option that
   closes the side streets.

## Later

10. ~~**Build in a Web Worker** so the page stays responsive on long roads.~~ Done.
11. **Higher-resolution elevation abroad.** USGS 3DEP 1 m, Japan GSI 5 m.
    (Done for Queensland, NSW and Victoria.)
12. **CSP extras.** `ext_config.ini` with rain puddles and track lighting.
13. **Shareable builds.** Imagery from an openly licensed source (e.g. NAIP in
    the US), so built tracks can be shared.

## Done

Road mesh from OSM, real elevation (state bare-earth models where there are
any), satellite textures, AI line and timing, trees, guard rails, guide
posts, buildings (mapped, detected and frontage houses), Australian
surfaces and markings, true roundabouts, side streets and street signs,
landmarks, Mapillary features, roads traced from the aerial photo with
their line markings, kerb and gutter, turn arrows, WA (Landgate), NSW and
Queensland imagery, start and finish gates with run-up and run-off, track
limits, U-turn spur removal.
