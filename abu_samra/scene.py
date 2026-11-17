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
# Service road leaving the roundabout along the south-east edge of the unused lot; every inbound
# truck takes it, and the radiation portals and appointment gates stand along it. Its last edge
# turns back into the lot's roundabout, so trucks leave it one edge early for the main parking.
INBOUND_APPROACH = (1168194979, 7)

# The layout below follows the GAC import and export process maps (reference/img0*.jpeg)
# checked against satellite imagery of the site.
#
# Import: the comb-shaped halls between the main parking and Salwa Road are the x-ray
# scanning area (one scanner lane past each hall). The walled compound with two long sheds
# and one short shed east of the main parking holds the inspection ramps (~130 bays); the
# release gate sits on the compound's south-west exit.
XRAY_HALLS = (1485001841, 1485001842)
XRAY_LANES = (1409965497, 1328553508)
IMPORT_RAMP_SHEDS = (295856199, 295856216, 295856190)
# Lanes past the sheds: (way, edges to drive). Trucks circle the compound clockwise: up the
# north-west side, down past the sheds (between the long sheds, or the outer lane), back along the
# south-east side, and out through the release gate on the exit road, which curves away south.
# The second runs only the first two edges of its way so both lanes leave by that exit road.
RAMP_LANES = ((1457063892, None), (1457063896, 2))
RELEASE_EXIT = 1457063895
INBOUND_RELEASE_XY = (496.0, -2.0)
# After release, import trucks take the road under the ramps east, circle the civil defence
# compound and drive north to the roundabout by the helipad, where they join Salwa Road for Doha.
INBOUND_EXIT_VIA = ((1545.0, -229.0), (1571.0, -239.0), (1653.0, -125.0), (1609.0, -80.0), (1350.0, 241.0), (955.0, 929.0))
CIVIL_DEFENCE = ((1440.0, -420.0), (1720.0, -40.0))
# The large lot between the south-west roundabout and the main parking is unused today; the
# import map proposes part of it as external parking. Lots east of this line are main parking.
PARKING_DIVIDER = ((-140.0, -320.0), (-50.0, -400.0))
# Export (reference/img01-export.jpeg): trucks from Doha leave the north-east roundabout for the
# external export parking, the large lot north-west of it. They drive in at its south corner,
# round its far side, park on one of its aisles, and leave by its west corner, where the permit
# gate stands on the road. On the way back down they turn right onto the export zone's own road,
# which runs south-west between the external parking and the canopy lot and meets the export road
# just before the export parking. The two-lane entrance gates stand near its start. They park in
# the strip (~12 bays) in front of the export inspection shed, then leave through the release gate.
#
# OpenStreetMap does not map that road; it is drawn from the reference imagery
# (reference/data/map-imagery/additional/image-2.png) and added to the road graph here.
EXPORT_ZONE_ROAD = 9100000001
EXPORT_ZONE_ROAD_FROM = (257998156, 8, (757.0, 1190.0))  # (way, edge, point) where it leaves Bu Samra Road
EXPORT_ZONE_ROAD_TO = (145634746, 1, (367.0, 742.0))  # where it joins the export road
EXPORT_ZONE_ROAD_SHAPE = ((600.0, 1092.0), (430.0, 985.0), (392.0, 940.0), (374.0, 880.0), (368.0, 800.0))
EXPORT_GATE_AT = 70.0  # entrance gates, metres along that road from Bu Samra Road
EXPORT_LOT_IN = (1168202683, 4)
EXPORT_LOT_AISLES = (1168202679, 1168202681)
EXPORT_LOT_OUT = 1168202667
EXPORT_LOT_LANES = (1168202668, 1168202669, 1168202670, 1168202671, 1168202672, 1168202673, 1168202678, 1168202679, 1168202680, 1168202681)
OUTBOUND_PERMIT_XY = (521.0, 1512.0)
EXPORT_ROAD = 145634746
EXPORT_RAMP_SHEDS = (1485001858,)
OUTBOUND_RELEASE_XY = (52.0, 470.0)
# Brief on-screen names: (English, Arabic, capacity or lane note).
STATION_SHORT = {
    ("inbound", 1): ("Saudi road", "طريق السعودية", ""),
    ("inbound", 2): ("Radiation portals", "كشف الإشعاع", ""),
    ("inbound", 3): ("Appointment gates", "بوابات الموعد", "3 lanes"),
    ("inbound", "+"): ("Proposed parking", "مواقف مقترحة", "unused"),
    ("inbound", 4): ("Main parking", "المواقف الرئيسية", "~700"),
    ("inbound", 5): ("X-ray", "المسح بالأشعة", "2 lanes"),
    ("inbound", 6): ("Inspection ramps", "رمبات التفتيش", "~130"),
    ("inbound", 7): ("Release", "الإفراج", ""),
    ("outbound", 1): ("Doha road", "طريق الدوحة", ""),
    ("outbound", 2): ("External parking", "المواقف الخارجية", ""),
    ("outbound", 3): ("Permit gate", "مخرج المواقف", "1 lane"),
    ("outbound", 4): ("Entrance gates", "بوابات الدخول", "2 lanes"),
    ("outbound", 5): ("Export parking", "مواقف الصادر", "~12"),
    ("outbound", 6): ("Inspection ramps", "رمبات التفتيش", ""),
    ("outbound", 7): ("Release", "الإفراج", ""),
}
RAMP_PITCH = 4.6  # bay width along a dock face
TRUCK_REACH = 10.2  # bay centre from the dock face: dock apron plus half a 17 m truck

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

    def node_at(self, xy) -> str:
        """The drivable junction nearest a surveyed point; waypoints must sit on one."""
        best, best_d = None, math.inf
        for node_id in self.out:
            n = self.nodes[node_id]
            d = math.hypot(n["x"] - xy[0], n["y"] - xy[1])
            if d < best_d:
                best, best_d = node_id, d
        assert best_d < 6.0, f"no junction near {xy} (nearest {best_d:.1f} m)"
        return best

    def journey(self, start: str, ways: list, end: str) -> list[dict] | None:
        """Start node, then drive each way in order, then the end node.

        A way is an id (drive its full length), (id, n) to drive only its first n edges,
        {"via": (x, y)} to drive the shortest way to the junction at that point, or
        {"edge": id} to drive one graph edge, in either direction, from wherever it starts."""
        edges: list[dict] = []
        node = start
        for way in ways:
            if isinstance(way, dict) and "edge" in way:
                edge = next(e for e in self.edges if e["id"] == way["edge"])
                leg = self.route(node, {edge["from"]}) if node != edge["from"] else []
                if leg is None:
                    return None
                edges += leg + [edge]
                node = edge["to"]
                continue
            if isinstance(way, dict):
                target = self.node_at(way["via"])
                leg = self.route(node, {target}) if node != target else []
                if leg is None:
                    return None
                edges += leg
                node = target
                continue
            way_id, count = way if isinstance(way, tuple) else (way, None)
            chain = self.way_chain(way_id)[:count]
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


