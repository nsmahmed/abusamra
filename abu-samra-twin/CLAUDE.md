# WASL (Abu Samra Twin) — technical context

WASL ("وصل") is a 3D digital twin of the Abu Samra land border customs port (Qatar–KSA) for a company AI hackathon. It combines:

- **3D scene:** a browser scene on an illustrated rendering of the real imagery.
- **Simulation:** a discrete-event model of import and export truck flows, with per-truck attributes.
- **Live operations:** KPIs, filters by truck attribute, bottleneck pattern, plate feed, tracking.
- **Planning tools:** what-if sliders, text-to-map, forecast, single-resource optimizer, and goal seeking (three costed plans).
- **AI copilot:** Claude with simulation tools.

Delivered as **one self-contained HTML file**, `dist/wasl.html` (about 4.4 MB). The satellite variant, the `share/` bundle and the root redirect `index.html` were retired on 2026-11-04; the photo assets in `assets/` stay because they are the pipeline's input.

## Repository layout

```
CLAUDE.md                this file
build.py                 assembles dist/wasl.html from src/ + assets/illus/
src/head.html            <head>, CSS, page markup (panels, stage, overlays)
src/sim.js               simulation engine (Sim class, forecast())
src/flows.js             IMPORT / EXPORT stage definitions + default parameters
src/plan.js              lever cost model, goal seek, 3-year projection, text-to-map parser (pure logic)
src/app.js               3D scene, layouts, trucks, UI wiring, filters, forecast UI, goal seek UI, copilot
src/tail.html            closing tags
assets/geo.json          georeferenced routes, stage anchors, polygons, building footprints, trees (mosaic px)
assets/tex.json          texture extents (W, H, PAD), mean sand colour, high-res tile frames
assets/ground_4096.jpg   ground texture (mosaic + close-ups + synthesized desert), embedded as base64
assets/hr_*.jpg, hm_*.png  three oriented high-res tiles (~0.58 m/texel) + alpha masks, embedded as base64
assets/illus/            illustrated ground + tiles used by the page (alpha masks are shared from assets/)
data/map-imagery/        source Google Earth captures (high level 1-3, closeup 1-14, overviews)
data/map-details/        GAC import / export trip diagrams
README.md                plain-language overview (objective, uses, rebuild steps)
assets/H_*.npy, T.npy    homographies used by the pipeline
pipeline/*.py            imagery stitching, georeferencing, texture synthesis (OpenCV)
tests/sim_test.js        node test of the engine (prints KPIs for scenarios)
tests/render_test.py     Playwright headless render + screenshots 
tests/views.py           screenshots of named camera positions in dist/wasl.html
tests/ui_test.py         walk through every feature with screenshots (--quick skips goal seek)
dist/                    build output
```

Build: `python build.py`. The page concatenates `head.html`, two three.js `<script>` tags, and one inline `<script>`. The inline script holds the data constants (`SIM_SRC`, `GEOJ`, `TEXINFO`, `GROUND_URI`, `HR_URIS`), then `sim.js`, `flows.js`, `plan.js` and `app.js`, in that order. Lines starting with `if(typeof module` are stripped so the same files work in node. `SIM_SRC` is `sim.js` + `flows.js` again as a string: goal seeking starts Web Workers from a blob URL with it. If workers cannot start (a 3 s ping times out), forecasts fall back to the main thread.

## Runtime constraints (published artifact)

- **External scripts.** Only these hosts are allowed: cdnjs, `cdn.jsdelivr.net/npm`, `cdn.tailwindcss.com` and `code.jquery.com`. Stylesheets may only come from Google Fonts. Everything else must be inlined.
- **three.js version.** Pinned to **three@0.128.0** UMD builds:
  - `build/three.min.js`
  - `examples/js/controls/OrbitControls.js`
  - The `examples/js` folder was removed after r148, so don't upgrade without switching to a bundled build.
- **File size.** Under 16 MB total.
- **Browser storage.** localStorage is allowed only for per-viewer conveniences.
- **Runtime capabilities.** These are declared at publish time: `{"downloads": true, "sample": {}}`.
  - `const sample = await claude.use("sample")` asks Claude. It is used for the copilot. When it returns `null` or rejects with `not_granted`, hide the copilot.
  - `const downloads = await claude.use("downloads")` saves the CSV via `downloads.save({filename, data})`.
  - `window.claude` only exists inside the claude.ai viewer. Opened as a local file, the copilot and CSV button stay hidden, and everything else works.
- **Fonts.** IBM Plex Sans Arabic from Google Fonts, with system fallbacks.

## Simulation engine (`src/sim.js`)

