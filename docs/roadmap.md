# Roadmap

Rough priority order. Each chunk is a self-contained change.

1. **First in-game test.** Run through [verification.md](verification.md) and
   fix whatever it turns up.
2. **Trees and vegetation.** Billboard trees scattered over OSM
   `natural=wood` / `landuse=forest` and green pixels in the imagery, kept
   off the road and verges.
3. **Roadside objects.** Armco or concrete barriers where OSM has
   `barrier=guard_rail`, or on steep drop-offs. Poles and signs.
4. **Truer road edges.** Snap the width to the asphalt visible in the aerial
   imagery (Street2Sim's "traced from aerial imagery" step).
5. **Higher-resolution elevation.** Use national lidar where it's open (e.g.
   USGS 3DEP 1 m, Geoscience Australia 5 m, Japan GSI 5 m) instead of the
   tile mosaic.
6. **Build in a Web Worker** so the page stays responsive on long roads.
7. **CSP extras.** `ext_config.ini` with grass FX, rain puddles and track
   lighting.
8. **Pit lane AI** (`pit_lane.ai`) and replay cameras.
9. **Shareable builds.** Imagery from an openly licensed source (e.g. NAIP in
   the US), so built tracks can be shared.