def build_scene() -> dict:
    graph_raw = _load(PROCESSED / "road_graph.json")
    origin = LocalOrigin(**{k: graph_raw["local_origin"][k] for k in ("longitude", "latitude", "easting", "northing", "utm_zone", "epsg")})
    graph = Graph(graph_raw)
    _add_export_zone_road(graph)
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
    ramp_sheds = {**{i: "inbound" for i in IMPORT_RAMP_SHEDS}, **{i: "outbound" for i in EXPORT_RAMP_SHEDS}}
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
        if osm_id in XRAY_HALLS:
            buildings.append({"id": osm_id, "role": "xray_hall", "h": 9.6, "ring": _xy(ring)})
            continue
        if osm_id in ramp_sheds:
            buildings.append({"id": osm_id, "role": "ramp_shed", "flow": ramp_sheds[osm_id], "h": 9.0, "ring": _xy(ring)})
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
    for yard in yards:
        yard["kind"] = _parking_kind(yard)
        yard["name"] = "Main truck parking" if yard["kind"] == "main" else "Unused lot (proposed external parking)"
        yard.pop("extra", None)
    infill = _main_infill(yards, roads)
    if infill:
        yards.append(infill)
    yards += _export_parking(graph, by_id[EXPORT_RAMP_SHEDS[0]])
    yards.append(_export_staging(graph))

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

    # --- inspection ramps: perpendicular dock bays along the long faces of each shed ---
    shed_rings = [by_id[i] for i in IMPORT_RAMP_SHEDS + EXPORT_RAMP_SHEDS]
    other_rings = [b["ring"] for b in buildings if b["role"] != "ramp_shed"]
    ramps = {}
    for flow, sheds, ramp_id in (("inbound", IMPORT_RAMP_SHEDS, "ramp-import"), ("outbound", EXPORT_RAMP_SHEDS, "ramp-export")):
        bays = []
        for shed in sheds:
            bays += _dock_bays(by_id[shed], roads, other_rings + [r for r in shed_rings if r is not by_id[shed]])
        ramps[flow] = {"id": ramp_id, "flow": flow, "sheds": list(sheds), "bays": bays}

    # --- truck journeys over the road graph ---
    yard_ways = {
        yard["id"]: [lane["way"] for lane in yard["lanes"] if isinstance(lane["way"], int)]
        for yard in yards
        if yard["kind"] == "main"
    }
    export_lane = next(y for y in yards if y["kind"] == "export")["lanes"][0]["p"]

    def pick(ways: list[int], count: int) -> list[int]:
        if len(ways) <= count:
            return ways
        step = len(ways) / count
        return [ways[int(i * step + step / 2)] for i in range(count)]

    def lane_mid(way_id: int, count: int | None = None) -> tuple[float, float]:
        pts = [p for e in graph.way_chain(way_id)[:count] for p in e["xy"]]
        return _point_at(pts, _cum(pts), _length(pts) / 2)[:2]

    # Aisles are one-way as mapped. Keep the ones a truck can reach from the approach road and
    # leave toward the x-ray lanes without looping the site (most exit on the north-west edge).
    approach_end = graph.way_chain(INBOUND_APPROACH[0])[INBOUND_APPROACH[1] - 1]["to"]
    xray_start = graph.way_chain(XRAY_LANES[0])[0]["from"]

    def detour(aisle: int) -> float:
        chain = graph.way_chain(aisle)
        legs = (graph.route(approach_end, {chain[0]["from"]}), graph.route(chain[-1]["to"], {xray_start}))
        return sum(_length(_journey_path(leg)) if leg else 0.0 if leg == [] else math.inf for leg in legs)

    usable = [a for ways in yard_ways.values() for a in ways if detour(a) < 1000]
    truck_routes = []
    inbound_specs = []
    via = lambda points: [{"via": p} for p in points]
    for ways in [usable]:
        for aisle in pick(ways, 6):
            n = len(inbound_specs)
            inbound_specs.append(
                {
                    "ways": [INBOUND_APPROACH, aisle, XRAY_LANES[n % 2], RAMP_LANES[n % 2], RELEASE_EXIT, *via(INBOUND_EXIT_VIA)],
                    "yards": [(aisle, lane_mid(aisle))],
                    "xray": n % 2,
                    # Most trucks are pulled for a physical check; the rest only drive through.
                    "ramp": lane_mid(RAMP_LANES[n % 2][0], 1) if n % 3 != 2 else None,
                }
            )
    export_mid = export_lane[len(export_lane) // 2]
    end_node = graph.way_chain(EXPORT_ROAD)[-1]["to"]
    export_end = (graph.nodes[end_node]["x"], graph.nodes[end_node]["y"])
    zone_road = graph.way_chain(EXPORT_ZONE_ROAD)[0]["xy"]
    outbound_gate_xy = _point_at(zone_road, _cum(zone_road), EXPORT_GATE_AT)[:2]
    export_shed = _centroid(by_id[EXPORT_RAMP_SHEDS[0]])
    outbound_specs = [
        {
            "ways": [EXPORT_LOT_IN, _spine_to(graph, aisle), aisle, EXPORT_LOT_OUT, EXPORT_ZONE_ROAD, {"via": export_end}],
            "yards": [("export-staging", lane_mid(aisle)), ("export-parking", export_mid)],
            "xray": None,
            "ramp": export_shed,
        }
        for aisle in EXPORT_LOT_AISLES
    ]

    def plan(flow: str, start: str, end: str, specs) -> list[dict]:
        made = []
        for index, spec in enumerate(specs):
            edges = graph.journey(start, spec["ways"], end)
            if not edges:
                print(f"  ! no {flow} journey through ways {spec['ways']}")
                continue
            path = _journey_path(edges)
            cum = _cum(path)
            stops = []
            after = 0.0
            for ref, at in spec["yards"]:
                s = _nearest_s(path, cum, at, after)
                stops.append({"s": _r(s), "kind": "yard", "ref": ref})
                after = s + 20
            if spec["xray"] is not None:
                s = _nearest_s(path, cum, _centroid(by_id[XRAY_HALLS[spec["xray"]]]), after)
                stops.append({"s": _r(s), "kind": "xray", "ref": f"xray-{spec['xray'] + 1}"})
                after = s + 20
            if spec["ramp"] is not None:
                s = _nearest_s(path, cum, spec["ramp"], after)
                stops.append({"s": _r(s), "kind": "ramp", "ref": ramps[flow]["id"]})
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
        last_stop = max(stop["s"] for stop in lead["stops"])
        portal_ref = f"{flow}-portal"
        gate_ref = f"{flow}-gate"
        release_ref = f"{flow}-release"
        if flow == "inbound":
            # Radiation portals, then the appointment gates, on the approach road every truck shares.
            prefix = common_prefix(group)
            prefix_len = _length(_journey_path(prefix)) if prefix else 0.0
            first_stop = min(stop["s"] for stop in lead["stops"])
            limit = min(prefix_len - 15, first_stop - 60) if prefix else first_stop - 60
            approach = graph.way_chain(INBOUND_APPROACH[0])[0]["xy"][0]
            turn = _nearest_s(lead["path"], lead["cum"], approach)
            s_portal = min(turn + 50, limit - 90)
            s_gate = min(turn + 230, limit)
            s_release = _nearest_s(lead["path"], lead["cum"], INBOUND_RELEASE_XY, last_stop + 30)
            portals.append(place(lead, s_portal, "portal", portal_ref))
            anchors = {portal_ref: s_portal, gate_ref: s_gate, release_ref: s_release}
        else:
            staging = next(stop["s"] for stop in lead["stops"] if stop["ref"] == "export-staging")
            s_permit = _nearest_s(lead["path"], lead["cum"], OUTBOUND_PERMIT_XY, staging + 20)
            s_gate = _nearest_s(lead["path"], lead["cum"], outbound_gate_xy, s_permit + 20)
            s_release = _nearest_s(lead["path"], lead["cum"], OUTBOUND_RELEASE_XY, last_stop + 30)
            anchors = {"outbound-permit": s_permit, gate_ref: s_gate, release_ref: s_release}
            gates.append(place(lead, s_permit, "gate", "outbound-permit", {"lanes": 1}))
        gates.append(place(lead, s_gate, "gate", gate_ref, {"lanes": 3 if flow == "inbound" else 2}))
        gates.append(place(lead, s_release, "release", release_ref, {"lanes": 2}))

        for route in group:
            stops = list(route["stops"])
            lo = 0.0
            for ref, s_lead in anchors.items():
                x, y, _ = _point_at(lead["path"], lead["cum"], s_lead)
                if ref == release_ref:
                    lo = max(lo, max(stop["s"] for stop in route["stops"]))
                elif ref == "outbound-permit":
                    lo = next(stop["s"] for stop in route["stops"] if stop["ref"] == "export-staging")
                s = _nearest_s(route["path"], route["cum"], (x, y), lo)
                lo = s + 1
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

    # --- x-ray gantries: one scanner on the lane past each hall ---
    xrays = []
    for index in range(len(XRAY_HALLS)):
        ref = f"xray-{index + 1}"
        route = next((r for r in truck_routes if any(st["ref"] == ref for st in r["stops"])), None)
        if not route:
            continue
        stop = next(st for st in route["stops"] if st["ref"] == ref)
        x, y, heading = _point_at(route["p"], _cum(route["p"]), stop["s"])
        xrays.append({"id": ref, "x": _r(x), "y": _r(y), "h": round(heading, 3), "name": f"Cargo x-ray {index + 1}"})

    # --- operational zones, drawn like the GAC process maps ---
    main_pts = [p for y in yards if y["kind"] == "main" for ring in y["pads"] for p in ring]
    main_pts += [p for y in yards if y["kind"] == "main" for lane in y["lanes"] for p in lane["p"]]
    external_pts = [p for y in yards if y["kind"] == "external" for ring in y["pads"] for p in ring]
    ops_pts = main_pts + [p for i in XRAY_HALLS + IMPORT_RAMP_SHEDS for p in by_id[i]]
    ops_pts += [bay[:2] for bay in ramps["inbound"]["bays"]]
    zones = [
        {"id": "import-ops", "kind": "ops", "flow": "inbound", "ring": _xy(_soft_hull(ops_pts, 14.0))},
        {"id": "external-parking", "kind": "proposal", "flow": "inbound", "ring": _xy(_soft_hull(external_pts, 10.0))},
    ]
    staging_pts = [p for y in yards if y["kind"] == "staging" for lane in y["lanes"] for p in lane["p"]]
    # The lot's own perimeter lane, without the stubs that reach out to the public road.
    staging_pts += [p for e in graph.way_chain(EXPORT_LOT_IN[0])[1:9] for p in e["xy"]]
    zones.append({"id": "export-staging", "kind": "outside", "flow": "outbound", "ring": _xy(_soft_hull(staging_pts, 8.0))})

    # --- stations from the published inbound and outbound truck process ---
    def anchor(ref: str):
        for item in portals + gates:
            if item["ref"] == ref:
                return item["x"], item["y"]
        return None

    def centre(points) -> tuple[float, float]:
        return _r(sum(p[0] for p in points) / len(points)), _r(sum(p[1] for p in points) / len(points))

    def area_centre(rings) -> tuple[float, float]:
        total = sum(abs(_shoelace(r)) for r in rings) or 1.0
        x = sum(_centroid(r + [r[0]])[0] * abs(_shoelace(r)) for r in rings) / total
        y = sum(_centroid(r + [r[0]])[1] * abs(_shoelace(r)) for r in rings) / total
        return _r(x), _r(y)

    main_capacity = sum(_bay_count(lane["p"]) for y in yards if y["kind"] == "main" for lane in y["lanes"])
    import_bays = len(ramps["inbound"]["bays"])
    if inbound:
        lead = next(r for r in truck_routes if r["flow"] == "inbound")
        first = next(st for st in lead["stops"] if st["kind"] == "portal")
        x0, y0, _ = _point_at(lead["p"], _cum(lead["p"]), max(0, first["s"] - 450))
        mx, my = area_centre([ring for y in yards if y["kind"] == "main" for ring in y["pads"]])
        ex, ey = area_centre([ring for y in yards if y["kind"] == "external" for ring in y["pads"]])
        stations += [
            {"n": 1, "flow": "inbound", "tone": "gold", "en": "Truck road from Saudi Arabia", "ar": "طريق الشاحنات القادمة من السعودية", "x": _r(x0), "y": _r(y0)},
            {"n": 2, "flow": "inbound", "tone": "maroon", "en": "Radiation detection portals", "ar": "بوابات كشف المواد المشعة", "x": anchor("inbound-portal")[0], "y": anchor("inbound-portal")[1]},
            {"n": 3, "flow": "inbound", "tone": "maroon", "en": "Appointment check gates (3)", "ar": "بوابات التحقق من الموعد", "x": anchor("inbound-gate")[0], "y": anchor("inbound-gate")[1]},
            {"n": "+", "flow": "inbound", "tone": "proposal", "en": "Unused lot · proposed external parking", "ar": "منطقة غير مستغلة، مقترح تخصيص جزء منها كمواقف خارجية", "x": ex, "y": ey},
            {"n": 4, "flow": "inbound", "tone": "green", "en": "Main parking (~700)", "ar": "المواقف الرئيسية (حوالي 700 موقف)", "x": mx, "y": my, "capacity": main_capacity},
            {"n": 5, "flow": "inbound", "tone": "green", "en": "X-ray scanning area", "ar": "منطقة المسح بالأشعة", "x": centre([p for i in XRAY_HALLS for p in by_id[i]])[0], "y": centre([p for i in XRAY_HALLS for p in by_id[i]])[1]},
            {"n": 6, "flow": "inbound", "tone": "green", "en": "Inspection ramps (~130)", "ar": "رمبات التفتيش (حوالي 130 موقف)", "x": area_centre([by_id[i] for i in IMPORT_RAMP_SHEDS])[0], "y": area_centre([by_id[i] for i in IMPORT_RAMP_SHEDS])[1], "capacity": import_bays},
            {"n": 7, "flow": "inbound", "tone": "green", "en": "Release gate", "ar": "بوابة الإفراج", "x": anchor("inbound-release")[0], "y": anchor("inbound-release")[1]},
        ]
    if outbound:
        lead = next(r for r in truck_routes if r["flow"] == "outbound")
        first = lead["stops"][0]
        x0, y0, _ = _point_at(lead["p"], _cum(lead["p"]), max(0, first["s"] - 900))
        staging_c = area_centre([ring for y in yards if y["kind"] == "staging" for ring in y["pads"]])
        stations += [
            {"n": 1, "flow": "outbound", "tone": "gold", "en": "Truck road from Doha", "ar": "طريق الشاحنات القادمة من الدوحة", "x": _r(x0), "y": _r(y0)},
            {"n": 2, "flow": "outbound", "tone": "maroon", "en": "External export parking", "ar": "المواقف الخارجية لمنطقة الصادر", "x": staging_c[0], "y": staging_c[1]},
            {"n": 3, "flow": "outbound", "tone": "maroon", "en": "External parking exit (entry-permit gate)", "ar": "مخرج المواقف الخارجية (بوابة لإصدار تصريح الدخول)", "x": anchor("outbound-permit")[0], "y": anchor("outbound-permit")[1]},
            {"n": 4, "flow": "outbound", "tone": "green", "en": "Export zone entrance (2 gates)", "ar": "مدخل منطقة الصادر التشغيلية", "x": anchor("outbound-gate")[0], "y": anchor("outbound-gate")[1]},
            {"n": 5, "flow": "outbound", "tone": "green", "en": "Export parking (~12)", "ar": "المواقف الرئيسية (حوالي 12 موقف)", "x": centre(export_lane)[0], "y": centre(export_lane)[1]},
            {"n": 6, "flow": "outbound", "tone": "green", "en": "Export inspection ramps", "ar": "رمبات التفتيش", "x": _r(export_shed[0]), "y": _r(export_shed[1])},
            {"n": 7, "flow": "outbound", "tone": "green", "en": "Release gate", "ar": "بوابة الإفراج", "x": anchor("outbound-release")[0], "y": anchor("outbound-release")[1]},
        ]
    for st in stations:
        short = STATION_SHORT.get((st["flow"], st["n"]))
        if short:
            st["short"], st["ar_short"], st["meta"] = short

    arrival_canopy = _centroid(by_id[ARRIVAL_CANOPY])
    departure_canopy = _centroid(by_id[DEPARTURE_CANOPY])
    customs_canopy = _centroid(by_id[CUSTOMS_CANOPY])
    stations += [
        {"n": "P", "flow": "passenger", "tone": "teal", "en": "Passenger arrival booths", "ar": "أكشاك القدوم", "short": "Arrivals", "ar_short": "القدوم", "meta": "4 lanes", "x": _r(arrival_canopy[0]), "y": _r(arrival_canopy[1])},
        {"n": "P", "flow": "passenger", "tone": "teal", "en": "Passenger departure booths", "ar": "أكشاك المغادرة", "short": "Departures", "ar_short": "المغادرة", "meta": "4 lanes", "x": _r(departure_canopy[0]), "y": _r(departure_canopy[1])},
        {"n": "C", "flow": "passenger", "tone": "teal", "en": "Customs hall canopy", "ar": "مظلة الجمارك", "short": "Customs hall", "ar_short": "مظلة الجمارك", "meta": "", "x": _r(customs_canopy[0]), "y": _r(customs_canopy[1])},
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
    (cx0, cy0), (cx1, cy1) = CIVIL_DEFENCE

    def civil(ring) -> bool:
        x, y = _centroid(ring)
        return cx0 < x < cx1 and cy0 < y < cy1

    buildings = [b for b in buildings if near_port(b["ring"], 60.0) or civil(b["ring"])]
    for b in buildings:
        if civil(b["ring"]):
            b["role"] = "civil"

    # Trees never stand in a truck bay, under a shed roof, or on a parking lane.
    keep_clear = [b["ring"] for b in buildings + canopies] + [pad for y in yards for pad in y["pads"]]
    keep_clear += [_bay_ring(bay) for ramp in ramps.values() for bay in ramp["bays"]]
    keep_clear += [_soft_hull(by_id[i], 5.0) for i in IMPORT_RAMP_SHEDS + EXPORT_RAMP_SHEDS]
    keep_clear += [_lane_ring(lane["p"], 5.5) for y in yards if not y["pads"] for lane in y["lanes"]]
    vegetation = _clear_trees(_load(VEGETATION_PATH)["palms"] if VEGETATION_PATH.exists() else [], roads, keep_clear)

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
        "ramps": list(ramps.values()),
        "zones": zones,
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


YARD_BAY = 18.5  # one truck nose-to-tail along a yard lane; matches BAY in view/twin/world.js


def _bay_count(lane) -> int:
    return max(0, int((_length(lane) - 2) // YARD_BAY))


def _parking_kind(yard: dict) -> str:
    """Main parking lies north-east of the divider road; the lot south-west of it is unused."""
    pts = [p for ring in yard["pads"] for p in ring] or [p for lane in yard["lanes"] for p in lane["p"]]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    (ax, ay), (bx, by) = PARKING_DIVIDER
    side = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    return "main" if side > 0 else "external"


def _export_parking(graph: Graph, shed) -> list[dict]:
    """The roughly twelve export bays, in front of the export inspection shed: kerbside on the
    export road from just past the export zone road's junction to short of the shed's docks, with
    a second row behind the first where one row is too short for twelve trucks."""
    road = [p for e in graph.way_chain(EXPORT_ROAD) for p in e["xy"]]
    line = _resample(road, 3.0)
    cum = _cum(line)
    start = _nearest_s(line, cum, EXPORT_ZONE_ROAD_TO[2]) + 16.0
    # Stop well short of the shed's near face, where trucks back onto its docks.
    end = _nearest_s(line, cum, _centroid(shed)) - 46.0
    rows = []
    for k, off in enumerate((4.6, 9.4)):
        kerb = _offset(line, off)
        lane = [p for p, d in zip(kerb, cum) if start <= d <= end]
        rows.append({"way": "export-parking" if k == 0 else "export-parking-2", "p": _xy(lane)})
        if sum(_bay_count(r["p"]) for r in rows) >= 12:
            break
    return [{"id": "export-parking", "name": "Export parking", "kind": "export", "pads": [], "lanes": rows}]


def _split_edge(graph: Graph, way: int, index: int, point) -> str:
    """Split one edge of a way (both directions, if two-way) at the point nearest `point`;
    returns the new junction node. Later edges of the way are renumbered to stay in order."""
    fwd = next(e for e in graph.by_way[way] if e["id"] == f"w{way}:{index}:f")
    xy = [tuple(q) for q in fwd["xy"]]
    best, at, cut = math.inf, 1, xy[0]
    for i in range(1, len(xy)):
        (ax, ay), (bx, by) = xy[i - 1], xy[i]
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy or 1.0)))
        q = (ax + dx * t, ay + dy * t)
        d = math.dist(q, point)
        if d < best:
            best, at, cut = d, i, q
    node = f"x{way}_{index}"
    graph.nodes[node] = {"id": node, "x": cut[0], "y": cut[1]}

    def piece(src, ident, a, b, line):
        e = dict(src)
        e.update({"id": ident, "from": a, "to": b, "xy": [list(q) for q in line], "length_m": _length(line)})
        return e

    head, tail = xy[:at] + [cut], [cut] + xy[at:]
    parts = [piece(fwd, f"w{way}:{index}:f", fwd["from"], node, head), piece(fwd, f"w{way}:{index + 1}:f", node, fwd["to"], tail)]
    rev = next((e for e in graph.by_way[way] if e["id"] == f"w{way}:{index}:r"), None)
    if rev:
        parts += [piece(rev, f"w{way}:{index}:r", node, fwd["from"], head[::-1]), piece(rev, f"w{way}:{index + 1}:r", fwd["to"], node, tail[::-1])]
    kept = []
    for e in graph.edges:
        if e["osm_way_id"] == way:
            _, k, d = e["id"].rsplit(":", 2)[0][1:], int(e["id"].split(":")[1]), e["id"].split(":")[2]
            if k == index:
                continue
            if k > index:
                e = dict(e, id=f"w{way}:{k + 1}:{d}")
        kept.append(e)
    graph.edges = kept + parts
    _reindex(graph)
    return node


def _reindex(graph: Graph) -> None:
    graph.out, graph.by_way = {}, {}
    for e in graph.edges:
        graph.out.setdefault(e["from"], []).append(e)
        graph.by_way.setdefault(e["osm_way_id"], []).append(e)


def _add_export_zone_road(graph: Graph) -> None:
    """The export zone's own road, missing from OpenStreetMap: one way, two lanes, from Bu Samra
    Road south-west between the external parking and the canopy lot to the export road."""
    a = _split_edge(graph, *EXPORT_ZONE_ROAD_FROM)
    b = _split_edge(graph, *EXPORT_ZONE_ROAD_TO)
    ends = [(graph.nodes[n]["x"], graph.nodes[n]["y"]) for n in (a, b)]
    # A straight run off the junction, then a smooth bend south onto the export road.
    raw = [ends[0], *EXPORT_ZONE_ROAD_SHAPE, ends[1]]
    line = _smooth(_resample(raw, 4.0), passes=4)
    line[0], line[-1] = ends
    template = graph.way_chain(EXPORT_ROAD)[0]
    graph.edges.append(
        dict(
            template,
            id=f"w{EXPORT_ZONE_ROAD}:1:f",
            osm_way_id=EXPORT_ZONE_ROAD,
            name=None,
            name_en=None,
            name_ar=None,
            **{"from": a, "to": b},
            xy=[[round(x, 3), round(y, 3)] for x, y in line],
            length_m=_length(line),
            oneway="forward",
            highway="service",
            service=None,
            lanes=2,
            lanes_tagged=True,
        )
    )
    _reindex(graph)


def _export_staging(graph: Graph) -> dict:
    """The external export parking: the large paved lot north-west of the Doha roundabout."""
    lanes = []
    for way in EXPORT_LOT_LANES:
        pts = [p for e in graph.way_chain(way) for p in e["xy"]]
        if _length(pts) >= 40:
            lanes.append({"way": way, "p": _xy(pts)})
    # Its aisles are too far apart to read as one block of rows, but the lot is paved edge to edge.
    ring = [p for e in graph.way_chain(EXPORT_LOT_IN[0])[1:9] for p in e["xy"]] + [p for lane in lanes for p in lane["p"]]
    return {"id": "export-staging", "name": "External export parking", "kind": "staging", "pads": [_xy(_soft_hull(ring, 6.0))], "lanes": lanes}


def _spine_to(graph: Graph, aisle: int) -> list:
    """From the lot's north corner along its spine to the head of the given aisle."""
    node = graph.nodes[graph.way_chain(aisle)[0]["from"]]
    return {"via": (node["x"], node["y"])}


def _dock_bays(ring, roads: list[dict], obstacles) -> list[list[float]]:
    """Truck bays square to both long faces of a shed: [x, y, heading], trucks backed in, nose out."""
    pts = ring[:-1] if ring[0] == ring[-1] else list(ring)
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - cx) ** 2 for p in pts)
    syy = sum((p[1] - cy) ** 2 for p in pts)
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in pts)
    ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux
    along = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in pts]
    across = [(p[0] - cx) * vx + (p[1] - cy) * vy for p in pts]
    a0, a1 = min(along) + 2.0, max(along) - 2.0
    count = int((a1 - a0) // RAMP_PITCH)
    first = (a0 + a1) / 2 - (count - 1) * RAMP_PITCH / 2
    bays = []
    for side in (-1, 1):
        face = max(across) if side > 0 else min(across)
        ox, oy = vx * side, vy * side
        heading = math.atan2(ox, oy)
        for k in range(count):
            a = first + k * RAMP_PITCH
            x = cx + ux * a + vx * face + ox * TRUCK_REACH
            y = cy + uy * a + vy * face + oy * TRUCK_REACH
            body = [(x + ox * t, y + oy * t) for t in (-8.0, 0.0, 8.0)]
            if any(_road_clearance(p, roads) < 1.2 for p in body):
                continue
            if any(point_in_ring(p[0], p[1], r) for r in obstacles for p in body):
                continue
            bays.append([_r(x), _r(y), round(heading, 3)])
    return bays


def _main_infill(yards: list[dict], roads: list[dict]) -> dict | None:
    """Rows across the paved block between the mapped main-parking aisles.

    OpenStreetMap maps aisles in only parts of the main lot; the imagery shows one continuous
    fan of rows. Rows run parallel to the mapped aisles, 11 m apart, wherever the block is free
    of roads, aisles and existing pads."""
    main = [y for y in yards if y["kind"] == "main" and y["pads"]]
    if not main:
        return None
    biggest = max(main, key=lambda y: len(y["lanes"]))
    dirs = [math.atan2(l["p"][-1][0] - l["p"][0][0], l["p"][-1][1] - l["p"][0][1]) % math.pi for l in biggest["lanes"]]
    ang = sorted(dirs)[len(dirs) // 2]
    ux, uy = math.sin(ang), math.cos(ang)
    vx, vy = uy, -ux
    hull = _soft_hull([p for y in main for ring in y["pads"] for p in ring], 0.0)
    hull_edges = list(zip(hull, hull[1:] + hull[:1]))
    pads = [_soft_hull(ring, 4.0) for y in yards for ring in y["pads"]]
    boxes = []
    for road in roads:
        if road["c"] == "dirt":
            continue
        xs = [q[0] for q in road["p"]]
        ys = [q[1] for q in road["p"]]
        need = road["w"] / 2 + (7.75 if road["c"] == "aisle" else 5.7)
        boxes.append((min(xs) - need, max(xs) + need, min(ys) - need, max(ys) + need, need, road["p"]))

    def free(p) -> bool:
        if not point_in_ring(p[0], p[1], hull) or any(_segment_distance(p, a, b) < 7 for a, b in hull_edges):
            return False
        for x0, x1, y0, y1, need, pts in boxes:
            if x0 <= p[0] <= x1 and y0 <= p[1] <= y1 and any(_segment_distance(p, a, b) < need for a, b in zip(pts, pts[1:])):
                return False
        return not any(point_in_ring(p[0], p[1], ring) for ring in pads)

    along = [p[0] * ux + p[1] * uy for p in hull]
    across = [p[0] * vx + p[1] * vy for p in hull]
    lanes = []
    c = min(across) + 8
    while c < max(across) - 8:
        run = []
        a = min(along)
        while a <= max(along) + 2:
            p = (a * ux + c * vx, a * uy + c * vy)
            if a <= max(along) and free(p):
                run.append(p)
            else:
                if len(run) > 1 and math.dist(run[0], run[-1]) >= 40:
                    lanes.append({"way": f"infill-{len(lanes)}", "p": _xy([run[1], run[-2]])})
                run = []
            a += 2.0
        c += 11.0
    if not lanes:
        return None
    return {"id": "main-infill", "name": "Main truck parking", "kind": "main", "pads": _yard_pads(lanes), "lanes": lanes}


def _bay_ring(bay) -> list[tuple[float, float]]:
    x, y, h = bay
    fx, fy = math.sin(h), math.cos(h)
    lx, ly = -fy, fx
    return [(x + fx * a + lx * b, y + fy * a + ly * b) for a, b in ((-10.5, -2.4), (9.5, -2.4), (9.5, 2.4), (-10.5, 2.4))]


def _lane_ring(points, half: float) -> list[tuple[float, float]]:
    left = _offset(points, -half)
    right = _offset(points, half)
    return left + right[::-1]


def _road_clearance(p, roads: list[dict]) -> float:
    best = math.inf
    for road in roads:
        if road["c"] == "dirt":
            continue
        pts = road["p"]
        reach = road["w"] / 2 + 5
        if (
            p[0] < min(q[0] for q in pts) - reach
            or p[0] > max(q[0] for q in pts) + reach
            or p[1] < min(q[1] for q in pts) - reach
            or p[1] > max(q[1] for q in pts) + reach
        ):
            continue
        for a, b in zip(pts, pts[1:]):
            best = min(best, _segment_distance(p, a, b) - road["w"] / 2)
    return best


def _soft_hull(points, pad: float) -> list[tuple[float, float]]:
    """Convex hull grown by pad metres with rounded corners: a zone outline like the process maps."""
    grown = [(p[0] + pad * math.cos(a), p[1] + pad * math.sin(a)) for p in points for a in (i * math.pi / 8 for i in range(16))]
    pts = sorted(set((round(x, 1), round(y, 1)) for x, y in grown))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return _resample(lower[:-1] + upper[:-1] + [lower[0]], 12.0)


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
