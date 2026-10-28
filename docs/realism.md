# Realistic graphics: what the game can do and what we use

Notes from researching how Assetto Corsa renders tracks, and how the best
modded tracks get their look. Sources are at the end; the shader details
come from reading the game's shaders as Custom Shaders Patch recreates them,
so they're exact rather than forum lore.

## The shaders

Every material names a shader and binds textures to its registers. From
the shader declarations (`textures_ps.fx`):

| Slot | Register | Used by |
|---|---|---|
| `txDiffuse` | 0 | everything |
| `txNormal`, `txMask`, `txVariation` | 1 | normal-mapped shaders; multilayer mask; grass |
| `txMaps`, `txDetailR` | 2 | multimap; multilayer |
| `txDetail`, `txDetailG` | 3 | multimap; multilayer |
| `txNormalDetail`, `txDetailB` | 4 | NMDetail; multilayer |
| `txDetailA` | 5 | multilayer |

The kn5 file stores each texture's register next to its slot name, so the
writer looks them up (`TEXTURE_REGISTER` in `kn5.ts`).

- **`ksPerPixel`**: diffuse only. `ksAmbient`, `ksDiffuse`, `ksSpecular`,
  `ksSpecularEXP`, `ksEmissive`, `ksAlphaRef`. What most of our scenery uses.
- **`ksPerPixelAT`**: the same, alpha-tested (tree sprites, sign cut-outs).
- **`ksPerPixelNM`**: adds a tangent-space normal map; `fresnelC`,
  `fresnelEXP`, `fresnelMaxLevel`, `nmObjectSpace`, `isAdditive`.
- **`ksPerPixelMultiMap`**: diffuse, normal, `txMaps`, `txDetail`. Extra
  parameters: `fresnelC`, `fresnelEXP`, `fresnelMaxLevel`, `isAdditive`,
  `useDetail`, `detailUVMultiplier`, `shadowBiasMult`, `nmObjectSpace`,
  `sunSpecular`, `sunSpecularEXP`. The detail blend, exactly:

  ```hlsl
  diffuse = lerp(diffuse, detail * diffuse, 1 - diffuse.a);
  ```

  so the detail texture multiplies the diffuse wherever the diffuse's alpha
  is 0, tiled `detailUVMultiplier` times over the same UVs. It has to be
  near white or it darkens the surface. `txMaps`: R scales specular, G
  glossiness (the exponent), B the sun specular.
- **`ksMultilayer` / `ksMultilayer_fresnel_nm`**: the classic terrain and
  road shader. `txMask`'s four channels place four tiling details
  (`txDetailR..A`, scaled by `multR..multA`), blended by `magicMult`. The
  details are projected from above, so it's only for flat-ish ground.
- **`ksTree`, `ksGrass`**: Kunos's tree and grass-tuft shaders.

## What we use

- **Road** (`road_asphalt_*`, `road_chipseal_*`): `ksPerPixelMultiMap`,
  seal texture with alpha 0 everywhere (DXT5), aggregate stones as the
  detail (~0.8 m a tile), drawn squashed 3:1 because road UVs run 24 m along
  for about 8 m across, so on the road they come out round.
- **Ground** (`terrain_*`): `ksPerPixelMultiMap`, the aerial photo with an
  alpha mask from its colour (0 on lawns, dry grass and bare earth; 255 on
  roofs, roads, concrete, water), grass blades as the detail (~0.9 m a
  tile).
- **Road relief**: each seal texture's normal map comes from its own
  shading, brightness as height, so cracks and patch edges are grooves
  (DirectX convention, green down).
- **Walls, roofs, fences** (`facade_*`, `roof_*`, `barrier_*`):
  `ksPerPixelNM` with a normal map from the texture's shading: mortar
  joints, weatherboard laps, corrugations, palings. Reflections off.
- **Windows**: glass panes over the painted windows (`window` material),
  which CSP turns into lit rooms at night.
- Turned off with **Detail shaders** in the options, everything is plain
  `ksPerPixel` as before. The cost is file size: the ground's grass mask
  needs DXT5 (alpha) instead of DXT1, about 25 MB more on a 1.8 km
  suburban build at high imagery.

## Custom Shaders Patch

Most players run CSP. A track can ship its own config at
`extension/ext_config.ini`; we write one (`cspConfig.ts`) with:

- **Conditions**: `NIGHT_SMOOTH` (sun more than 88° from overhead), as in
  CSP's `common/conditions.ini`.
- **Lights**: a `LIGHT_SERIES` with every street light, and lanterns that
  glow through `Material_DistantEmissive` (CSP's shader for lamp posts,
  which stops flicker at a distance).
- **Room windows**: `Material_RoomWindows` on the glass panes over each
  window: a lit room behind at night (some dark), Watch Dogs style.
- **Light pollution**: a built-up area's glow on the skyline.
- **Grass FX**: real grass blades near the camera on the ground and
  nature-strip materials, its colour mask widened for dry grass, trimmed
  like lawns; road, concrete and paint occlude it.
- **Rain FX**: puddles and soaking on roads, concrete darker, grass rough
  (required alongside Grass FX), glass and steel smooth, paint marked as
  lines (slippery in the wet).
- **Shadows**: `DOUBLE_FACE_SHADOW_BIASED` for fences, signs and tree
  sprites.

### Worth doing later

- **CSP trees** (`[TREES]` with a tree list): instanced 3D trees with LODs,
  billboards in the distance and baked shadows. Needs tree models
  converted with Content Manager's tree tool (FBX in, `.bin` out), which the
  browser can't do. We could write the tree list (positions, species, size)
  for players who add the models.
- **Ambient occlusion**: CSP expects tracks to have it, and nothing does
  more for how solid a scene looks. It is baked on the player's PC with
  CSP's AO bakery (any hardware), so the README tells players how.
- **`ksMultilayer` terrain**: four details by mask (grass, dirt, gravel,
  concrete) instead of one.

## Sources

- CSP shaders (the Kunos shaders recreated):
  gitlab.com/ac-custom-shaders-patch/public/acc-shaders, `recreated/`
  (`ksPerPixelMultiMap_ps.fx`, `include_new/base/cbuffers_ps.fx`,
  `include_new/base/textures_ps.fx`, `include_new/base/utils_ps.fx`).
- CSP wiki (github.com/ac-custom-shaders-patch/acc-extension-config/wiki):
  Tracks – Lights, Tracks – Conditions, Tracks – Grass FX, Tracks – RainFX,
  Tracks – Trees, Tracks – Miscellaneous options.
- CSP configs for Kunos tracks (acc-extension-config, `config/tracks/`):
  `ks_black_cat_county.ini`, `ks_highlands.ini`, `ks_nordschleife.ini`,
  `common/conditions.ini`, `common/materials_track.ini`.
- CSP vertex AO bakery: github.com/ac-custom-shaders-patch/acc-bakeryoptix.
- Community notes on track shaders (assettocorsamods.net threads on
  txDetail, ksMultilayer and track creation), used only where the shader
  source agrees.
