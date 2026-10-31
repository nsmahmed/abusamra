"""Bake the 3D digital-twin scene for Abu Samra into one file of local meters.

The scene is a replica built from the dataset, not a photograph: road ribbons
from the road graph, yards from the mapped parking aisles, canopies and halls
from the building footprints, and truck journeys routed over the real road
network. Customs stations that are not mapped as objects (radiation portals,
appointment gates, release gate) are placed on those routes following the
published truck process for the port.

Frame: x east, y north, meters, same origin as data/processed/local.
"""

from __future__ import annotations

import heapq
import json
import math
from pathlib import Path

from abu_samra.geo import LocalOrigin, local_xy, point_in_ring

ROOT = Path(__file__).resolve().parents[1]
PROCESSED = ROOT / "data" / "processed"
LOCAL = PROCESSED / "local"
OUT_PATH = PROCESSED / "scene.json"
VEGETATION_PATH = PROCESSED / "vegetation.json"

SW_ENTRY = "c50.81948_24.72534"
SW_EXIT = "c50.81948_24.72575"
NE_ENTRY = "c50.86543_24.77268"
NE_EXIT = "c50.86578_24.77268"

ARRIVAL_CANOPY = 295856215
DEPARTURE_CANOPY = 295856213
CUSTOMS_CANOPY = 295856183
TRUCK_PLATFORMS = (1485001841, 1485001842)
SCANNER_HALL = 1485001846
SCANNER_ROADS = (1202482927, 1202482922)
# Service road leaving the roundabout toward the main parking; every inbound truck takes it,
# and the radiation portals and appointment gates stand along it.
INBOUND_APPROACH = 1168194979
PLATFORM_LANES = (1409965497, 1328553508)

MAJOR = {"motorway", "trunk", "primary", "secondary"}
LANE_W = 3.6


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _r(value: float) -> float:
    return round(value, 1)


def _xy(points) -> list[list[float]]:
    return [[_r(p[0]), _r(p[1])] for p in points]


def _length(points) -> float:
    return sum(math.dist(points[i - 1], points[i]) for i in range(1, len(points)))


def _resample(points, step: float) -> list[tuple[float, float]]:
    if len(points) < 2:
        return list(points)
    out = [tuple(points[0])]
    carry = 0.0
    for i in range(1, len(points)):
        ax, ay = points[i - 1]
        bx, by = points[i]
        seg = math.hypot(bx - ax, by - ay)
        if seg < 1e-6:
            continue
        d = step - carry
        while d <= seg:
            t = d / seg
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
            d += step
        carry = seg - (d - step)
    if math.dist(out[-1], points[-1]) > 0.5:
        out.append(tuple(points[-1]))
    return out


def _smooth(points, passes: int = 2) -> list[tuple[float, float]]:
    pts = list(points)
    for _ in range(passes):
        if len(pts) < 5:
            break
        nxt = [pts[0], pts[1]]
        for i in range(2, len(pts) - 2):
            nxt.append(
                (
                    sum(p[0] for p in pts[i - 2 : i + 3]) / 5,
                    sum(p[1] for p in pts[i - 2 : i + 3]) / 5,
                )
            )
        nxt.extend(pts[-2:])
        pts = nxt
    return pts