- **Time model.** Discrete time, 1 tick = 1 simulated minute. Stages are in tandem with **blocking**: a truck that finishes a stage keeps its slot until the next stage admits it, so congestion propagates upstream onto the public road.
- **Arrivals.** Poisson per minute: `daily × (1 + surge/100) × PROFILE[hour] / 60`. `PROFILE` is a 24-value hourly weight curve with peaks around 08:00–10:00 and 16:00–18:00.
- **Drive time.** `sim.drive[j]` (from `flow.drive`, set by `computeDrive()` in `app.js` from the route length at 25 km/h plus a manoeuvre allowance) delays a truck's arrival at stage `j`: `arrT = moveT + drive`, `readyAt = arrT + service`. Forecasts use the same values, so the KPIs include driving. In node tests `flow.drive` is unset (0).
- **Stage definition.** Each stage in `flows.js` has these fields:

| Field | Meaning |
|---|---|
| `kind` | `road`, `gate`, `buffer` or `ramps` |
| `cap(p)` | Capacity from parameters |
| `svc(p)` | Returns `[mean, cv]` for a lognormal service time; mean 0 means pass-through |
| `share(p)` | Optional probability a truck visits the stage |
| `optional(p)` | Optional; returns false to bypass the stage entirely |
| `alpr` | Emits a gate event |
| `pullTo` | Buffer only. A truck leaves this lot only when the next stage has a free place (`occ + queue < cap`) and the named downstream lot has an unreserved slot (`occ + res < cap`); the slot is then reserved (`tr.res`) until the truck arrives. This keeps waiting trucks in the external parking instead of at gates or on internal roads. |
| `zone` | Badge colour |

- **Tick order.**
  1. Spawn arrivals.
  2. Every ready truck (`readyAt <= t`) is pushed to the FIFO queue of its next routed stage, or released if there is none. Trucks in a `pullTo` buffer are held back until the pull condition holds.
  3. Admit from queues while `occ < cap`, iterating stages **last to first** so freed capacity cascades in the same tick.
- **Common random numbers.** Each truck draws its route uniforms and per-stage Gaussian service draws (`tr.u[]`) at spawn. Scenario comparisons with the same seed differ only by the parameter change, which keeps deltas stable without many replications.
- **`forecast(flow, params, seed)`.**
  - Runs 72 h and measures trucks arriving in hours 24–48.
  - Returns: `avgH`, `p90H`, `cleared`, `peakRoad`, `idleH`, `co2t` (idle truck-hours × 8 kg), per-stage `util`, `bottleneck` and an hourly `series`.
  - The bottleneck is the most downstream stage above 85% utilization; otherwise the highest-utilization stage.
  - The UI averages seeds 11 and 23 (`fcAvg`). The optimizer uses seed 11 only.
  - One run takes about 100–300 ms.
- **Plates.** Synthetic, weighted by country (KSA, QAT, KWT, UAE, OMN, BHR, JOR, IRQ, EGY).
- **Truck attributes** (`tr.a`, drawn at spawn from the sim RNG, so common random numbers still hold):
  - `o` origin index into `ORIGINS[flow]` (import: country of loading; export: destination), `k` cargo index into `CARGO`.
  - `aeo` with probability `p.aeoShare`, `pre` (pre-arrival declaration) with `p.preShare`.
  - `red` risk lane: probability `p.inspShare × originRisk × cargoRisk / RISK_NORM × (AEO ? 0.3 : 1)`, capped at 0.97. So `inspShare` is the red-lane rate of a non-AEO truck of average risk.
  - Stage hooks: `pick(p,a)` routes by attribute (ramps take red-lane trucks only); `mul(p,a)` scales service time (import main-parking clearance and export document wait drop to `PRE_CLEAR` = 0.55 with a pre-arrival declaration).
- **Event log.** `Sim.prototype.release` is patched in `app.js` to also log `stage:-1` exit events.

### Flows (`src/flows.js`); all numbers are placeholders pending GAC data

Every stage time is a parameter (planner group "Time at each stage"). Defaults:

