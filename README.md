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

Open the twin through this server, not as a file: the server also fetches the satellite ground tiles and caches them under `data/cache/sat/`. After one online run the twin works offline; with no tiles at all it falls back to a painted desert.

- **Controls:** drag to pan, right-drag to orbit, wheel to zoom, click a vehicle to ride along with it.
- **Keys:** `1` `2` `3` flows, `N` next time of day, `T` tour, `F` follow a truck, `P` presentation mode, `D` dashboard, `L` labels, `Space` pause.
- **Deep links:** `?light=day|sunset|night`, `?view=overview|gates|yard|xray|ramps|booths`, `?flow=inbound|outbound|passenger`, `?lang=ar`, `?present=1`, `?intro=0`, `?sat=0`, `?drift=0`, `?cam=x,y,distance,polar,bearing`.

Traffic, counts and the activity feed are simulated. Satellite imagery © Esri, Maxar, Earthstar Geographics.

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
