# Roadmap

Rough priority order. Each chunk is a self-contained change.

1. **First in-game test.** Run through [verification.md](verification.md) and
   fix whatever it turns up.
2. ~~Trees, guard rails, guide posts, buildings, Australian surfaces and
   markings, roundabouts.~~ Done. Next steps for
   scenery: tree trunk collision, pitched roofs, more tree species per
   region, power poles and road signs, give-way lines at roundabout entries,
   multi-lane roundabouts, and CSP grass FX on grassy terrain.
3. ~~**Truer road edges.**~~ Done: traced from the aerial photo, with line
   markings and an optional photo surface, side streets traced too, kerb
   and gutter in town, turn arrows and painted numbers. Next: painted words
   (KEEP CLEAR, BUS), bicycle symbols, kerb returns round the
   corners of side streets, footpaths as their own surface.
4. **Higher-resolution elevation.** Use national lidar where it's open (e.g.
   USGS 3DEP 1 m, Geoscience Australia 5 m, Japan GSI 5 m) instead of the
   tile mosaic.
5. **Build in a Web Worker** so the page stays responsive on long roads.
6. **CSP extras.** `ext_config.ini` with grass FX, rain puddles and track
   lighting.
7. **Pit lane AI** (`pit_lane.ai`) and replay cameras.
8. **Shareable builds.** Imagery from an openly licensed source (e.g. NAIP in
   the US), so built tracks can be shared.