- **Import** (from KSA): road → radiation portals (2 lanes, 1.5 min) → external parking (`hold`, 100, pulls to main parking; 0 bypasses it) → appointment gates (3, 3 min) → main parking (`parkIdx` 4, 700, 140 min clearance without pre-arrival filing) → X-ray (6 tunnels, 4 min) → inspection ramps (130, red-lane trucks, 150 min) → release (2 lanes, 2 min). Programmes: `inspShare` 46, `aeoShare` 18, `preShare` 35 (about 40% of trucks end up red-lane).
- **Export** (to KSA): road → external parking (`parkIdx` 1, 150, 54 min documents without pre-arrival filing, pulls to operational parking) → permit gate (1, 1.2 min) → entry gates (2, 1.5 min) → operational parking (12, 15 min) → ramps (10, red-lane trucks, 60 min) → release (1 lane, 2.2 min). Programmes: `inspShare` 34, `aeoShare` 22, `preShare` 40.
- **Baseline behaviour.**
  - **Import.** The appointment gates run near capacity at the morning peak. The external parking fills, then the queue backs onto the public road.
  - **Export.** The single release lane is the bottleneck (96%). The 12 operational bays and 10 ramps stay busy, the external lot fills to 150, and the overflow queues on the Doha road beside it.
- The MUEEN / AI risk-targeting toggle was removed on request.

## Geospatial pipeline (`pipeline/`)

- **Coordinate system.** Everything is stored in **mosaic pixels** of the stitched imagery: 0.8 m/px, derived from the 400 m scale bar in `high_level_3.png` (≈250 px) with the mosaic upscaled ×2.
  - Runtime conversion: `conv(p) = [(p[0]-W/2)*0.08, (p[1]-H/2)*0.08]`, so 1 world unit = 10 m. Here x is east and z is south (image down).
  - Mosaic size: W=3598, H=3580.
1. **`stitch.py`** finds SIFT matches and RANSAC homographies:
   - The three Google Earth images relate by near-pure translations (`H_h1_h2`, `H_h2_h3`).
   - The import flow map aligns automatically (`H_fi_h3`, about 200 inliers).
   - The export flow map is an oblique render, so auto-matching failed and its route was traced manually in mosaic px. That is `export` in `geo.py`.
2. **`mosaic.py`** warps all images into image-3 space × 2 with feathered blending. Outputs: `mosaic.png`, `cov.png` (coverage) and `T.npy`.
3. **`geo.py`** builds `geo.json`:
   - Import coordinates from the original flow-map pixel coordinates via `T @ H_fi_h3`.
   - Export coordinates hand-placed.
   - Building footprints: three inspection sheds and the white yard building were auto-detected by `roofs.py` (bright, low-saturation components → `minAreaRect`). The other buildings and canopies are hand-placed rotated rectangles.
4. **`tex2.py`** fills the uncovered area. It works at 4096² to fit memory:
   - A push-pull colour extension at 1/8 resolution.
   - fBm tone variation.
   - A high-pass detail layer quilted from plain-sand patches.
   - A Laplacian pyramid blend with a wide feather.
   - Asphalt roads drawn where routes leave the coverage area.
   - Output: `ground_4096.jpg`, about 1.5 MB. `PAD` = 700 px on each side.
   - Before the last run, a greenish watermark area at the top edge was masked out of `cov.png`.
5. **`overlay.py`** draws routes over the mosaic for visual verification.

Source images live in `data/map-imagery/` (`high level 1-3.png`, `closeup 1-14.png`). Run every script from `pipeline/work/`, a scratch folder of about 36 MB that is safe to delete.

`stitch.py`, `geo.py` and `overlay.py` still point at the original `/mnt/user-data/uploads/` flow maps (`1793086674392_image.png`, `1793086681596_image.png`). Their outputs (`H_*.npy` and the `geo.json` routes) are kept, so they only need re-running to re-derive the routes. `tex2.py` is superseded by `ground.py`.

### Close-up pipeline (realism pass)

Order: `mosaic.py` → `register.py` → `ground.py` → `composite.py` → `buildings.py` → `trees.py` → `routes.py`, then `python pipeline/illustrate.py` and `python build.py`.

6. **`register.py`** registers each close-up onto the mosaic:
   - Uses SIFT (20k features, mosaic masked to coverage), FLANN and a RANSAC homography.
   - Masks out the Google Earth UI: attribution bar, nav buttons, minimap.
   - All 14 close-ups match with 250–670 inliers at a consistent scale of 0.72, so a close-up is about 0.58 m/px.
   - Output: `closeups.json`.
7. **`ground.py`** replaces `tex2.py`:
   - **Base texture.** Colour-fits the mosaic to the close-ups (per-channel linear) and composites the close-ups, feathered, into the 4096² base. The synthesis that follows is the same as in `tex2.py`: push-pull, fBm, quilted detail and pyramid blend.
   - **High-res tiles.** Builds oriented tiles along the facility's long axis, taken from the `minAreaRect` of close-up coverage: three tiles of 2560×2048 at 1.38 texels per mosaic px. Each tile has an alpha mask (`hm_*.png`, quarter resolution) that is hard zero outside close-up coverage. Outside coverage the JPEG holds a blurred fill so it compresses well.
   - **Lot cleaning.** Cleans the main import lot through `lotclean.py`: it rectifies the lot, finds the bay-row pitch by autocorrelation (36.0 mosaic px), takes the per-pixel median over all rows and tiles it back. This removes the photographed trucks so simulated ones don't double up.
   - **Memory.** Needs about 3 GB free. Intermediates are deleted before the pyramid blend.
8. **`composite.py`** writes `hr_full.png`, the full-resolution close-up composite on mosaic axes ×1.38, for digitizing.
   - **`zoom.py x0 y0 x1 y1 scale out.jpg`** renders any area with a labelled mosaic-px grid. Use it to measure footprints.
9. **`buildings.py`** holds the curated `SEEDS` list.
   - **Seed fields.** Each seed has a centre, L, W, angle, height and kind (`shed|bld|tower|canopy`), plus an optional `role` (`ramps_import|ramps_export`) and `dome`.
   - **Refinement.** Seeds marked `refine` are snapped by colour region-growing on `hr_full.png` when the fitted area is within ×0.6–1.45 of the seed.
   - **Parking bays.** Also writes the import `park` stage with layout `bays`. Its row lattice `s = phase + tilt·u + pitch·k` was fitted to the photographed trucks: pitch 36.1, tilt 0.058, phase 33.5, bay 8.6 mosaic px.
10. **`trees.py`** detects trees and shrubs:
    - **Detection.** Finds local dark, compact blobs: median-41 background minus grey > 22, area 14–230 px, aspect < 2.6.
    - **Filtering.** Drops building, yard and scrapyard zones and dense clusters.
    - **Tagging.** Tags each blob by zone polygon as landscaped (`t[3]=1`, palm or broadleaf) or desert scrub (`0`).
    - **Counts.** About 2,000 total, about 840 of them landscaped.
    - **Format.** `geo.json.trees = [[x, y, r, landscaped], ...]`.
11. **`footprints.py`** finds roof candidates by brightness threshold. It is a helper for finding new buildings; its output is not used directly.
12. **`routes.py`** holds the hand-traced road centrelines for both flows. Waypoints were digitised on `zoom2.py` grids, following the GAC trip diagrams; note that "import trip.png" in `data/map-details` shows the export flow and vice versa.
    - **Smoothing.** Routes are Chaikin-smoothed and resampled to about 5 px.
    - **Stage anchors.** Given as coordinates and snapped **in route order**. The export access road is used twice, and order-aware snapping keeps the anchors on the right pass.
    - **Exit anchors.** `name.exit` gives `exitIdx`, where trucks rejoin the route after an off-route lot. `park.from` / `park.to` give the `along` span.
    - **Lot frames.** Writes `layout:"lot"` frames for the import external parking (the unused south-west lot) and the export external parking. Each frame holds origin, row/bay axes, pitches and entry/exit points.
    - **Re-runs.** The script overwrites `path`, `opStart`, `label` and the anchors. Re-run it after `buildings.py`, because `buildings.py` rewrites the import `park` stage.
    - `roads.py` is an abandoned least-cost-path road snapper. Its road mask can't tell asphalt from dark sabkha.
    - **Export re-trace (2026-11-04).** Carriageway centres were measured from dark-run profiles of `best_mosaic.png` (rows across the access road, a perpendicular profile along the dual road):
      - The access road west of the external lot is two-way; both passes now share its centreline, so the permit gate (at the external-parking exit) sits on the road, not the island.
      - After the junction trucks take the west carriageway of the dual road (right-hand traffic); the entry gates sit on it just past the junction.
      - Along the E-W strip the route follows the kerb-side road, enters the inspection compound at its east corner, loops the shed (NE docks, NW end, SW docks) and leaves by the SW gate.
      - Operational parking is a `lot` (2 rows × 12, kerb-aligned) on the apron south-east of the compound, where the imagery shows trucks waiting. It replaced the old `along` kerbside bays on the dual road.
13. **`illustrate.py`** builds `assets/illus/` from the base texture and the tiles (about 1.5 min).
    - **Gradient maps.** Edge-preserving smoothing, then two gradient maps blended by LAB warmth: `COOL` for asphalt, concrete and roofs, `WARM` for sand and sabkha. Luminance is softly posterised.
    - **Details.** Greenery comes from compact dark blobs, followed by Canny ink outlines and grain.
    - **Sabkha.** Sabkha has the same colour and texture as asphalt. Wide dark areas (wider than 85 m by morphological opening) outside the `PAVED` polygons are treated as sabkha and warmed.
