"""Customs operations layout for Abu Samra, derived from the mapped geometry.

Booth lanes are the short carriageways that pass under the inspection roofs.
Following the GAC import process map (reference/img02-import.jpeg) checked against
satellite imagery: the two cargo scanners are the lanes past the comb-shaped
x-ray halls between the main parking and Salwa Road, and the truck inspection
ramps are the two long sheds and one short shed in the walled compound east of
the main parking. Nothing here invents a lane that is not already a road in
the dataset.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRAPH_PATH = ROOT / "data" / "processed" / "road_graph.json"
BUILDINGS_PATH = ROOT / "data" / "processed" / "wgs84" / "buildings.geojson"
OUT_PATH = ROOT / "data" / "processed" / "operations.json"

ALONG = (math.sin(math.radians(42)), math.cos(math.radians(42)))

# Roofs the trunk carriageways drive through, confirmed by intersection.
ARRIVAL_BOOTHS = (1168202656, 1168202658, 1168202661, 1168202663)
DEPARTURE_BOOTHS = (619559022, 619559024, 619559026, 619559028)
ARRIVAL_CANOPY = 295856215
DEPARTURE_CANOPY = 295856213
DEPARTURE_HALL_CANOPY = 295856183

# The two x-ray scanning halls and the lane past each (the two contracted cargo scanners).
SCANNER_BUILDINGS = (1485001841, 1485001842)
SCANNER_ROADS = (1409965497, 1328553508)
# Inspection ramp sheds, and the compound lanes trucks take to reach their docks.
TRUCK_PLATFORMS = (295856199, 295856216, 295856190)
PLATFORM_LANES = (1457063892, 1457063896)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _along_delta(edge: dict) -> float:
    start, end = edge["xy"][0], edge["xy"][-1]
    return (end[0] - start[0]) * ALONG[0] + (end[1] - start[1]) * ALONG[1]


def _bearing(xy: list[list[float]]) -> float:
    start, end = xy[0], xy[-1]
    return math.degrees(math.atan2(end[0] - start[0], end[1] - start[1])) % 360


def _midpoint(edge: dict) -> tuple[float, float]:
    lon = sum(point[0] for point in edge["coordinates"]) / len(edge["coordinates"])
    lat = sum(point[1] for point in edge["coordinates"]) / len(edge["coordinates"])
    return round(lon, 7), round(lat, 7)


def _append(path: list[list[float]], extra: list[list[float]]) -> None:
    if not extra:
        return
    if path and path[-1] == extra[0]:
        path.extend(extra[1:])
    else:
        path.extend(extra)


def _walk(start: dict, outgoing: dict[str, list[dict]], forward: bool) -> list[dict]:
    """Follow the carriageway, staying on trunk roads when the booth is on one."""
    sign = 1 if _along_delta(start) >= 0 else -1
    chain = [start]
    seen = {start["id"]}
    node = start["to"] if forward else start["from"]
    for _ in range(60):
        candidates = []
        for edge in outgoing.get(node, []):
            if edge["id"] in seen or not edge["vehicle"] or edge["status"] != "operational":
                continue
            progress = _along_delta(edge) * sign
            if progress < 8:
                continue
            same = edge["highway"] == start["highway"]
            candidates.append((progress + (400 if same else 0), edge))
        if not candidates:
            break
        candidates.sort(key=lambda item: item[0], reverse=True)
        chosen = candidates[0][1]
        chain.append(chosen)
        seen.add(chosen["id"])
        node = chosen["to"]
    if not forward:
        chain.reverse()
    return chain


def _chain_line(chain: list[dict]) -> tuple[list[list[float]], list[list[float]]]:
    longitudes: list[list[float]] = []
    local: list[list[float]] = []
    for edge in chain:
        _append(longitudes, edge["coordinates"])
        _append(local, edge["xy"])
    return longitudes, local


def _building_features() -> dict[int, dict]:
    collection = _load(BUILDINGS_PATH)
    found = {}
    for feature in collection["features"]:
        osm_id = feature["properties"].get("osm_id")
        if osm_id is not None:
            found[int(osm_id)] = feature
    return found


def _polygon(feature: dict) -> list[list[float]]:
    geometry = feature["geometry"]
    ring = geometry["coordinates"][0] if geometry["type"] == "Polygon" else geometry["coordinates"][0][0]
    return [[round(point[0], 7), round(point[1], 7)] for point in ring]


def _upstream(stall: dict, incoming: dict[str, list[dict]]) -> list[dict]:
    """Edges that feed this stall, ordered from the approach toward the stall."""
    sign = 1 if _along_delta(stall) >= 0 else -1
    chain: list[dict] = []
    seen = {stall["id"]}
    node = stall["from"]
    for _ in range(60):
        candidates = []
        for edge in incoming.get(node, []):
            if edge["id"] in seen or not edge["vehicle"] or edge["status"] != "operational":
                continue
            progress = _along_delta(edge) * sign
            if progress < 8:
                continue
            same = edge["highway"] == stall["highway"]
            candidates.append((progress + (400 if same else 0), edge))
        if not candidates:
            break
        chosen = max(candidates, key=lambda item: item[0])[1]
        chain.append(chosen)
        seen.add(chosen["id"])
        node = chosen["from"]
    chain.reverse()
    return chain


def build_operations() -> dict:
    graph = _load(GRAPH_PATH)
    edges = [edge for edge in graph["edges"] if edge["vehicle"] and edge["status"] == "operational"]
    outgoing: dict[str, list[dict]] = {}
    incoming: dict[str, list[dict]] = {}
    for edge in edges:
        outgoing.setdefault(edge["from"], []).append(edge)
        incoming.setdefault(edge["to"], []).append(edge)

    buildings = _building_features()

    def booth_record(way_id: int, flow: str, canopy_id: int, number: int) -> dict:
        matches = [edge for edge in edges if edge["osm_way_id"] == way_id]
        matches.sort(key=lambda edge: abs(edge["length_m"] - 20))
        stall = matches[0]
        approach = _upstream(stall, incoming)
        forward_chain = [edge for edge in _walk(stall, outgoing, True) if edge["id"] != stall["id"]]
        chain = approach + [stall] + forward_chain
        line, local = _chain_line(chain)
        stop_m = sum(edge["length_m"] for edge in approach) + stall["length_m"] / 2
        lon, lat = _midpoint(stall)
        title = "Arrival lane" if flow == "arrival" else "Departure lane"
        return {
            "id": f"{flow}-{number}",
            "flow": flow,
            "name": f"{title} {number}",
            "name_ar": "مسار القدوم" if flow == "arrival" else "مسار المغادرة",
            "osm_way_id": way_id,
            "canopy_osm_id": canopy_id,
            "lon": lon,
            "lat": lat,
            "bearing": round(_bearing(stall["xy"]), 1),
            "stop_m": round(stop_m, 1),
            "path_m": round(sum(edge["length_m"] for edge in chain), 1),
            "path": [[round(point[0], 7), round(point[1], 7)] for point in line],
        }

    arrivals = [booth_record(way_id, "arrival", ARRIVAL_CANOPY, index) for index, way_id in enumerate(ARRIVAL_BOOTHS, start=1)]
    departures = [booth_record(way_id, "departure", DEPARTURE_CANOPY, index) for index, way_id in enumerate(DEPARTURE_BOOTHS, start=1)]

    def site(osm_id: int, role: str, name: str, name_ar: str) -> dict:
        feature = buildings[osm_id]
        ring = _polygon(feature)
        lon = sum(point[0] for point in ring) / len(ring)
        lat = sum(point[1] for point in ring) / len(ring)
        return {
            "id": role + "-" + str(osm_id),
            "role": role,
            "name": name,
            "name_ar": name_ar,
            "osm_id": osm_id,
            "lon": round(lon, 7),
            "lat": round(lat, 7),
            "polygon": ring,
        }

    sites = [
        site(ARRIVAL_CANOPY, "arrival_canopy", "Arrival inspection canopy", "مظلة تفتيش القدوم"),
        site(DEPARTURE_CANOPY, "departure_canopy", "Departure inspection canopy", "مظلة تفتيش المغادرة"),
        site(DEPARTURE_HALL_CANOPY, "customs_canopy", "Customs canopy over the departure carriageways", "مظلة الجمارك"),
        *(site(osm_id, "truck_platform", "Truck inspection ramps", "رمبات التفتيش") for osm_id in TRUCK_PLATFORMS),
        *(site(osm_id, "scanner_hall", "Cargo x-ray scanning hall", "منطقة المسح بالأشعة") for osm_id in SCANNER_BUILDINGS),
    ]

    scanners = []
    for index, way_id in enumerate(SCANNER_ROADS, start=1):
        road_edges = [edge for edge in edges if edge["osm_way_id"] == way_id]
        if not road_edges:
            continue
        road = max(road_edges, key=lambda edge: edge["length_m"])
        chain = [edge for edge in _walk(road, outgoing, True) if edge["id"] != road["id"]]
        back = _upstream(road, incoming)
        full = back + [road] + chain
        line, _local = _chain_line(full)
        stop_m = sum(edge["length_m"] for edge in back) + road["length_m"] * 0.55
        lon = sum(point[0] for point in road["coordinates"]) / len(road["coordinates"])
        lat = sum(point[1] for point in road["coordinates"]) / len(road["coordinates"])
        scanners.append(
            {
                "id": f"xray-{index}",
                "name": f"Cargo x-ray {index}",
                "name_ar": f"جهاز الأشعة {index}",
                "osm_way_id": way_id,
                "building_osm_id": SCANNER_BUILDINGS[index - 1],
                "lon": round(lon, 7),
                "lat": round(lat, 7),
                "bearing": round(_bearing(road["xy"]), 1),
                "stop_m": round(stop_m, 1),
                "path_m": round(sum(edge["length_m"] for edge in full), 1),
                "path": [[round(point[0], 7), round(point[1], 7)] for point in line],
            }
        )

    platform_lanes = []
    for index, way_id in enumerate(PLATFORM_LANES, start=1):
        road_edges = [edge for edge in edges if edge["osm_way_id"] == way_id]
        if not road_edges:
            continue
        road = max(road_edges, key=lambda edge: edge["length_m"])
        chain = _walk(road, outgoing, True)
        line, _local = _chain_line(chain)
        platform_lanes.append(
            {
                "id": f"platform-lane-{index}",
                "name": f"Truck inspection lane {index}",
                "osm_way_id": way_id,
                "building_osm_id": TRUCK_PLATFORMS[index - 1],
                "bearing": round(_bearing(road["xy"]), 1),
                "stop_m": round(sum(edge["length_m"] for edge in chain) * 0.45, 1),
                "path_m": round(sum(edge["length_m"] for edge in chain), 1),
                "path": [[round(point[0], 7), round(point[1], 7)] for point in line],
            }
        )

    aisles = []
    seen_ways = set()
    for edge in edges:
        if edge.get("service") != "parking_aisle" or not edge.get("inside_port"):
            continue
        if edge["osm_way_id"] in seen_ways:
            continue
        seen_ways.add(edge["osm_way_id"])
        same = [item for item in edges if item["osm_way_id"] == edge["osm_way_id"]]
        same.sort(key=lambda item: item["length_m"], reverse=True)
        chosen = same[0]
        mid_x = sum(point[0] for point in chosen["xy"]) / len(chosen["xy"])
        mid_y = sum(point[1] for point in chosen["xy"]) / len(chosen["xy"])
        aisles.append(
            {
                "osm_way_id": chosen["osm_way_id"],
                "length_m": chosen["length_m"],
                "mid_x": round(mid_x, 1),
                "mid_y": round(mid_y, 1),
                "bearing": round(_bearing(chosen["xy"]), 1),
                "path": [[round(point[0], 7), round(point[1], 7)] for point in chosen["coordinates"]],
            }
        )
    aisles.sort(key=lambda aisle: aisle["mid_x"])
    yards = []
    current = []
    for aisle in aisles:
        if current and aisle["mid_x"] - current[-1]["mid_x"] > 90:
            yards.append(current)
            current = []
        current.append(aisle)
    if current:
        yards.append(current)
    yard_records = []
    for index, group in enumerate(yards, start=1):
        lon = sum(aisle["path"][0][0] for aisle in group) / len(group)
        lat = sum(aisle["path"][0][1] for aisle in group) / len(group)
        yard_records.append(
            {
                "id": f"yard-{index}",
                "name": "Truck holding yard" if len(yards) == 1 else f"Truck holding yard {index}",
                "name_ar": "ساحة انتظار الشاحنات",
                "lon": round(lon, 7),
                "lat": round(lat, 7),
                "aisles": group,
            }
        )

    return {
        "site": "Abu Samra Border Post",
        "authority": "General Authority of Customs",
        "authority_ar": "الهيئة العامة للجمارك",
        "method": (
            "Booths are the mapped carriageways under the inspection roofs. "
            "The two cargo x-ray lanes pass the comb-shaped scanning halls beside the main parking. "
            "Truck inspection ramps are the three sheds in the compound east of the main parking. "
            "Vehicles follow those roads."
        ),
        "published_context": {
            "passenger_lanes_announced_2022": 24,
            "cargo_scanners_contracted": 2,
            "truck_only_lanes_announced": 3,
            "truck_yard_capacity_announced": 500,
            "mapped_arrival_carriageways": len(arrivals),
            "mapped_departure_carriageways": len(departures),
        },
        "arrivals": arrivals,
        "departures": departures,
        "scanners": scanners,
        "platform_lanes": platform_lanes,
        "sites": sites,
        "yards": yard_records,
    }


def main() -> None:
    operations = build_operations()
    OUT_PATH.write_text(json.dumps(operations, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT_PATH}")
    for group in ("arrivals", "departures", "scanners", "platform_lanes"):
        for item in operations[group]:
            print(f"  {item['id']:16} path {item['path_m']:7.0f} m  stop {item['stop_m']:7.0f} m  pts {len(item['path'])}")
    for yard in operations["yards"]:
        print(f"  {yard['id']:16} aisles {len(yard['aisles'])}")


if __name__ == "__main__":
    main()
