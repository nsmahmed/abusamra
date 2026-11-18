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
- **Keys:** `1` `2` `3` flows, `N` next time of day, `T` tour, `F` follow a truck, `P` presentation mode, `D` dashboard, `E` executive overview, `C` capacity planner, `L` labels, `Space` pause.
- **Deep links:** `?light=day|sunset|night`, `?view=overview|gates|yard|xray|ramps|booths`, `?flow=inbound|outbound|passenger`, `?lang=ar`, `?present=1`, `?exec=1`, `?intro=0`, `?drift=0`, `?cam=x,y,distance,polar,bearing`.
- **Executive overview:** the gold button in the top bar (or `E`) opens a full-screen board: headline figures, a two-hour trend, the status of every station, clearance times against a 40-minute target, inspection-channel split, cargo mix and the passenger hall. Clicking a station or an event returns to it in 3D. The target is illustrative; change `TARGET_MIN` in `view/twin/executive.js`.
- **Capacity planner:** the teal Planner button (or `C`) opens what-if settings for the main parking (450–1,100 bays), the x-ray scanners (1–4) and the import inspection ramps. Proposals are drawn into the scene as outlines: extra bays light up in the unused lot, closed bays turn red, extra scanners appear as blueprint gantries on the x-ray lanes. The ramps are split by inspection category (Chemical & Others, OGA, Health & Food); dragging the allocation bar lends docks between sheds, the docks recolour, and simulated trucks use only docks of their category. Impact figures come from a small queueing model; its assumptions and every limit are in `view/twin/config.json`.
- **Quality:** the default targets a steady 60 fps on integrated graphics (about a 1080p frame, post-process anti-aliasing). Add `?quality=high` on a machine with a discrete GPU for native resolution and multisampling.

Traffic, counts and the activity feed are simulated. Terrain tones are derived from Esri World Imagery (© Esri, Maxar, Earthstar Geographics).

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
