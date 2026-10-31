"""Find planted trees around the port from aerial imagery.

OpenStreetMap has no tree points here, so canopy pixels in the satellite tiles
are clustered into tree positions for the 3D scene. Tiles are cached under
data/cache/imagery (not part of the dataset). Requires Pillow.
"""

from __future__ import annotations

import io
import json
import math
import urllib.request
from pathlib import Path

from abu_samra.geo import LocalOrigin, local_xy, point_in_ring

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache" / "imagery"
OUT_PATH = ROOT / "data" / "processed" / "vegetation.json"
TILE_URL = "https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
ZOOM = 18
CELL_M = 5.0
MIN_HITS = 8
WINDOW = (-1150.0, -950.0, 950.0, 1000.0)


def _tile(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 2**z
    x = (lon + 180) / 360 * n
    lat_r = math.radians(lat)
    y = (1 - math.log(math.tan(lat_r) + 1 / math.cos(lat_r)) / math.pi) / 2 * n
    return x, y


def _lonlat(px: float, py: float, z: int) -> tuple[float, float]:
    n = 2**z
    lon = px / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / n))))
    return lon, lat


def _fetch(x: int, y: int, z: int) -> bytes:
    path = CACHE / str(z) / f"{x}_{y}.jpg"
    if path.exists():
        return path.read_bytes()
    request = urllib.request.Request(TILE_URL.format(x=x, y=y, z=z), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=40) as response:
        data = response.read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def detect(origin: LocalOrigin, port_ring: list[list[float]]) -> list[list[float]]:
    from PIL import Image

    lon0 = origin.longitude + WINDOW[0] / (111320 * math.cos(math.radians(origin.latitude)))
    lon1 = origin.longitude + WINDOW[2] / (111320 * math.cos(math.radians(origin.latitude)))
    lat0 = origin.latitude + WINDOW[1] / 110700
    lat1 = origin.latitude + WINDOW[3] / 110700
    tx0, ty0 = _tile(lon0, lat1, ZOOM)
    tx1, ty1 = _tile(lon1, lat0, ZOOM)
    cells: dict[tuple[int, int], list[float]] = {}
    for ty in range(int(ty0), int(ty1) + 1):
        for tx in range(int(tx0), int(tx1) + 1):
            image = Image.open(io.BytesIO(_fetch(tx, ty, ZOOM))).convert("RGB")
            pixels = image.load()
            for py in range(0, 256, 2):
                for px in range(0, 256, 2):
                    r, g, b = pixels[px, py]
                    if not _is_canopy(r, g, b):
                        continue
                    lon, lat = _lonlat(tx + px / 256, ty + py / 256, ZOOM)
                    x, y = local_xy(lat, lon, origin)
                    key = (int(math.floor(x / CELL_M)), int(math.floor(y / CELL_M)))
                    cell = cells.setdefault(key, [0, 0.0, 0.0])
                    cell[0] += 1
                    cell[1] += x
                    cell[2] += y
    trees = []
    for count, sx, sy in cells.values():
        if count < MIN_HITS:
            continue
        x, y = sx / count, sy / count
        if not point_in_ring(x, y, port_ring):
            continue
        trees.append([round(x, 1), round(y, 1)])
    return trees


def _is_canopy(r: int, g: int, b: int) -> bool:
    """Palm canopies here are dark and warm; asphalt and roof shadows are neutral grey."""
    return r + g + b < 235 and r - b >= 10 and g - b >= 4 and r < 100


def main() -> None:
    graph = json.loads((ROOT / "data" / "processed" / "road_graph.json").read_text(encoding="utf-8"))
    o = graph["local_origin"]
    origin = LocalOrigin(o["longitude"], o["latitude"], o["easting"], o["northing"], o["utm_zone"], o["epsg"])
    port = json.loads((ROOT / "data" / "processed" / "local" / "port_footprint.json").read_text(encoding="utf-8"))
    ring = port["features"][0]["geometry"]["coordinates"][0]
    trees = detect(origin, ring)
    OUT_PATH.write_text(
        json.dumps({"source": "Tree canopy pixels in Google satellite tiles, zoom 18, clustered to 5 m cells inside the port", "palms": trees}),
        encoding="utf-8",
    )
    print(f"wrote {OUT_PATH} with {len(trees)} trees")


if __name__ == "__main__":
    main()
