"""Load the processed Abu Samra dataset. This is the entry point for the 2D/3D stage."""

from __future__ import annotations

import csv
import json
from pathlib import Path

from abu_samra.config import LOCAL_DIR, PROCESSED_DIR, WGS84_DIR
from abu_samra.geo import LocalOrigin, local_xy


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_manifest() -> dict:
    return _read_json(PROCESSED_DIR / "manifest.json")


def load_catalog() -> dict:
    return _read_json(PROCESSED_DIR / "catalog.json")


def load_layer(name: str, frame: str = "local") -> dict:
    if frame == "local":
        path = LOCAL_DIR / f"{name}.json"
    elif frame == "wgs84":
        path = WGS84_DIR / f"{name}.geojson"
    else:
        raise ValueError("frame must be 'local' or 'wgs84'")
    return _read_json(path)


def load_road_graph() -> dict:
    return _read_json(PROCESSED_DIR / "road_graph.json")


def load_turn_restrictions() -> dict:
    return _read_json(PROCESSED_DIR / "turn_restrictions.json")


def load_port_footprint(frame: str = "local") -> dict:
    if frame == "local":
        return _read_json(LOCAL_DIR / "port_footprint.json")
    return _read_json(WGS84_DIR / "port_footprint.geojson")


def load_dem() -> dict:
    return _read_json(PROCESSED_DIR / "elevation" / "dem.json")


def iter_dem_posts(dem: dict | None = None):
    """Yield each terrain post with exact local east/north meters and elevation."""
    dem = load_dem() if dem is None else dem
    origin = LocalOrigin(**dem["local_origin"])
    cols = dem["cols"]
    for row, lat in enumerate(dem["lat_by_row"]):
        for col, lon in enumerate(dem["lon_by_col"]):
            elevation = dem["elevation_m"][row * cols + col]
            x, y = local_xy(lat, lon, origin)
            yield {
                "row": row,
                "col": col,
                "longitude": lon,
                "latitude": lat,
                "x": x,
                "y": y,
                "elevation_m": elevation,
            }


def dem_triangles(rows: int, cols: int):
    """Index triples for a terrain mesh. Row 0 is the northern edge."""
    for row in range(rows - 1):
        for col in range(cols - 1):
            index = row * cols + col
            yield (index, index + 1, index + cols + 1)
            yield (index, index + cols + 1, index + cols)


def load_dem_csv() -> list[dict]:
    path = PROCESSED_DIR / "elevation" / "dem_posts.csv"
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))
