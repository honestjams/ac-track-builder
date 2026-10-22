# Roadmap

Rough priority order. Each chunk is a self-contained change.

1. **First in-game test.** Run through [verification.md](verification.md) and
   fix whatever it turns up.
2. ~~Trees, guard rails, guide posts, buildings.~~ Done. Next steps for
   scenery: tree trunk collision, pitched roofs, more tree species per
   region, power poles and road signs, and CSP grass FX on grassy terrain.
3. **Truer road edges.** Snap the width to the asphalt visible in the aerial
   imagery (Street2Sim's "traced from aerial imagery" step).
4. **Higher-resolution elevation.** Use national lidar where it's open (e.g.
   USGS 3DEP 1 m, Geoscience Australia 5 m, Japan GSI 5 m) instead of the
   tile mosaic.
5. **Build in a Web Worker** so the page stays responsive on long roads.
6. **CSP extras.** `ext_config.ini` with grass FX, rain puddles and track
   lighting.
7. **Pit lane AI** (`pit_lane.ai`) and replay cameras.
8. **Shareable builds.** Imagery from an openly licensed source (e.g. NAIP in
   the US), so built tracks can be shared.
