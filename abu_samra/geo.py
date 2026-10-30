"""Geodesy for a small study area: WGS84, UTM zone 39N, and rectangle clipping.

Local coordinates are meters in an East-North frame whose origin is the port.
They are a translation of EPSG:32639, so distances match UTM. They are not a
Three.js Y-up frame; elevation stays on a separate Z axis.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from abu_samra.config import UTM_ZONE

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
UTM_K0 = 0.9996
UTM_FALSE_EASTING = 500_000.0


@dataclass(frozen=True)
class BBox:
    south: float
    west: float
    north: float
    east: float

    def as_dict(self) -> dict[str, float]:
        return {
            "south": self.south,
            "west": self.west,
            "north": self.north,
            "east": self.east,
        }

    def contains(self, lon: float, lat: float) -> bool:
        return self.west <= lon <= self.east and self.south <= lat <= self.north

    def overpass(self) -> str:
        return f"({self.south:.7f},{self.west:.7f},{self.north:.7f},{self.east:.7f})"

    def polygon(self) -> list[list[float]]:
        return [
            [self.west, self.south],
            [self.east, self.south],
            [self.east, self.north],
            [self.west, self.north],
            [self.west, self.south],
        ]


@dataclass(frozen=True)
class LocalOrigin:
    longitude: float
    latitude: float
    easting: float
    northing: float
    utm_zone: int = UTM_ZONE
    epsg: int = 32639

    def as_dict(self) -> dict[str, float | int]:
        return {
            "longitude": self.longitude,
            "latitude": self.latitude,
            "easting": self.easting,
            "northing": self.northing,
            "utm_zone": self.utm_zone,
            "epsg": self.epsg,
        }


def utm_zone(longitude: float) -> int:
    return int((longitude + 180) / 6) + 1


def wgs84_to_utm(latitude: float, longitude: float, zone: int = UTM_ZONE) -> tuple[float, float]:
    """Convert WGS84 degrees to UTM easting/northing. Northern hemisphere only."""
    lat = math.radians(latitude)
    lon = math.radians(longitude)
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    e2 = WGS84_F * (2 - WGS84_F)
    ep2 = e2 / (1 - e2)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)
    n = WGS84_A / math.sqrt(1 - e2 * sin_lat * sin_lat)
    t = tan_lat * tan_lat
    c = ep2 * cos_lat * cos_lat
    a = (lon - lon0) * cos_lat
    m = WGS84_A * (
        (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * lat
        - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * math.sin(2 * lat)
        + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * math.sin(4 * lat)
        - (35 * e2**3 / 3072) * math.sin(6 * lat)
    )
    easting = UTM_FALSE_EASTING + UTM_K0 * n * (
        a
        + (1 - t + c) * a**3 / 6
        + (5 - 18 * t + t**2 + 72 * c - 58 * ep2) * a**5 / 120
    )
    northing = UTM_K0 * (
        m
        + n
        * tan_lat
        * (
            a**2 / 2
            + (5 - t + 9 * c + 4 * c**2) * a**4 / 24
            + (61 - 58 * t + t**2 + 600 * c - 330 * ep2) * a**6 / 720
        )
    )
    return easting, northing


def local_xy(latitude: float, longitude: float, origin: LocalOrigin) -> tuple[float, float]:
    easting, northing = wgs84_to_utm(latitude, longitude, origin.utm_zone)
    return easting - origin.easting, northing - origin.northing


def make_origin(latitude: float, longitude: float) -> LocalOrigin:
    easting, northing = wgs84_to_utm(latitude, longitude, UTM_ZONE)
    return LocalOrigin(longitude=longitude, latitude=latitude, easting=easting, northing=northing)


def meters_per_degree(latitude: float) -> tuple[float, float]:
    lat = math.radians(latitude)
    per_lat = 111132.92 - 559.82 * math.cos(2 * lat) + 1.175 * math.cos(4 * lat)
    per_lon = 111412.84 * math.cos(lat) - 93.5 * math.cos(3 * lat)
    return per_lat, per_lon


def expand_bbox(bbox: BBox, margins_m: dict[str, float]) -> BBox:
    lat_mid = (bbox.south + bbox.north) / 2
    per_lat, per_lon = meters_per_degree(lat_mid)
    return BBox(
        south=bbox.south - margins_m["south"] / per_lat,
        west=bbox.west - margins_m["west"] / per_lon,
        north=bbox.north + margins_m["north"] / per_lat,
        east=bbox.east + margins_m["east"] / per_lon,
    )


def ring_bounds(ring: list[tuple[float, float]]) -> BBox:
    lons = [lon for lon, _lat in ring]
    lats = [lat for _lon, lat in ring]
    return BBox(south=min(lats), west=min(lons), north=max(lats), east=max(lons))


def vertex_mean(ring: list[tuple[float, float]]) -> tuple[float, float]:
    points = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    lon = sum(point[0] for point in points) / len(points)
    lat = sum(point[1] for point in points) / len(points)
    return lon, lat


def close_ring(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if not ring:
        return ring
    if ring[0] != ring[-1]:
        return [*ring, ring[0]]
    return ring


def polyline_length_m(coords: list[tuple[float, float]], origin: LocalOrigin) -> float:
    total = 0.0
    previous = None
    for lon, lat in coords:
        current = local_xy(lat, lon, origin)
        if previous is not None:
            total += math.hypot(current[0] - previous[0], current[1] - previous[1])
        previous = current
    return total


def polygon_area_m2(ring: list[tuple[float, float]], origin: LocalOrigin) -> float:
    points = [local_xy(lat, lon, origin) for lon, lat in close_ring(ring)]
    area = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        area += x1 * y2 - x2 * y1
    return abs(area) / 2


def point_in_ring(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    points = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if len(points) < 3:
        return False
    inside = False
    previous = len(points) - 1
    for index, (xi, yi) in enumerate(points):
        xj, yj = points[previous]
        crosses = (yi > lat) != (yj > lat)
        if crosses:
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_cross:
                inside = not inside
        previous = index
    return inside


def _orient(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
    d: tuple[float, float],
) -> bool:
    o1 = _orient(a, b, c)
    o2 = _orient(a, b, d)
    o3 = _orient(c, d, a)
    o4 = _orient(c, d, b)
    return o1 * o2 < 0 and o3 * o4 < 0


def line_hits_ring(coords: list[tuple[float, float]], ring: list[tuple[float, float]]) -> bool:
    if any(point_in_ring(lon, lat, ring) for lon, lat in coords):
        return True
    polygon = close_ring(ring)
    for start, end in zip(coords, coords[1:]):
        for edge_start, edge_end in zip(polygon, polygon[1:]):
            if segments_intersect(start, end, edge_start, edge_end):
                return True
    return False


_LEFT, _RIGHT, _BOTTOM, _TOP = 1, 2, 4, 8


def _out_code(lon: float, lat: float, bbox: BBox) -> int:
    code = 0
    if lon < bbox.west:
        code |= _LEFT
    elif lon > bbox.east:
        code |= _RIGHT
    if lat < bbox.south:
        code |= _BOTTOM
    elif lat > bbox.north:
        code |= _TOP
    return code


def clip_segment(
    start: tuple[float, float],
    end: tuple[float, float],
    bbox: BBox,
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    x1, y1 = start
    x2, y2 = end
    c1 = _out_code(x1, y1, bbox)
    c2 = _out_code(x2, y2, bbox)
    for _ in range(16):
        if c1 == 0 and c2 == 0:
            return (x1, y1), (x2, y2)
        if c1 & c2:
            return None
        code = c1 or c2
        dx = x2 - x1
        dy = y2 - y1
        if code & _TOP:
            if dy == 0:
                return None
            x = x1 + dx * (bbox.north - y1) / dy
            y = bbox.north
        elif code & _BOTTOM:
            if dy == 0:
                return None
            x = x1 + dx * (bbox.south - y1) / dy
            y = bbox.south
        elif code & _RIGHT:
            if dx == 0:
                return None
            y = y1 + dy * (bbox.east - x1) / dx
            x = bbox.east
        else:
            if dx == 0:
                return None
            y = y1 + dy * (bbox.west - x1) / dx
            x = bbox.west
        if code == c1:
            x1, y1 = x, y
            c1 = _out_code(x1, y1, bbox)
        else:
            x2, y2 = x, y
            c2 = _out_code(x2, y2, bbox)
    return None


def _near(a: tuple[float, float], b: tuple[float, float], tol: float = 1e-9) -> bool:
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def clip_linestring(coords: list[tuple[float, float]], bbox: BBox) -> list[list[tuple[float, float]]]:
    parts: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    for start, end in zip(coords, coords[1:]):
        clipped = clip_segment(start, end, bbox)
        if clipped is None:
            if len(current) >= 2:
                parts.append(current)
            current = []
            continue
        left, right = clipped
        if not current:
            current = [left, right]
        elif _near(current[-1], left):
            current.append(right)
        else:
            if len(current) >= 2:
                parts.append(current)
            current = [left, right]
    if len(current) >= 2:
        parts.append(current)
    return parts


def _intersect_vertical(
    start: tuple[float, float], end: tuple[float, float], x_edge: float
) -> tuple[float, float]:
    if end[0] == start[0]:
        return x_edge, start[1]
    t = (x_edge - start[0]) / (end[0] - start[0])
    return x_edge, start[1] + t * (end[1] - start[1])


def _intersect_horizontal(
    start: tuple[float, float], end: tuple[float, float], y_edge: float
) -> tuple[float, float]:
    if end[1] == start[1]:
        return start[0], y_edge
    t = (y_edge - start[1]) / (end[1] - start[1])
    return start[0] + t * (end[0] - start[0]), y_edge


def clip_polygon(ring: list[tuple[float, float]], bbox: BBox) -> list[tuple[float, float]]:
    points = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else list(ring)
    edges = (
        (lambda p: p[0] >= bbox.west, lambda a, b: _intersect_vertical(a, b, bbox.west)),
        (lambda p: p[0] <= bbox.east, lambda a, b: _intersect_vertical(a, b, bbox.east)),
        (lambda p: p[1] >= bbox.south, lambda a, b: _intersect_horizontal(a, b, bbox.south)),
        (lambda p: p[1] <= bbox.north, lambda a, b: _intersect_horizontal(a, b, bbox.north)),
    )
    for inside, intersect in edges:
        if not points:
            return []
        output: list[tuple[float, float]] = []
        previous = points[-1]
        for current in points:
            if inside(current):
                if not inside(previous):
                    output.append(intersect(previous, current))
                output.append(current)
            elif inside(previous):
                output.append(intersect(previous, current))
            previous = current
        points = output
    if len(points) < 3:
        return []
    return close_ring(points)


def round_lonlat(lon: float, lat: float) -> list[float]:
    return [round(lon, 7), round(lat, 7)]


def round_xy(x: float, y: float) -> list[float]:
    return [round(x, 3), round(y, 3)]