14. **`declutter.py`** runs inside `illustrate()` on every output:
    - **`remove_vehicles`** inpaints photographed vehicles. Candidates are near-neutral bright pixels (saturation < 26, 38 above a 25 m median) or strongly coloured ones on paved ground. They are clustered with a 1.6 m dilation, and a cluster is kept when it is truck-wide (≥ 4.2 m after dilation, ≤ 48 m long, density ≥ 0.2, aspect ≤ 7) or car-sized and fully surrounded by asphalt, and its ring is mostly asphalt. Clusters containing a continuous stripe ≥ 28 m long and ≤ 2.4 m wide are marking fields (stop bars) and are left alone.
    - **`paint_roads`** paints 10 m asphalt (white right edge, yellow left kerb line, 6/9 m dashed white centre) along both route paths, outside the `NO_ROAD` polygons (`PAVED` plus the export compound and apron). `always=True` paints every stretch; with `False` only stretches whose ground is not already asphalt.

## 3D scene (`src/app.js`)

### Ground

- **Imagery plane.** `PlaneGeometry(TW, TH)` with the embedded texture: sRGB, max anisotropy, Lambert material, receives shadows.
- **Surrounding sand.** A large ring plane plus an under-plane in sand colour. Fog hides the horizon.
- **Sky.** A vertex-coloured sky dome that is rebuilt when the hour bucket changes.
- **High-res tiles.** `HR` holds one ground quad per `TEXINFO.tiles` entry.
  - **Placement.** Corners `p00/p10/p01` are in mosaic px.
  - **Material.** `alphaMap`, `depthWrite:false` and polygon offset.
  - **Winding.** Chosen from the corner orientation. A wrong winding makes the tile invisible from above.
  - **Lookup.** `tileUV(t,x,z)` and `roofTile(pts)` find the tile under a footprint.

### Statics

- **Buildings.** `extrude(poly,h,kind,uvf)` builds walls, a roof and, for canopies only, an underside, using geometry groups:
  - **Walls.** Per-kind `wallMats` with procedural canvas facades (`FACADE`). Office and tower facades carry an `emissiveMap` of randomly lit windows that night drives.
  - **Roof.** Uses the high-res tile's material when the whole footprint lies inside a tile (`roofTile`). Otherwise it uses `roofMat` on the base texture (`baseUV`).
  - **Canopy underside.** `underMat`, which glows at night.
- **Sheds** get dock doors on both long sides. **Canopies** get an instanced pillar grid. Buildings with `dome:true` get two domes.
- **Vegetation.** `addVegetation` instances palms (trunk + 9 fronds), broadleaf trees (trunk + jittered icosahedron) and desert scrub from `GEOJ.trees`.
- **Street lights.** Instanced every 55 m along both routes. Each has a pole, an arm, a head, an additive radial light pool and a `Points` glow sprite. The pools and glow fade in at night.

### Per-flow layers

Rebuilt on flow switch (`buildWorld`). `G.P` is the route centreline. `G.LP` is the driving lane, offset `LANE` = 1.7 m to the right.

- **Route ribbons and markers.** Thin gold/green ribbons with chevrons. Stage heat fills (lot polygons tinted by occupancy) sit in group `route`.
- **Capacity markings** (`rebuildCapacity`, debounced on slider change). They compare the current parameters with the **baseline**:
  - Painted bay/dock outlines are one instanced mesh named `bays`, coloured white for existing places, gold for added and red for removed.
  - Gate stages (`gateDecor`) draw one canopy, booth and barrier per lane. Added lanes get gold canopies and removed ones red ghosts, with pulsing rings. X-ray (`building:true`) draws one translucent drive-through tunnel per lane (`tubeGeo`: extruded arch, 30 m long, maroon portal rings), laid along the driving direction.
  - `setParam(k, v, user)` also shows an HTML callout over the stage ("+2 X-ray slots") and, with the "Fly to changes" toggle, flies the camera there.
- **Slot layouts** (`stageSlots`). Each slot is `{x, z, rot, in:[…], out:[…], jin, jout}`:
  - `in` / `out` are the manoeuvre waypoints. `rev:true` marks reversing; `revLast` reverses into the slot.
  - `jin` / `jout` are distances along `G.LP` where the truck leaves and rejoins the road.
  - **Layouts.**
    - `lanes`: across the road at the anchor, drive straight through.
    - `lot`: rows × bays from the `routes.py` frame. Trucks enter by the front aisle, drive down the row aisle and turn in; they reverse out, then exit at the far end.
    - `bays`: the main import lot lattice. Trucks face west, enter from the south-east edge along the aisle above their row, and leave by the aisle below.
    - `along`: kerbside bays between `fromIdx` and `toIdx`.
    - `sheds`: docks on both long sides of each shed. Trucks pull onto the apron, then reverse onto the dock.
