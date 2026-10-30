"""Clip the public SRTM 1 arc-second tile to the study area.

The tile N24E050 is US public-domain SRTM, downloaded from the public
elevation-tiles-prod bucket. Elevations are orthometric meters (EGM96),
posted at 1 arc-second. Voids use the HGT sentinel -32768.
"""

from __future__ import annotations

import array
import csv
import gzip
import json
import sys
import urllib.parse
from pathlib import Path

from abu_samra.config import (
    ELEVATION_CROSSCHECK_URL,
    SRTM_SOUTHWEST,
    SRTM_TILE_NAME,
    SRTM_URLS,
)
from abu_samra.geo import BBox, LocalOrigin, local_xy
from abu_samra.http_util import get_bytes

VOID = -32768
ARCSEC = 1 / 3600


def tile_path(directory: Path) -> Path:
    return directory / f"{SRTM_TILE_NAME}.hgt.gz"


def ensure_tile(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = tile_path(directory)
    if _valid_gzip_hgt(path):
        print(f"[abu-samra] Reusing elevation tile {path}")
        return path
    errors: list[str] = []
    for url in SRTM_URLS:
        try:
            print(f"[abu-samra] Downloading elevation tile {url}")
            data = get_bytes(url, timeout=180, attempts=2)
        except Exception as exc:
            errors.append(f"{url}: {exc}")
            continue
        path.write_bytes(data)
        if _valid_gzip_hgt(path):
            return path
        errors.append(f"{url}: downloaded file is not a valid HGT gzip")
    raise RuntimeError("Could not download SRTM tile. " + " | ".join(errors))


def _valid_gzip_hgt(path: Path) -> bool:
    if not path.exists() or path.stat().st_size < 1000:
        return False
    try:
        values, _size = read_hgt(path)
    except (OSError, gzip.BadGzipFile, ValueError):
        return False
    return len(values) in {3601 * 3601, 1201 * 1201}


def read_hgt(path: Path) -> tuple[array.array, int]:
    with gzip.open(path, "rb") as handle:
        raw = handle.read()
    size = 3601 if len(raw) == 3601 * 3601 * 2 else 1201 if len(raw) == 1201 * 1201 * 2 else 0
    if size == 0:
        raise ValueError(f"Unexpected HGT size {len(raw)} bytes in {path}")
    values = array.array("h")
    values.frombytes(raw)
    if sys.byteorder == "little":
        values.byteswap()
    return values, size


class DemGrid:
    def __init__(
        self,
        lat_by_row: list[float],
        lon_by_col: list[float],
        elevation_m: list[float | None],
    ) -> None:
        self.lat_by_row = lat_by_row
        self.lon_by_col = lon_by_col
        self.elevation_m = elevation_m
        self.rows = len(lat_by_row)
        self.cols = len(lon_by_col)

    def sample(self, lat: float, lon: float) -> float | None:
        if self.rows < 2 or self.cols < 2:
            return None
        row_f = (self.lat_by_row[0] - lat) / (self.lat_by_row[0] - self.lat_by_row[1])
        col_f = (lon - self.lon_by_col[0]) / (self.lon_by_col[1] - self.lon_by_col[0])
        if row_f < 0 or col_f < 0 or row_f > self.rows - 1 or col_f > self.cols - 1:
            return None
        r0 = int(row_f)
        c0 = int(col_f)
        r1 = min(r0 + 1, self.rows - 1)
        c1 = min(c0 + 1, self.cols - 1)
        dr = row_f - r0
        dc = col_f - c0
        corners = [
            self._at(r0, c0),
            self._at(r0, c1),
            self._at(r1, c0),
            self._at(r1, c1),
        ]
        if any(value is None for value in corners):
            known = [value for value in corners if value is not None]
            if not known:
                return None
            return round(sum(known) / len(known), 2)
        z00, z01, z10, z11 = corners
        z0 = z00 * (1 - dc) + z01 * dc
        z1 = z10 * (1 - dc) + z11 * dc
        return round(z0 * (1 - dr) + z1 * dr, 2)

    def _at(self, row: int, col: int) -> float | None:
        return self.elevation_m[row * self.cols + col]


def clip_tile(values: array.array, size: int, bbox: BBox, pad_posts: int = 1) -> DemGrid:
    south_tile, west_tile = SRTM_SOUTHWEST
    step = 1 / (size - 1)

    def row_index(lat: float) -> float:
        return (south_tile + 1 - lat) / step

    def col_index(lon: float) -> float:
        return (lon - west_tile) / step

    r0 = max(0, int(row_index(bbox.north)) - pad_posts)
    r1 = min(size - 1, int(row_index(bbox.south)) + pad_posts)
    c0 = max(0, int(col_index(bbox.west)) - pad_posts)
    c1 = min(size - 1, int(col_index(bbox.east)) + pad_posts)
    if r1 < r0 or c1 < c0:
        raise ValueError("Study area does not intersect the SRTM tile")

    lat_by_row = [round((south_tile + 1) - row * step, 7) for row in range(r0, r1 + 1)]
    lon_by_col = [round(west_tile + col * step, 7) for col in range(c0, c1 + 1)]
    elevations: list[float | None] = []
    for row in range(r0, r1 + 1):
        for col in range(c0, c1 + 1):
            raw = int(values[row * size + col])
            elevations.append(None if raw == VOID else float(raw))
    return DemGrid(lat_by_row, lon_by_col, elevations)


def crosscheck(grid: DemGrid) -> list[dict]:
    """Compare a few posts with the keyless Open-Meteo elevation endpoint."""
    samples = [
        (0, 0),
        (0, grid.cols - 1),
        (grid.rows - 1, 0),
        (grid.rows - 1, grid.cols - 1),
        (grid.rows // 2, grid.cols // 2),
    ]
    lats = []
    lons = []
    ours = []
    for row, col in samples:
        lats.append(grid.lat_by_row[row])
        lons.append(grid.lon_by_col[col])
        ours.append(grid.elevation_m[row * grid.cols + col])
    query = urllib.parse.urlencode(
        {"latitude": ",".join(str(lat) for lat in lats), "longitude": ",".join(str(lon) for lon in lons)}
    )
    try:
        payload = json.loads(get_bytes(f"{ELEVATION_CROSSCHECK_URL}?{query}", timeout=30, attempts=2))
        remote = payload.get("elevation") or []
    except Exception as exc:
        return [{"error": str(exc)}]
    rows = []
    for lat, lon, local, remote_value in zip(lats, lons, ours, remote):
        delta = None if local is None or remote_value is None else round(float(remote_value) - local, 2)
        rows.append(
            {
                "latitude": lat,
                "longitude": lon,
                "srtm_m": local,
                "open_meteo_m": remote_value,
                "open_meteo_minus_srtm_m": delta,
            }
        )
    return rows


def write_dem(grid: DemGrid, origin: LocalOrigin, directory: Path, source_file: Path, cross: list[dict]) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    finite = [value for value in grid.elevation_m if value is not None]
    if not finite:
        raise RuntimeError("DEM clip contains no elevations")
    stats = {
        "min_m": min(finite),
        "max_m": max(finite),
        "mean_m": round(sum(finite) / len(finite), 2),
        "voids": sum(1 for value in grid.elevation_m if value is None),
        "posts": len(grid.elevation_m),
    }
    csv_path = directory / "dem_posts.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["row", "col", "latitude", "longitude", "x_m", "y_m", "elevation_m"])
        for row, lat in enumerate(grid.lat_by_row):
            for col, lon in enumerate(grid.lon_by_col):
                x, y = local_xy(lat, lon, origin)
                elevation = grid.elevation_m[row * grid.cols + col]
                writer.writerow(
                    [
                        row,
                        col,
                        f"{lat:.7f}",
                        f"{lon:.7f}",
                        f"{x:.3f}",
                        f"{y:.3f}",
                        "" if elevation is None else f"{elevation:.1f}",
                    ]
                )
    meta = {
        "source": "SRTM 1 arc-second, tile N24E050",
        "source_file": source_file.name,
        "license": "SRTM is US public-domain data. Tile fetched from the public elevation-tiles-prod S3 bucket.",
        "vertical_datum": "EGM96 meters, orthometric. Not ellipsoidal height.",
        "posting": "1 arc-second (about 31 m north-south and 28 m east-west at this latitude)",
        "row_direction": "north_to_south",
        "rows": grid.rows,
        "cols": grid.cols,
        "lat_by_row": grid.lat_by_row,
        "lon_by_col": grid.lon_by_col,
        "elevation_m": grid.elevation_m,
        "step_degrees": ARCSEC,
        "local_origin": origin.as_dict(),
        "frame": "Project each post with abu_samra.geo.local_xy. Do not assume square cells in meters.",
        "mesh_recipe": (
            "For each row r in 0..rows-2 and col c in 0..cols-2, index i = r*cols+c. "
            "Triangles are (i, i+1, i+cols+1) and (i, i+cols+1, i+cols). "
            "Row 0 is the north edge. Position XY comes from latitude/longitude, Z from elevation_m."
        ),
        "posts_csv": "dem_posts.csv",
        "stats": stats,
        "open_meteo_crosscheck": cross,
        "known_reference": {
            "name": "Abu Samra Border Post helipad",
            "published_elevation": "16 ft / 5 m MSL (OurAirports QA-0002)",
            "note": "Use this only as a sanity check. SRTM posting is 30 m and will not match a surveyed pad exactly.",
        },
    }
    (directory / "dem.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta
