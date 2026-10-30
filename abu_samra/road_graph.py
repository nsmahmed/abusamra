"""Build a vehicle-and-path graph from linear highway ways.

Ways are split at intersections, gates, and traffic-control nodes. Lane counts
are copied only when OpenStreetMap tagged them. Parallel carriageways at the
port are often mapped as separate ways, so an untagged way is left without a
lane count instead of being assumed to be two lanes.
"""

from __future__ import annotations

from collections import defaultdict

from abu_samra.geo import (
    BBox,
    LocalOrigin,
    clip_linestring,
    line_hits_ring,
    local_xy,
    polyline_length_m,
    round_lonlat,
    round_xy,
)
from abu_samra.osm_model import oneway_mode, parse_lanes, road_status, vehicle_allowed, way_coords

TRAFFIC_NODE_HIGHWAYS = {
    "traffic_signals",
    "stop",
    "give_way",
    "crossing",
    "mini_roundabout",
    "motorway_junction",
    "toll_gantry",
}
GATE_BARRIERS = {"gate", "lift_gate", "toll_booth", "border_control", "block", "chain", "sally_port"}


def _is_split_node(node: dict | None, usage: int, endpoint: bool) -> bool:
    if endpoint or usage >= 2:
        return True
    tags = (node or {}).get("tags") or {}
    if tags.get("highway") in TRAFFIC_NODE_HIGHWAYS:
        return True
    if tags.get("barrier") in GATE_BARRIERS:
        return True
    if tags.get("traffic_calming") or tags.get("crossing"):
        return True
    return False