- **Drive times.** `stageJ(key)` gives the `[join, leave]` distances per stage. `computeDrive()` turns them into `flow.drive`.

### Trucks

- **Kit.** Three tractors (`TRACTOR.eu` cab-over, `.us` long-nose conventional, `.rigid` small cab) and six loads (`LOAD.box_eu`, `cont_eu` ribbed container, `tank_us`, `box_us`, `box_rigid`, `curtain_rigid`), combined into six `KINDS` weighted by `KIND_OF[hash % 20]`. Front bumper is always at x = +0.72 so the shared headlight meshes fit every kind.
- **Meshes.** Each tractor and load has a white body mesh (instance-tinted from `CAB_TINTS` / `LOAD_TINTS`, mostly white and silver) and a fixed-colour detail mesh (glass, tyres, rims, chrome, chassis, red-white reflective stripes, tail lamps). Plus `T_lights`, `T_beam`, `T_glow` (night only). All are registered in `TMESH`; each keeps `userData.ids[]` (instance → truck id) and a per-frame counter.
- **Colouring.** Tracked truck: blue cab. Filter active: non-matching trucks fully grey (`GHOST`). Otherwise "colour by wait" or "colour by risk lane" (red/green cab) or natural liveries.
- **Instance colour buffers are pre-allocated.** In r128, `setColorAt` sizes the buffer from `count` on first call, and `count` starts at 0. Without pre-allocation the trucks render black.
- **Movement.** The display is a function of **simulated time** (`simT = sim.t + fractional acc`).
  - **Planning.** When the sim moves a truck to a new stage, `plan()` builds a polyline: the old slot's `out` manoeuvre, then `G.LP` from `jout` to the new `jin`, then the new slot's `in` manoeuvre. The polyline is Chaikin-smoothed twice.
  - **Timing.** The truck traverses the polyline between `tr.moveT` and `tr.arrT` with ease-in/out (`ease`), so on-screen motion matches the simulated drive time at every speed. A minimum of 1.5× drive speed applies if the sim time is shorter.
  - **Road queue.** Single file on `G.LP`, ending at `G.roadHead` (just before the first gate), 22 m spacing, with no overtaking. New arrivals appear 700 m back.
  - **Slot changes.** When capacity changes rebuild the slots (`G.ver`), parked trucks re-settle with a short drive (`settle`).
  - **Departure.** Released trucks follow the lane past the route end, then are culled.
- **Colouring.** Natural cab colours by default. "Colour trucks by wait" uses green under 2 h, amber 2–6 h, red over 6 h. The tracked truck is blue, with a beam, a ring and an HTML tag.
- **Picking.** A raycast on the pickable truck meshes gets the `instanceId`, then `hit.object.userData.ids[]`, then the sim truck.

### Lighting and camera

- **Lighting.** `lightHour()` is the sim clock when the lighting mode is `auto`, or a fixed hour from the Dawn, Day, Dusk or Night buttons. Elevation is `sin(π(h-6)/12)`. Day and dusk factors drive sky colours, sun and hemisphere intensity, and the lamps. At night the sun and hemisphere lerp toward a moon blue (`MOON`), and windows, canopy undersides and lamps light up.
- **Fog.** Scales with camera distance: `near = 1.3·d + 80`, `far = 4·d + 900`. This keeps close-ups crisp.
- **Sun.** Casts PCF soft shadows from a 2048 map. The frustum follows `controls.target` and resizes with zoom, from ±30 to ±240 units.
- **Camera.** `fitCamera()` runs PCA on the stage span of the route and views from the side of the long axis at 0.95 rad elevation. It fits the free area between the open panels (CSS vars `--sl` / `--sr`) and refits on resize and fold until the user moves the camera.
- **Fly-to.** `flyTo(x, z, dist, el, az, dur)` is an eased orbit transition that pulls back mid-flight on long hops. `flyToStage(key)` is triggered from labels, the bottom stage strip, the occupancy list and parameter changes.
- **Track mode.** `track()` flies to about 90 m from the truck, then follows it each frame. The "Chase cam" option also swings the camera behind the truck's heading.

## UI and features

- **Brand.** WASL wordmark with Arabic, tagline "Plan the future at your fingertips". Glass panels are deliberately see-through (`--glass` alpha .58 light / .54 dark, 22 px blur).

- **Layout.** A full-bleed map with floating "smoked-glass" panels.
  - **Fonts.** Archivo (display), IBM Plex Sans Arabic (text) and JetBrains Mono (numbers), all from Google Fonts.
  - **Theme.** Light or dark panel theme, persisted in `localStorage` (`ast:*` keys; per-viewer conveniences only).
