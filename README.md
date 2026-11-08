# Abu Samra

Geospatial foundation and interactive views for **Abu Samra**, Qatar’s land customs port on Salwa Road.

## Quick start

Python 3.11+. No third-party packages.

```powershell
# Optional: download / refresh OSM + elevation, then check the dataset
python -m abu_samra fetch
python -m abu_samra validate

# Serve the local maps
python view/serve.py
```

Open in a browser:

| View | URL |
|---|---|
| 2D satellite map | http://127.0.0.1:8765/view/ |
| 3D digital twin | http://127.0.0.1:8765/view/twin/ |

`fetch` reuses downloads already on disk. Pass `--refresh` to download again.

## What this repo does

- Pulls OpenStreetMap features and SRTM elevation for the Abu Samra study area
- Writes a normalized dataset under `data/processed/`
- Serves a 2D map and a 3D operations twin from that data

The Saudi Salwa border post (~8 km southwest) is outside the study area.

## Using the dataset

The contract for downstream work is `data/processed/catalog.json`.

```python
from abu_samra.loaders import load_layer, load_road_graph, load_dem

roads = load_layer("roads")          # local meters, x east, y north
port = load_layer("port_footprint")
graph = load_road_graph()
dem = load_dem()
```

Geographic files are WGS84. Local files are UTM 39N (EPSG:32639) meters with origin at the port (**x** east, **y** north).

## Sources

Map data © OpenStreetMap contributors (ODbL). Elevation is public-domain SRTM. Details: `data/processed/DATA_SOURCES.txt`.
