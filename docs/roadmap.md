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
3. **Photo trace and angled parking.** On wide main streets the trace can
   take parking bays as road and pull the line sideways. Detect it (traced
   width far beyond the street's, one edge where OSM expects it) and trust
   that edge; keep `noTrace` zones as the manual override, settable from the
   map.
4. **Performance pass.** Count draw calls, triangles and texture memory in
   a typical build; merge small meshes by material, cap far-off detail, so a
   time trial runs at a steady frame rate on modest PCs.
5. **Replay and TV cameras** (`data/cameras_1.ini`) along the route, so a
   saved hotlap replay looks like a broadcast.

## Next: realism

6. **Road furniture from OSM and photos.** Power poles along streets (an
   Australian signature), street lights at mapped lamp positions (and CSP
   night lighting), bus stops, letterboxes along frontages.
7. **Painted words and symbols.** KEEP CLEAR, BUS, bicycle symbols, from
   Mapillary detections where available.
8. **Footpaths** as their own surface beside the kerb.
9. **Scenery.** Tree trunk collision, more tree species per region, multi-lane
   roundabouts, CSP grass FX on grassy terrain.

## Later

10. **Build in a Web Worker** so the page stays responsive on long roads.
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
