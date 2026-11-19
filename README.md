# Abu Samra customs port — data foundation

Free geometric data for a later 2D map and 3D model of Abu Samra, Qatar's land customs port on Salwa Road. This package downloads and normalizes that data. It does not build the map or the model.

## Run

From this directory:

```powershell
python tests/test_foundations.py
python -m abu_samra fetch
python -m abu_samra validate
```

`fetch` reuses raw downloads already on disk. Pass `--refresh` to download again.

The contract for the next stage is `data/processed/catalog.json`.

```python
from abu_samra.loaders import load_layer, load_road_graph, load_dem, iter_dem_posts

roads = load_layer("roads")          # local meters, x east, y north
port = load_layer("port_footprint")  # the border-control polygon
graph = load_road_graph()
dem = load_dem()
```

`port_footprint` is also written at `data/processed/local/port_footprint.json`.

## 3D digital twin

```powershell
python view/serve.py          # then open http://127.0.0.1:8765/view/twin/
python view/serve.py 9000     # or pick another port
```

Open the twin through this server, not as a file. It needs no connection beyond the first load of three.js and the fonts: the desert floor is built in the shader from two small tone maps in `view/twin/assets/`, a heavily smoothed colour reference of the real terrain, so nothing is streamed while it runs.

- **Controls:** drag to pan, right-drag to orbit, wheel to zoom, click a vehicle to ride along with it.
- **Keys:** `1` `2` `3` flows, `N` next time of day, `T` tour, `F` follow a truck, `P` presentation mode, `D` dashboard, `E` executive overview, `C` scenario planner, `L` labels, `Space` pause.
- **Deep links:** `?light=day|sunset|night`, `?view=overview|gates|yard|xray|ramps|booths`, `?flow=inbound|outbound|passenger`, `?lang=ar`, `?present=1`, `?exec=1`, `?intro=0`, `?drift=0`, `?cam=x,y,distance,polar,bearing`.
- **Dashboard (right):** the port's KPIs from the learned model: median time in port, P90, share over 12 h, trucks per day, sustainable trucks per day, declaration wait and inspection queue. Next to them, the bottleneck and which trucks are stuck in it. Under a scenario, every figure shows its change from today (green better, red worse). The small arrow slides the panel off screen.
- **Scenario planner (left, `C`):**
  - **What-if** moves load increase (clickable marks from the data: busy day, busiest week, 2026 peak day, 2026 growth), X-ray lanes, inspection docks and their split by category (today inferred / smart / by shed), parking, pre-arrival filing, green channel and shift overlap.
  - It shows the impact stage by stage, why each figure moved, and the bottleneck.
  - Each section's gear sets that lever's limits (kept in this browser).
  - **Goal seek** searches the model in reverse for plans that reach a target and costs each one.
  - The scenario is kept in the address (`#plan=…`).
- **Executive overview (`E`):** a full-screen board of the same KPIs, the stay distribution today against the scenario, where the time goes, arrivals against inspection capacity by hour (shift handovers marked), and the category and plate-country mix.
- **Trucks:** every inbound truck is a synthetic truck drawn from the learned distributions. Its plate is in its country's format, and its goods category sets its ramp. Click a truck to see its expected journey and its delay risk with the reasons.
- **2030 story:** `view/twin/story.html` presents the port today, 2030 without change, a goal, the plans and the port after the decision.

### Demo and publishing

- **Demo** (next to Tour) plays the WASL story inside the twin, with headline numbers at the top. It moves through Watch (today), Anticipate (2030 as is), Simulate (goal seek to 3.5 h) and Lead (the plan applied, before and after on the executive board). Use ‹ › or the arrow keys to step, and Esc to end.
- **GitHub Pages:** `.github/workflows/pages.yml` publishes `view/twin/` and `data/processed/scene.json` on every push to `main`. The site root opens the twin.
- **Pitch deck:** `python docs/pitch/build_deck.py` rebuilds `docs/pitch/WASL_AI_Accelerate_pitch.pptx`.

### The model behind it

`python ml/learn.py` reads the GAC extracts in `portinfo/reports` (never committed). It cleans them as in the bottleneck report, fits the models and writes `view/twin/learned.json`, which holds only aggregates and synthetic trucks. `python tests/model_test.py` checks the calibrated model in a headless browser. Assumptions and unit costs are in `view/twin/config.json`. [docs/AI.md](docs/AI.md) lists every ML part, method, validation figure and cost source.
- **Quality:** the default targets a steady 60 fps on integrated graphics (about a 1080p frame, post-process anti-aliasing). Add `?quality=high` on a machine with a discrete GPU for native resolution and multisampling.

Traffic and the activity feed are simulated; truck behaviour and every KPI come from the learned model, so the figures are synthetic but shaped by the port's data. Terrain tones are derived from Esri World Imagery (© Esri, Maxar, Earthstar Geographics).

## What is included

- The Abu Samra Border Post polygon and the roads, gates, and barriers inside and around it.
- Salwa Road on the Qatar side: the approach toward Doha and the exit toward the border. The Saudi Salwa post, about 8 km southwest, is outside the study area.
- Building footprints and land cover where OpenStreetMap has them, as context only.
- A 1 arc-second terrain grid (SRTM) in meters, plus a road graph split at intersections and gates.

## Frame

Geographic files are WGS84. Local files are EPSG:32639 (UTM 39N) meters with the origin at the port, **x east, y north**. Elevation is a separate up axis. This is not a Y-up 3D scene.

Lane counts are copied only when OpenStreetMap tagged them. Parallel ways at the port may already be separate carriageways, so an untagged way must be drawn as one ribbon.

## Sources

Map data © OpenStreetMap contributors, ODbL. Elevation is public-domain SRTM from the public `elevation-tiles-prod` bucket. See `data/processed/DATA_SOURCES.txt`.