- **Top bar.**
  - Brand plus the variant-switch badge.
  - Import/export switch.
  - Clock with a sun/moon icon.
  - Speeds: pause, 1×, 10×, 2 min/s, 10 min/s, 1 h/s.
  - Lighting mode: Auto, Dawn, Day, Dusk, Night.
  - Theme and help buttons.
- **Panels.** The left planner and the right live panel fold to edge rails with the buttons or with `[` and `]`. `Space` pauses. A first-run help dialog shows once.
- **Planner tabs** (`setPtab`): What-if, Text to map, Goal seek.
- **Text to map** (`parseText` in `plan.js`). Splits the text into clauses, matches each to an entity (`ENTITIES`: X-ray, radiation, appointment, permit, entry, release, red-lane rate, ramps, clearance, external/main parking, demand, surge, AEO, pre-arrival), decides capacity or time from time words, then reads the operation (add/raise, cut/reduce, set to, double, halve, percent). Values are clamped to slider ranges. Clauses without an entity or amount are listed as ignored. Arabic digits and common Arabic words are recognised.
- **Goal seek** (`goalSeek` / `projectPlans` in `plan.js`, UI in `app.js`):
  - `LEVERS[flow]`: one step of an intervention with `d`, `max` steps, `capex`, `opex`/yr, `lead` months and `kind` (build, staff, digital, program). Plans are compared on capex + 5 × opex (QAR M). All placeholders.
  - Three greedy searches run in lock-step (each round's candidates are one parallel batch, forecasts cached by params): `fast` (build/staff levers only, gain ÷ lead), `balanced` (gain ÷ √(cost × lead)), `cheap` (gain ÷ cost). A finishing rule takes the cheapest/quickest step that reaches the goal; a pruning pass drops steps the plan can do without; a balanced plan identical to another is searched again without that plan's biggest lever.
  - `nameByOutcome` names the results by what came out: quickest to land = Fast track, cheapest of the rest = Cost-smart, the third = Balanced. Blurbs are written from the numbers.
  - `projectPlans` runs months 0–36 with demand growing g % a year; a plan's steps switch on once their lead time has passed; each point averages seeds 11 and 23.
  - The studio overlay shows three plan cards, a projection line chart (do nothing dashed grey, plans in categorical slots 1–3, goal dotted, hover crosshair) and a cost-against-hours-saved scatter. "Visualize in the twin" resets to baseline, applies the plan with callouts, flies to the costliest change, shows a plan chip in the top bar and runs the forecast.
  - Speed: about 200 forecasts per run. Six workers under SwiftShader take several minutes; on a normal machine it is seconds to tens of seconds.
- **What-if planner.**
  - `SLIDERS[flow]` drives collapsible groups (Demand, Gates and lanes, Parking and ramps, Time at each stage, Risk and programmes), each showing a count of changed sliders.
  - `setParam` mutates `state.params` and `sim.p` live and marks changes against the baseline. The sticky footer holds Run forecast, Reset and Set baseline.
- **Forecast panel.** Baseline vs scenario table, hourly road-queue SVG chart, and a verdict naming the bottleneck.
- **Optimizer.** Steps one capacity parameter upward until `avgH ≤ target`, or reports that the resource is not the constraint. "Apply and show me" applies the value and flies to it.
- **Live panel tabs.**
  - **Now.** KPI cards plus occupancy bars per stage; click a stage to fly there.
  - **Filters.** Chips per attribute (risk lane, AEO, pre-arrival, origin, cargo); `matchF` greys out the rest on the map. Shows matching count, average hours so far and where they are. **Bottleneck pattern** (`renderPattern`): trucks queued for or occupying the bottleneck (or the busiest stage over 70%) against all trucks in the port; values with share ≥ 25% and lift ≥ 1.2 are listed with a one-line reason, and one click filters the map to the top pattern.
  - **Gate reads.** ALPR feed with styled plates; CSV export of `sim.events` with columns timestamp, plate, country, checkpoint, checkpoint_ar, flow.
  - **Track.** Plate tracker with journey card, Follow, Chase cam and Clear.
  - **Ask.** Copilot; the tab is hidden unless `sample` is granted.
- **Bottom stage strip.** One tile per stage showing occupancy, waiting count and a utilization bar. The current bottleneck gets a red dot. Click a tile to fly to that stage.
- **Map toolbar.** Toggles for stage labels, routes and zones, capacity markings, colour by wait, colour by risk lane and fly-to-changes, plus Recenter.
- **Copilot ("Ask").**
  - `sample([rules, ...turns], {tools, signal, onText})`, keeping the last 8 turns.
  - Tools:

| Tool | What it does |
|---|---|
| `get_state` | Returns the scenario, baseline, ranges and live status |
| `run_forecast({changes})` | Clamps and validates against slider ranges, runs `fcAvg`, returns compact KPIs plus the baseline |
| `apply_changes({changes})` | Moves the live controls (with the map callouts) |

  - The prompt asks for an answer in the question's language (Arabic or English), under 120 words, number first.

## Testing

- **Engine.** `node tests/sim_test.js` prints baseline KPIs and several scenario deltas for both flows. Node is not installed on the current Windows workstation.
- **UI walk-through.** `python tests/ui_test.py out_dir [--quick]` screenshots trucks, X-ray tunnels, export operational parking, filters, text to map (light and dark) and, without `--quick`, a goal-seek run, the studio and a visualized plan.
- **Render.** `python tests/render_test.py out_dir [--night]`:
  - **Browser.** Launches installed Edge or Chrome with SwiftShader, falling back to Playwright Chromium.
  - **three.js.** Served from `node_modules/three` when present (sandbox); otherwise loaded from the CDN.
  - **Screenshots.** Overview, zoom, three scripted low-angle views (central plaza, inspection yard, main lot), tracked truck, export.
  - **Capacity.** Takes a capacity-change shot (`r10_capacity.png`: two added release lanes in gold).
  - **Night.** `--night` switches lighting to Night and adds a night overview and a night zoom.

## Known issues / unverified

- **Verification.** Both variants were screenshot-verified on 2026-10-29 after the UI and movement rework: day, dusk, night, stage close-ups, tracking, capacity markings and both flows. That used SwiftShader, so real GPUs will look smoother.
- **Visual speed.** At 2 min/s and faster, trucks that drive cover in-port distances in about a second, which is true to simulated time. Use 1× or 10× to watch individual manoeuvres.
- **X-ray decor.** The X-ray gantry bays sit under the existing X-ray canopies and partly intersect them.
- **Lot manoeuvres.** These are simplified: no collision avoidance between trucks driving in the same aisle.
- **Building geometry.**
  - Heights are estimates, not measurements.
  - Footprints of buildings not marked `refine` were hand-measured from `zoom.py` grids, to about ±3 m.
- **Tree detection.** Has some false positives (dark vehicles, shadows) and misses trees in deep shadow. Dense landscaped rows are under-counted.
- **Northern close-ups.** The export external parking and Doha roundabout area has fewer modelled buildings than the central area.
- **Routes** (both flows) were traced by hand on the imagery following the GAC trip maps; they need confirmation from someone who knows the site, especially the import exit after the release gate.
- **Import X-ray position** comes from the flow-map homography; the tunnels may partly overlap the real X-ray halls.
- **Vehicle removal** misses some trucks on light concrete (inspection docks) and can soften small bright fixtures next to asphalt.
- **Dual carriageways** are painted as one 10 m road on the west carriageway; the east carriageway keeps the illustrated look.
- **Coverage.**
  - The first ~700 m of the import road and the Doha approach are outside imagery coverage; queued trucks there stand on synthesized road.
  - The import exit extension direction is a guess.
- **Parking layout.** The main import lot uses the real bay lattice. Other lots (holding area, export external parking) still use polygon-edge rows.
- **Overview framing.** Leaves some empty desert, and labels can overlap at overview zoom.
- **Texture sharpness.** The base is about 1.2 m/texel; inside the close-up tiles it is about 0.58 m/texel. Outside close-up coverage, including most of the import entry road, it is still soft.
- **Imagery licence.** Google Earth imagery is for internal prototype use only. Replace it with GAC-licensed or drone orthophotos for anything external.

## Next steps (candidates)

1. **Real data.**
   - Replace synthetic arrivals with plate-recognizer gate events. The event schema matches the CSV export.
   - Calibrate `flows.js` from historical gate, declaration and inspection data.
2. **Imagery.**
   - Add more close-ups for the import entry road (west) and the export external parking (north). Save them in `data/map-imagery/` as `closeup N.png` and re-run from `register.py`.
   - Even closer captures (about 0.3 m/px) of the X-ray portals and gates would allow a second, finer tile level.
3. **Models.**
   - Footprints and heights for more buildings, using Google Earth 3D obliques.
   - A proper X-ray portal model.
   - Bay-aligned parking in the main import lot.
4. **Simulation features.** Day-of-week and seasonal profiles, staffing and shift constraints per gate, and inspector assignment.
5. **Code structure.** Consider moving to ES modules with a bundler (Vite). If so, replace the r128 UMD builds and keep a single-file build target for artifact publishing.