def build_road_graph(
    ways: dict[int, dict],
    nodes: dict[int, dict],
    origin: LocalOrigin,
    port_ring: list[tuple[float, float]] | None,
    aoi: BBox | None = None,
) -> dict:
    linear: list[tuple[dict, list[int], list[tuple[float, float]]]] = []
    for way in ways.values():
        tags = way.get("tags") or {}
        if "highway" not in tags or tags.get("area") == "yes":
            continue
        node_ids = way.get("nodes") or []
        coords = way_coords(way, nodes)
        if not coords or len(node_ids) != len(coords):
            continue
        if tags.get("highway") in {"services", "rest_area"} and coords[0] == coords[-1]:
            continue
        linear.append((way, node_ids, coords))

    usage: dict[int, int] = defaultdict(int)
    for _way, node_ids, _coords in linear:
        for node_id in set(node_ids):
            usage[node_id] += 1

    graph_nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def ensure_node(node_id: int) -> str:
        key = f"n{node_id}"
        if key in graph_nodes:
            return key
        node = nodes[node_id]
        x, y = local_xy(node["lat"], node["lon"], origin)
        graph_nodes[key] = {
            "id": key,
            "osm_id": node_id,
            "lon": round(node["lon"], 7),
            "lat": round(node["lat"], 7),
            "x": round(x, 3),
            "y": round(y, 3),
            "elevation_m": None,
        }
        return key

    def resolve_endpoint(point: tuple[float, float], chain_ids: list[int], chain_coords: list[tuple[float, float]]) -> str:
        lon, lat = point
        for node_id, coord in zip(chain_ids, chain_coords):
            if abs(coord[0] - lon) <= 1e-7 and abs(coord[1] - lat) <= 1e-7:
                return ensure_node(node_id)
        key = f"c{lon:.5f}_{lat:.5f}"
        if key not in graph_nodes:
            x, y = local_xy(lat, lon, origin)
            graph_nodes[key] = {
                "id": key,
                "osm_id": None,
                "lon": round(lon, 7),
                "lat": round(lat, 7),
                "x": round(x, 3),
                "y": round(y, 3),
                "elevation_m": None,
                "clipped": True,
            }
        return key

    for way, node_ids, coords in linear:
        tags = way.get("tags") or {}
        indexes = [
            index
            for index, node_id in enumerate(node_ids)
            if _is_split_node(nodes.get(node_id), usage[node_id], index == 0 or index == len(node_ids) - 1)
        ]
        if len(indexes) < 2:
            continue
        mode, oneway_inferred = oneway_mode(tags)
        lanes, lanes_tagged = parse_lanes(tags)
        directions = ["forward"] if mode == "forward" else ["reverse"] if mode == "reverse" else ["forward", "reverse"]
        part = 0
        for start, end in zip(indexes, indexes[1:]):
            if end <= start:
                continue
            chain_ids = node_ids[start : end + 1]
            chain_coords = coords[start : end + 1]
            pieces = clip_linestring(chain_coords, aoi) if aoi is not None else [chain_coords]
            for piece in pieces:
                if len(piece) < 2:
                    continue
                part += 1
                for direction in directions:
                    line = piece if direction == "forward" else list(reversed(piece))
                    length = polyline_length_m(line, origin)
                    if length < 0.05:
                        continue
                    from_id = resolve_endpoint(line[0], chain_ids, chain_coords)
                    to_id = resolve_endpoint(line[-1], chain_ids, chain_coords)
                    edges.append(
                        {
                            "id": f"w{way['id']}:{part}:{'f' if direction == 'forward' else 'r'}",
                            "osm_way_id": way["id"],
                            "from": from_id,
                            "to": to_id,
                            "length_m": round(length, 2),
                            "highway": tags.get("highway"),
                            "name": tags.get("name"),
                            "name_en": tags.get("name:en") or tags.get("name"),
                            "name_ar": tags.get("name:ar"),
                            "lanes": lanes,
                            "lanes_tagged": lanes_tagged,
                            "oneway": mode,
                            "oneway_inferred": oneway_inferred,
                            "vehicle": vehicle_allowed(tags),
                            "inside_port": bool(port_ring and line_hits_ring(line, port_ring)),
                            "status": road_status(tags),
                            "surface": tags.get("surface"),
                            "access": tags.get("access"),
                            "hgv": tags.get("hgv"),
                            "goods": tags.get("goods"),
                            "maxspeed": tags.get("maxspeed"),
                            "maxweight": tags.get("maxweight"),
                            "maxheight": tags.get("maxheight"),
                            "bridge": tags.get("bridge"),
                            "tunnel": tags.get("tunnel"),
                            "service": tags.get("service"),
                            "coordinates": [round_lonlat(lon, lat) for lon, lat in line],
                            "xy": [round_xy(*local_xy(lat, lon, origin)) for lon, lat in line],
                        }
                    )

    components = _component_count(graph_nodes, edges)
    vehicle_edges = [edge for edge in edges if edge["vehicle"] and edge["status"] == "operational"]
    centerline_m = 0.0
    inside_centerline_m = 0.0
    seen_centerlines: set[str] = set()
    for edge in edges:
        key = edge["id"].rsplit(":", 1)[0]
        if key in seen_centerlines:
            continue
        seen_centerlines.add(key)
        if edge["vehicle"] and edge["status"] == "operational":
            centerline_m += edge["length_m"]
            if edge["inside_port"]:
                inside_centerline_m += edge["length_m"]
    nodes_out = sorted(graph_nodes.values(), key=lambda node: node["id"])
    edges.sort(key=lambda edge: edge["id"])
    return {
        "frame": "local_enu_meters",
        "crs": "EPSG:32639",
        "axis": "x east, y north. Elevation is a separate up axis in elevation_m, not a Y-up scene.",
        "local_origin": origin.as_dict(),
        "lane_policy": (
            "lanes is null unless OpenStreetMap tagged lanes=. "
            "Do not assume 2 lanes per way; parallel ways may already be separate carriageways."
        ),
        "clipped_to_study_area": aoi is not None,
        "nodes": nodes_out,
        "edges": edges,
        "stats": {
            "nodes": len(nodes_out),
            "directed_edges": len(edges),
            "vehicle_operational_directed_edges": len(vehicle_edges),
            "vehicle_centerline_m": round(centerline_m, 1),
            "inside_port_centerline_m": round(inside_centerline_m, 1),
            "components": components,
            "lanes_tagged_directed_edges": sum(1 for edge in edges if edge["lanes_tagged"]),
        },
    }


def _component_count(graph_nodes: dict[str, dict], edges: list[dict]) -> int:
    neighbors: dict[str, set[str]] = {node_id: set() for node_id in graph_nodes}
    for edge in edges:
        neighbors.setdefault(edge["from"], set()).add(edge["to"])
        neighbors.setdefault(edge["to"], set()).add(edge["from"])
    seen: set[str] = set()
    components = 0
    for node_id in neighbors:
        if node_id in seen:
            continue
        components += 1
        stack = [node_id]
        seen.add(node_id)
        while stack:
            current = stack.pop()
            for nxt in neighbors.get(current, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
    return components


def apply_elevations(graph: dict, sample) -> None:
    for node in graph["nodes"]:
        node["elevation_m"] = sample(node["lat"], node["lon"])