def _offset(points, distance: float) -> list[tuple[float, float]]:
    """Shift a polyline to its right by distance meters."""
    if len(points) < 2 or abs(distance) < 1e-6:
        return [tuple(p) for p in points]
    out = []
    for i, (x, y) in enumerate(points):
        a = points[max(0, i - 1)]
        b = points[min(len(points) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1.0
        out.append((x + dy / n * distance, y - dx / n * distance))
    return out


def _heading(a, b) -> float:
    return math.atan2(b[0] - a[0], b[1] - a[1])


def _ring(feature: dict) -> list[list[float]]:
    geometry = feature["geometry"]
    if geometry["type"] == "Polygon":
        return geometry["coordinates"][0]
    return geometry["coordinates"][0][0]


def _centroid(ring) -> tuple[float, float]:
    pts = ring[:-1] if ring[0] == ring[-1] else ring
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def _road_width(edge: dict) -> float:
    highway = edge["highway"]
    oneway = edge["oneway"] != "both"
    if edge.get("lanes_tagged") and edge.get("lanes"):
        return max(3.2, float(edge["lanes"]) * LANE_W)
    if edge.get("service") == "parking_aisle":
        return 6.5
    defaults = {
        "motorway": (11.0, 22.0),
        "motorway_link": (5.0, 8.0),
        "trunk": (7.2, 14.0),
        "trunk_link": (5.0, 8.0),
        "primary": (7.2, 13.0),
        "secondary": (7.2, 11.0),
        "secondary_link": (5.0, 7.5),
        "tertiary": (6.5, 8.5),
        "residential": (6.0, 7.0),
        "unclassified": (6.0, 7.0),
        "service": (4.8, 6.5),
        "track": (4.0, 4.0),
        "construction": (6.0, 7.0),
    }
    one, two = defaults.get(highway, (5.0, 6.5))
    return one if oneway else two


def _road_class(edge: dict) -> str:
    highway = edge["highway"]
    if highway in ("track", "construction"):
        return "dirt"
    if highway in ("motorway", "motorway_link"):
        return "motorway"
    if highway in ("trunk", "trunk_link", "primary", "secondary", "secondary_link"):
        return "major"
    if edge.get("service") == "parking_aisle":
        return "aisle"
    return "minor"


class Graph:
    def __init__(self, graph: dict):
        self.nodes = {node["id"]: node for node in graph["nodes"]}
        self.edges = [e for e in graph["edges"] if e["vehicle"] and e["status"] == "operational"]
        self.out: dict[str, list[dict]] = {}
        for edge in self.edges:
            self.out.setdefault(edge["from"], []).append(edge)
        self.by_way: dict[int, list[dict]] = {}
        for edge in self.edges:
            self.by_way.setdefault(edge["osm_way_id"], []).append(edge)

    def way_chain(self, way_id: int) -> list[dict]:
        """Edges of one way in drawing order, in the allowed direction."""
        edges = self.by_way.get(way_id, [])
        forward = [e for e in edges if e["id"].endswith(":f")]
        chosen = forward or edges
        chosen.sort(key=lambda e: int(e["id"].split(":")[1]))
        return chosen

    def route(self, source: str, targets: set[str]) -> list[dict] | None:
        dist = {source: 0.0}
        prev: dict[str, dict] = {}
        queue = [(0.0, source)]
        while queue:
            d, node = heapq.heappop(queue)
            if d > dist.get(node, math.inf):
                continue
            if node in targets:
                path = []
                while node in prev:
                    edge = prev[node]
                    path.append(edge)
                    node = edge["from"]
                return path[::-1]
            for edge in self.out.get(node, []):
                # Parked trucks fill the aisles, so through traffic keeps to the service roads.
                factor = 0.8 if edge["highway"] in MAJOR else 30.0 if edge.get("service") == "parking_aisle" else 1.0
                cost = edge["length_m"] * factor
                nd = d + cost
                if nd < dist.get(edge["to"], math.inf):
                    dist[edge["to"]] = nd
                    prev[edge["to"]] = edge
                    heapq.heappush(queue, (nd, edge["to"]))
        return None

    def journey(self, start: str, ways: list[int], end: str) -> list[dict] | None:
        """Start node, then drive the full length of each way in order, then the end node."""
        edges: list[dict] = []
        node = start
        for way_id in ways:
            chain = self.way_chain(way_id)
            if not chain:
                return None
            leg = self.route(node, {chain[0]["from"]}) if node != chain[0]["from"] else []
            if leg is None:
                return None
            edges += leg + chain
            node = chain[-1]["to"]
        leg = self.route(node, {end})
        if leg is None:
            return None
        return edges + leg


def _edge_line(edge: dict) -> list[tuple[float, float]]:
    pts = [tuple(p) for p in edge["xy"]]
    if edge["oneway"] == "both":
        width = _road_width(edge)
        pts = _offset(pts, min(LANE_W * 0.55, width / 4))
    return pts


def _journey_path(edges: list[dict]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for edge in edges:
        line = _edge_line(edge)
        if pts and math.dist(pts[-1], line[0]) < 0.05:
            line = line[1:]
        pts.extend(line)
    return _smooth(_resample(pts, 3.0), passes=3)


def _speeds(edges: list[dict], path) -> list[int]:
    """Speed class for each path point: 2 major road, 1 service, 0 yard aisle."""
    marks = []
    for edge in edges:
        cls = 2 if edge["highway"] in MAJOR or edge["highway"] == "motorway" else 0 if edge.get("service") == "parking_aisle" else 1
        marks.append((edge["xy"][len(edge["xy"]) // 2], cls))
    out = []
    j = 0
    for p in path:
        while j + 1 < len(marks) and math.dist(p, marks[j + 1][0]) < math.dist(p, marks[j][0]):
            j += 1
        out.append(marks[j][1])
    return out


def _cum(path) -> list[float]:
    cum = [0.0]
    for i in range(1, len(path)):
        cum.append(cum[-1] + math.dist(path[i - 1], path[i]))
    return cum


def _nearest_s(path, cum, point, after: float = 0.0) -> float:
    best, best_s = math.inf, after
    for i, p in enumerate(path):
        if cum[i] < after:
            continue
        d = math.dist(p, point)
        if d < best:
            best, best_s = d, cum[i]
    return best_s


def _point_at(path, cum, s: float) -> tuple[float, float, float]:
    s = max(0.0, min(cum[-1], s))
    i = 1
    while i < len(cum) - 1 and cum[i] < s:
        i += 1
    a, b = path[i - 1], path[i]
    span = cum[i] - cum[i - 1] or 1.0
    t = (s - cum[i - 1]) / span
    return a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, _heading(a, b)


def _turnoff_s(edges: list[dict], path, cum, from_end: bool) -> float:
    """Distance where the journey leaves (or rejoins) the main road for the port service roads."""
    sequence = list(enumerate(edges))
    if from_end:
        sequence = sequence[::-1]
    for _, edge in sequence:
        if edge["highway"] not in MAJOR:
            anchor = edge["xy"][-1] if from_end else edge["xy"][0]
            return _nearest_s(path, cum, anchor)
    return cum[-1] * (0.8 if from_end else 0.2)


def build_scene() -> dict:
    graph_raw = _load(PROCESSED / "road_graph.json")
    origin = LocalOrigin(**{k: graph_raw["local_origin"][k] for k in ("longitude", "latitude", "easting", "northing", "utm_zone", "epsg")})
    graph = Graph(graph_raw)
    ops = _load(PROCESSED / "operations.json")
    buildings_layer = _load(LOCAL / "buildings.json")
    natural = _load(LOCAL / "natural.json")
    port = _load(LOCAL / "port_footprint.json")
    aeroway = _load(LOCAL / "aeroway.json")
    manifest = _load(PROCESSED / "manifest.json")

    def ll(lon: float, lat: float) -> tuple[float, float]:
        return local_xy(lat, lon, origin)

    aoi = manifest["aoi"]
    sw = ll(aoi["west"], aoi["south"])
    ne = ll(aoi["east"], aoi["north"])
    bounds = {"min_x": _r(sw[0]), "min_y": _r(sw[1]), "max_x": _r(ne[0]), "max_y": _r(ne[1])}

    # --- roads: one ribbon per graph part, plus a disc at every junction ---
    roads = []
    seen_parts = set()
    node_width: dict[str, float] = {}
    node_degree: dict[str, int] = {}
    for edge in graph.edges:
        part = edge["id"].rsplit(":", 1)[0]
        if part in seen_parts or edge["highway"] in ("footway", "path", "proposed"):
            continue
        seen_parts.add(part)
        width = _road_width(edge)
        cls = _road_class(edge)
        for end in (edge["from"], edge["to"]):
            node_degree[end] = node_degree.get(end, 0) + 1
            if cls != "dirt":
                node_width[end] = max(node_width.get(end, 0), width)
        roads.append(
            {
                "c": cls,
                "w": _r(width),
                "o": 1 if edge["oneway"] != "both" else 0,
                "l": int(edge["lanes"]) if edge.get("lanes_tagged") and edge.get("lanes") else 0,
                "a": edge["from"],
                "b": edge["to"],
                "p": _xy(edge["xy"]),
            }
        )
    for road in roads:
        road["ja"] = 1 if node_degree.get(road.pop("a"), 0) > 1 else 0
        road["jb"] = 1 if node_degree.get(road.pop("b"), 0) > 1 else 0
    joints = []
    for node_id, width in node_width.items():
        if node_degree.get(node_id, 0) < 2:
            continue
        node = graph.nodes[node_id]
        joints.append([_r(node["x"]), _r(node["y"]), _r(width / 2)])

    # --- buildings with height classes ---
    platform_ids = set(TRUCK_PLATFORMS)
    buildings = []
    canopies = []
    by_id = {}
    for feature in buildings_layer["features"]:
        props = feature["properties"]
        osm_id = int(props["osm_id"])
        ring = _ring(feature)
        by_id[osm_id] = ring
        area = props.get("area_m2") or 0
        if osm_id in (ARRIVAL_CANOPY, DEPARTURE_CANOPY, CUSTOMS_CANOPY) or props.get("building") == "roof":
            role = {ARRIVAL_CANOPY: "arrival", DEPARTURE_CANOPY: "departure", CUSTOMS_CANOPY: "customs"}.get(osm_id, "canopy")
            canopies.append({"id": osm_id, "role": role, "h": 7.5, "ring": _xy(ring)})
            continue
        if osm_id in platform_ids:
            canopies.append({"id": osm_id, "role": "platform", "h": 6.5, "ring": _xy(ring)})
            continue
        if osm_id == SCANNER_HALL:
            buildings.append({"id": osm_id, "role": "scanner_hall", "h": 9.0, "ring": _xy(ring)})
            continue
        height = 12.0 if area > 2500 else 8.5 if area > 1000 else 6.0 if area > 300 else 4.2
        role = "terminal" if props.get("inside_port") and area > 1000 else "block"
        buildings.append({"id": osm_id, "role": role, "h": height, "ring": _xy(ring)})

    # --- yards: truck parking lanes, pads, and bays ---
    yards = []
    for yard in ops["yards"]:
        lanes = []
        for aisle in yard["aisles"]:
            pts = [ll(p[0], p[1]) for p in aisle["path"]]
            if _length(pts) < 40:
                continue
            lanes.append({"way": aisle["osm_way_id"], "p": _xy(pts)})
        if not lanes:
            continue
        yards.append({"id": yard["id"], "name": yard["name"], "pads": _yard_pads(lanes), "lanes": lanes})
    yards.extend(_overflow_lots(roads, yards))

    # --- passenger booth lanes (cars and buses) ---
    car_routes = []
    booths = []
    for group, canopy in (("arrivals", ARRIVAL_CANOPY), ("departures", DEPARTURE_CANOPY)):
        for item in ops[group]:
            pts = _smooth(_resample([ll(p[0], p[1]) for p in item["path"]], 3.0), passes=2)
            cum = _cum(pts)
            stop_xy = ll(item["lon"], item["lat"])
            stop_s = _nearest_s(pts, cum, stop_xy)
            x, y, heading = _point_at(pts, cum, stop_s)
            booths.append({"x": _r(x), "y": _r(y), "h": round(heading, 3), "lane": item["id"], "side": -1})
            car_routes.append(
                {
                    "id": item["id"],
                    "kind": "car",
                    "flow": "arrival" if group == "arrivals" else "departure",
                    "name": item["name"],
                    "p": _xy(pts),
                    "v": [2] * len(pts),
                    "stops": [{"s": _r(stop_s), "kind": "booth", "ref": item["id"]}],
                }
            )

    # --- truck journeys over the road graph ---
    yard_ways = {yard["id"]: [lane["way"] for lane in yard["lanes"]] for yard in yards}

    def pick(ways: list[int], count: int) -> list[int]:
        if len(ways) <= count:
            return ways
        step = len(ways) / count
        return [ways[int(i * step + step / 2)] for i in range(count)]

    truck_routes = []
    inbound_specs = []
    for yard_id, count in (("yard-1", 5), ("yard-2", 4), ("yard-3", 2)):
        for i, aisle in enumerate(pick(yard_ways.get(yard_id, []), count)):
            scanner = SCANNER_ROADS[(i + len(inbound_specs)) % 2]
            ramp = PLATFORM_LANES[i % 2] if (i + len(inbound_specs)) % 3 != 2 else None
            inbound_specs.append((aisle, scanner, ramp))
    outbound_specs = []
    for yard_id, count in (("yard-3", 3), ("yard-2", 3)):
        for i, aisle in enumerate(pick(yard_ways.get(yard_id, [])[::-1], count)):
            outbound_specs.append((aisle, None, PLATFORM_LANES[i % 2]))

    def plan(flow: str, start: str, end: str, specs) -> list[dict]:
        made = []
        for index, (aisle, scanner, ramp) in enumerate(specs):
            ways = ([INBOUND_APPROACH] if flow == "inbound" else []) + [aisle] + ([scanner] if scanner else []) + ([ramp] if ramp else [])
            edges = graph.journey(start, ways, end)
            if not edges:
                continue
            path = _journey_path(edges)
            cum = _cum(path)
            stops = []
            aisle_chain = graph.way_chain(aisle)
            aisle_pts = [p for e in aisle_chain for p in e["xy"]]
            mid = aisle_pts[len(aisle_pts) // 2]
            s_yard = _nearest_s(path, cum, mid)
            stops.append({"s": _r(s_yard), "kind": "yard", "ref": aisle})
            after = s_yard + 20
            if scanner:
                sc = next(item for item in ops["scanners"] if item["osm_way_id"] == scanner)
                s = _nearest_s(path, cum, ll(sc["lon"], sc["lat"]), after)
                stops.append({"s": _r(s), "kind": "xray", "ref": sc["id"]})
                after = s + 20
            if ramp:
                chain = graph.way_chain(ramp)
                pts = [p for e in chain for p in e["xy"]]
                platform = TRUCK_PLATFORMS[PLATFORM_LANES.index(ramp)]
                target = _centroid(by_id[platform])
                best = min(pts, key=lambda p: math.dist(p, target))
                s = _nearest_s(path, cum, best, after)
                stops.append({"s": _r(s), "kind": "ramp", "ref": f"ramp-{PLATFORM_LANES.index(ramp) + 1}"})
            made.append({"edges": edges, "path": path, "cum": cum, "stops": stops, "flow": flow, "index": index})
        return made

    inbound = plan("inbound", SW_ENTRY, NE_EXIT, inbound_specs)
    outbound = plan("outbound", NE_ENTRY, SW_EXIT, outbound_specs)

    stations = []
    portals = []
    gates = []

    def common_prefix(group: list[dict]) -> list[dict]:
        prefix = list(group[0]["edges"])
        for other in group[1:]:
            n = 0
            while n < min(len(prefix), len(other["edges"])) and prefix[n]["id"] == other["edges"][n]["id"]:
                n += 1
            prefix = prefix[:n]
        return prefix

    def common_suffix(group: list[dict]) -> list[dict]:
        reversed_group = [{"edges": g["edges"][::-1]} for g in group]
        return common_prefix(reversed_group)[::-1]

    def place(route: dict, s: float, kind: str, ref: str, extra: dict | None = None) -> dict:
        x, y, heading = _point_at(route["path"], route["cum"], s)
        record = {"x": _r(x), "y": _r(y), "h": round(heading, 3), "kind": kind, "ref": ref}
        if extra:
            record.update(extra)
        return record

    for flow, group in (("inbound", inbound), ("outbound", outbound)):
        if not group:
            continue
        lead = group[0]
        prefix = common_prefix(group)
        prefix_len = _length(_journey_path(prefix)) if prefix else 0.0
        turn = _turnoff_s(prefix or lead["edges"], lead["path"], lead["cum"], from_end=False)
        first_stop = min(stop["s"] for stop in lead["stops"])
        limit = min(prefix_len - 15, first_stop - 60) if prefix else first_stop - 60
        if flow == "inbound":
            approach = graph.way_chain(INBOUND_APPROACH)[0]["xy"][0]
            turn = _nearest_s(lead["path"], lead["cum"], approach)
            s_portal = min(turn + 50, limit - 90)
            s_gate = min(turn + 230, limit)
        else:
            s_portal = min(turn + 40, limit - 90)
            s_gate = min(turn + 130, limit)
        suffix = common_suffix(group)
        last_stop = max(stop["s"] for stop in lead["stops"])
        if suffix:
            suffix_start = lead["cum"][-1] - _length(_journey_path(suffix))
            rejoin = _turnoff_s(suffix, lead["path"], lead["cum"], from_end=True)
            s_release = max(min(rejoin - 45, lead["cum"][-1] - 200), suffix_start + 10, last_stop + 60)
        else:
            s_release = last_stop + 120

        portal_ref = f"{flow}-portal"
        gate_ref = f"{flow}-gate"
        release_ref = f"{flow}-release"
        if flow == "inbound":
            portals.append(place(lead, s_portal, "portal", portal_ref))
        gates.append(place(lead, s_gate, "gate", gate_ref, {"lanes": 3 if flow == "inbound" else 2}))
        gates.append(place(lead, s_release, "release", release_ref, {"lanes": 2}))
        anchors = {portal_ref: s_portal, gate_ref: s_gate, release_ref: s_release}

        for route in group:
            stops = list(route["stops"])
            for ref, s_lead in anchors.items():
                if ref == portal_ref and flow != "inbound":
                    continue
                x, y, _ = _point_at(lead["path"], lead["cum"], s_lead)
                lo = 0.0 if ref != release_ref else max(stop["s"] for stop in route["stops"])
                s = _nearest_s(route["path"], route["cum"], (x, y), lo)
                kind = "portal" if ref == portal_ref else "gate"
                stops.append({"s": _r(s), "kind": kind, "ref": ref})
            stops.sort(key=lambda stop: stop["s"])
            truck_routes.append(
                {
                    "id": f"{flow}-{route['index'] + 1}",
                    "kind": "truck",
                    "flow": flow,
                    "name": "Inbound cargo from Saudi Arabia" if flow == "inbound" else "Outbound cargo to Saudi Arabia",
                    "p": _xy(route["path"]),
                    "v": _speeds(route["edges"], route["path"]),
                    "stops": stops,
                }
            )

    # --- x-ray gantries and inspection ramps ---
    xrays = []
    for item in ops["scanners"]:
        route = next((r for r in truck_routes if any(st["ref"] == item["id"] for st in r["stops"])), None)
        if not route:
            continue
        stop = next(st for st in route["stops"] if st["ref"] == item["id"])
        pts = route["p"]
        cum = _cum(pts)
        x, y, heading = _point_at(pts, cum, stop["s"])
        xrays.append({"id": item["id"], "x": _r(x), "y": _r(y), "h": round(heading, 3), "name": item["name"]})

    # --- stations from the published inbound and outbound truck process ---
    def anchor(kind: str, ref: str):
        for collection in (portals, gates):
            for item in collection:
                if item["ref"] == ref:
                    return item["x"], item["y"]
        return None

    def route_point(flow: str, frac: float):
        route = next(r for r in truck_routes if r["flow"] == flow)
        pts = route["p"]
        cum = _cum(pts)
        x, y, _ = _point_at(pts, cum, cum[-1] * frac)
        return x, y

    def yard_center(yard_id: str):
        yard = next(y for y in yards if y["id"] == yard_id)
        pad = max(yard["pads"], key=lambda r: abs(_shoelace(r)))
        return _centroid(pad + [pad[0]])

    ramp_center = _centroid([p for pid in TRUCK_PLATFORMS for p in by_id[pid]])
    xray_center = (sum(x["x"] for x in xrays) / max(1, len(xrays)), sum(x["y"] for x in xrays) / max(1, len(xrays)))
    if inbound:
        lead = next(r for r in truck_routes if r["flow"] == "inbound")
        first = next(st for st in lead["stops"] if st["kind"] == "portal")
        x0, y0, _ = _point_at(lead["p"], _cum(lead["p"]), max(0, first["s"] - 450))
        stations += [
            {"n": 1, "flow": "inbound", "tone": "gold", "en": "Truck road from Saudi Arabia", "ar": "طريق الشاحنات القادمة من السعودية", "x": _r(x0), "y": _r(y0)},
            {"n": 2, "flow": "inbound", "tone": "maroon", "en": "Radiation detection portals", "ar": "بوابات كشف المواد المشعة", "x": anchor("portal", "inbound-portal")[0], "y": anchor("portal", "inbound-portal")[1]},
            {"n": 3, "flow": "inbound", "tone": "maroon", "en": "Appointment check gates (3)", "ar": "بوابات التحقق من الموعد", "x": anchor("gate", "inbound-gate")[0], "y": anchor("gate", "inbound-gate")[1]},
            {"n": 4, "flow": "inbound", "tone": "green", "en": "Main truck parking (~700)", "ar": "المواقف الرئيسية (حوالي 700 موقف)", "x": _r(yard_center("yard-1")[0]), "y": _r(yard_center("yard-1")[1])},
            {"n": 5, "flow": "inbound", "tone": "green", "en": "X-ray scanning area", "ar": "منطقة المسح بالأشعة", "x": _r(xray_center[0]), "y": _r(xray_center[1])},
            {"n": 6, "flow": "inbound", "tone": "green", "en": "Inspection ramps", "ar": "رمبات التفتيش", "x": _r(ramp_center[0]), "y": _r(ramp_center[1])},
            {"n": 7, "flow": "inbound", "tone": "green", "en": "Release gate", "ar": "بوابة الإفراج", "x": anchor("gate", "inbound-release")[0], "y": anchor("gate", "inbound-release")[1]},
        ]
    if outbound:
        lead = next(r for r in truck_routes if r["flow"] == "outbound")
        gate = next(st for st in lead["stops"] if st["ref"] == "outbound-gate")
        x0, y0, _ = _point_at(lead["p"], _cum(lead["p"]), max(0, gate["s"] - 450))
        stations += [
            {"n": 1, "flow": "outbound", "tone": "gold", "en": "Truck road from Doha", "ar": "طريق الشاحنات القادمة من الدوحة", "x": _r(x0), "y": _r(y0)},
            {"n": 4, "flow": "outbound", "tone": "green", "en": "Outbound zone entrance (2 gates)", "ar": "مدخل منطقة الصادر التشغيلية", "x": anchor("gate", "outbound-gate")[0], "y": anchor("gate", "outbound-gate")[1]},
            {"n": 5, "flow": "outbound", "tone": "green", "en": "Outbound truck parking", "ar": "مواقف الصادر", "x": _r(yard_center("yard-3")[0]), "y": _r(yard_center("yard-3")[1])},
            {"n": 6, "flow": "outbound", "tone": "green", "en": "Inspection ramps", "ar": "رمبات التفتيش", "x": _r(ramp_center[0]) + 15, "y": _r(ramp_center[1]) - 15},
            {"n": 7, "flow": "outbound", "tone": "green", "en": "Release gate", "ar": "بوابة الإفراج", "x": anchor("gate", "outbound-release")[0], "y": anchor("gate", "outbound-release")[1]},
        ]
    arrival_canopy = _centroid(by_id[ARRIVAL_CANOPY])
    departure_canopy = _centroid(by_id[DEPARTURE_CANOPY])
    customs_canopy = _centroid(by_id[CUSTOMS_CANOPY])
    stations += [
        {"n": "P", "flow": "passenger", "tone": "teal", "en": "Passenger arrival booths", "ar": "أكشاك القدوم", "x": _r(arrival_canopy[0]), "y": _r(arrival_canopy[1])},
        {"n": "P", "flow": "passenger", "tone": "teal", "en": "Passenger departure booths", "ar": "أكشاك المغادرة", "x": _r(departure_canopy[0]), "y": _r(departure_canopy[1])},
        {"n": "C", "flow": "passenger", "tone": "teal", "en": "Customs hall canopy", "ar": "مظلة الجمارك", "x": _r(customs_canopy[0]), "y": _r(customs_canopy[1])},
    ]

    # --- ground ---
    coast = [f for f in natural["features"] if f["properties"].get("natural") == "coastline"]
    chain = _chain_lines([f["geometry"]["coordinates"] for f in coast])
    sea = None
    if chain:
        nw = (bounds["min_x"] - 4000, bounds["max_y"] + 4000)
        start, end = chain[0], chain[-1]
        sea = _xy(chain + [(end[0] - 4000, end[1]), nw, (start[0], start[1] + 4000)])
    flats = [
        _xy(_ring(f))
        for f in natural["features"]
        if f["properties"].get("natural") in ("mud", "beach") and f["geometry"]["type"] in ("Polygon", "MultiPolygon")
    ]
    port_ring = _xy(_ring(port["features"][0] if "features" in port else port))
    helipad = [_xy(_ring(f)) for f in aeroway["features"] if f["geometry"]["type"] in ("Polygon", "MultiPolygon")]

    # --- street lights along the main carriageways near the port ---
    lights = []
    for road in roads:
        if road["c"] not in ("major", "motorway"):
            continue
        pts = road["p"]
        if not any(abs(p[0]) < 1700 and abs(p[1]) < 1500 for p in pts):
            continue
        side = road["w"] / 2 + 1.2
        line = _resample(_offset(pts, side), 42.0)
        for i in range(1, len(line) - 1):
            p = line[i]
            if abs(p[0]) < 1800 and abs(p[1]) < 1600:
                lights.append([_r(p[0]), _r(p[1]), round(_heading(line[i - 1], line[i + 1]), 3)])

    # --- declutter: only the carriageways and the port itself, not the surrounding settlement ---
    port_edges = list(zip(port_ring, port_ring[1:] + port_ring[:1]))

    def near_port(points, buffer: float = 120.0) -> bool:
        for p in points[:: max(1, len(points) // 12)] + [points[-1]]:
            if point_in_ring(p[0], p[1], port_ring):
                return True
            if any(_segment_distance(p, a, b) < buffer for a, b in port_edges):
                return True
        return False

    travelled = {
        (round(x / 8), round(y / 8))
        for route in car_routes + truck_routes
        for x, y in _resample(route["p"], 4.0)
    }

    def on_route(points) -> bool:
        line = _resample(points, 6.0)
        hits = sum(
            1
            for x, y in line
            if any((round(x / 8) + i, round(y / 8) + j) in travelled for i in (-1, 0, 1) for j in (-1, 0, 1))
        )
        return hits >= 0.6 * len(line)

    roads = [road for road in roads if road["c"] in ("major", "motorway") or near_port(road["p"]) or on_route(road["p"])]
    ends = {(round(road["p"][k][0]), round(road["p"][k][1])) for road in roads for k in (0, -1)}
    joints = [j for j in joints if (round(j[0]), round(j[1])) in ends]
    buildings = [b for b in buildings if near_port(b["ring"], 60.0)]

    vegetation = _clear_trees(
        _load(VEGETATION_PATH)["palms"] if VEGETATION_PATH.exists() else [],
        roads,
        [b["ring"] for b in buildings + canopies] + [pad for y in yards for pad in y["pads"]],
    )

    return {
        "site": "Abu Samra Border Post",
        "authority": "General Authority of Customs",
        "authority_ar": "الهيئة العامة للجمارك",
        "frame": "x east, y north, meters; origin as data/processed/local",
        "bounds": bounds,
        "ground": {"port": port_ring, "sea": sea, "flats": flats, "helipad": helipad},
        "roads": roads,
        "joints": joints,
        "buildings": buildings,
        "canopies": canopies,
        "yards": yards,
        "booths": booths,
        "xrays": xrays,
        "portals": portals,
        "gates": gates,
        "stations": stations,
        "lights": lights,
        "palms": vegetation,
        "routes": car_routes + truck_routes,
        "published": ops.get("published_context", {}),
    }


def _shoelace(ring) -> float:
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1])) / 2


def _yard_pads(lanes: list[dict]) -> list[list[list[float]]]:
    """One paved rectangle per block of parallel aisles; cross aisles and strays get none."""
    angles = sorted(
        math.atan2(lane["p"][-1][0] - lane["p"][0][0], lane["p"][-1][1] - lane["p"][0][1]) % math.pi for lane in lanes
    )
    main = angles[len(angles) // 2]
    ux, uy = math.sin(main), math.cos(main)
    vx, vy = uy, -ux
    rows = []
    for lane in lanes:
        a = math.atan2(lane["p"][-1][0] - lane["p"][0][0], lane["p"][-1][1] - lane["p"][0][1]) % math.pi
        if min(abs(a - main), math.pi - abs(a - main)) > math.radians(15):
            continue
        along = [p[0] * ux + p[1] * uy for p in lane["p"]]
        across = sum(p[0] * vx + p[1] * vy for p in lane["p"]) / len(lane["p"])
        rows.append((across, min(along), max(along)))
    rows.sort()
    blocks: list[list[tuple]] = []
    for row in rows:
        last = blocks[-1][-1] if blocks else None
        if last and row[0] - last[0] < 14 and min(row[2], last[2]) - max(row[1], last[1]) > 40:
            blocks[-1].append(row)
        else:
            blocks.append([row])
    pads = []
    for block in blocks:
        if len(block) < 2:
            continue
        a0 = min(r[1] for r in block) - 10
        a1 = max(r[2] for r in block) + 10
        c0 = block[0][0] - 7
        c1 = block[-1][0] + 7
        pads.append([[_r(a * ux + c * vx), _r(a * uy + c * vy)] for a, c in ((a0, c0), (a1, c0), (a1, c1), (a0, c1))])
    return pads


def _overflow_lots(roads: list[dict], yards: list[dict]) -> list[dict]:
    """Mapped parking aisles outside the holding yards, grouped into paved lots."""
    known = [lane["p"][len(lane["p"]) // 2] for yard in yards for lane in yard["lanes"]]
    loose = []
    for road in roads:
        if road["c"] != "aisle" or _length(road["p"]) < 40:
            continue
        mid = road["p"][len(road["p"]) // 2]
        if any(math.hypot(mid[0] - k[0], mid[1] - k[1]) < 4 for k in known):
            continue
        loose.append({"p": road["p"], "m": mid})
    groups: list[list[dict]] = []
    for lane in loose:
        near = [g for g in groups if any(math.hypot(lane["m"][0] - o["m"][0], lane["m"][1] - o["m"][1]) < 40 for o in g)]
        merged = [lane] + [o for g in near for o in g]
        groups = [g for g in groups if g not in near] + [merged]
    lots = []
    for group in groups:
        pads = _yard_pads(group)
        if not pads:
            continue
        n = len(lots) + 1
        lanes = [{"way": f"lot-{n}-{i}", "p": lane["p"]} for i, lane in enumerate(group)]
        lots.append({"id": f"lot-{n}", "name": "Overflow truck parking", "extra": 1, "pads": pads, "lanes": lanes})
    return lots


def _segment_distance(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    span = dx * dx + dy * dy
    t = 0.0 if span == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / span))
    return math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t)


def _clear_trees(trees, roads, rings) -> list[list[float]]:
    """Keep detected trees that stand on open ground, not on a road, roof, or yard."""
    cell = 25.0
    grid: dict[tuple[int, int], list[tuple]] = {}
    for road in roads:
        if road["c"] == "dirt":
            continue
        pts = road["p"]
        for i in range(1, len(pts)):
            a, b = pts[i - 1], pts[i]
            reach = road["w"] / 2 + 1.5
            for gx in range(int(math.floor((min(a[0], b[0]) - reach) / cell)), int(math.floor((max(a[0], b[0]) + reach) / cell)) + 1):
                for gy in range(int(math.floor((min(a[1], b[1]) - reach) / cell)), int(math.floor((max(a[1], b[1]) + reach) / cell)) + 1):
                    grid.setdefault((gx, gy), []).append((a, b, reach))
    kept = []
    for tree in trees:
        key = (int(math.floor(tree[0] / cell)), int(math.floor(tree[1] / cell)))
        if any(_segment_distance(tree, a, b) < reach for a, b, reach in grid.get(key, [])):
            continue
        if any(point_in_ring(tree[0], tree[1], ring) for ring in rings):
            continue
        kept.append(tree)
    return kept


def _chain_lines(lines: list[list[list[float]]]) -> list[tuple[float, float]]:
    """Join coastline pieces that share endpoints into one ordered line."""
    remaining = [[tuple(p) for p in line] for line in lines if len(line) > 1]
    if not remaining:
        return []
    chain = remaining.pop(0)
    changed = True
    while remaining and changed:
        changed = False
        for i, line in enumerate(remaining):
            if math.dist(line[0], chain[-1]) < 1:
                chain += line[1:]
            elif math.dist(line[-1], chain[0]) < 1:
                chain = line[:-1] + chain
            else:
                continue
            remaining.pop(i)
            changed = True
            break
    return chain


def main() -> None:
    scene = build_scene()
    OUT_PATH.write_text(json.dumps(scene, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = OUT_PATH.stat().st_size / 1024
    print(f"wrote {OUT_PATH} ({size:.0f} KB)")
    for key in ("roads", "joints", "buildings", "canopies", "yards", "booths", "xrays", "portals", "gates", "stations", "lights", "palms", "routes"):
        print(f"  {key:10} {len(scene[key])}")
    for route in scene["routes"]:
        length = _length(route["p"])
        stops = ", ".join(f"{s['kind']}@{s['s']:.0f}" for s in route["stops"])
        print(f"  {route['id']:14} {length:7.0f} m  {stops}")


if __name__ == "__main__":
    main()
