"""Turn raw Overpass elements into customs-oriented GeoJSON layers."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from abu_samra.config import LAYER_PURPOSE, NON_VEHICLE_HIGHWAYS, PORT_OSM_WAY_ID
from abu_samra.geo import (
    BBox,
    LocalOrigin,
    clip_linestring,
    clip_polygon,
    close_ring,
    line_hits_ring,
    point_in_ring,
    polygon_area_m2,
    polyline_length_m,
    round_lonlat,
    round_xy,
    local_xy,
)

AREA_HIGHWAYS = {"services", "rest_area", "escape", "elevator"}
CHECKPOINT_BARRIERS = {"border_control"}
CHECKPOINT_AMENITIES = {"customs"}
CHECKPOINT_OFFICES = {"customs", "immigration"}
CHECKPOINT_MILITARY = {"checkpoint"}
TRAFFIC_HIGHWAYS = {
    "traffic_signals",
    "stop",
    "give_way",
    "crossing",
    "mini_roundabout",
    "motorway_junction",
    "toll_gantry",
    "speed_camera",
}
PROMOTED_TAGS = (
    "highway",
    "lanes",
    "oneway",
    "junction",
    "surface",
    "smoothness",
    "access",
    "hgv",
    "goods",
    "motor_vehicle",
    "maxspeed",
    "maxweight",
    "maxheight",
    "maxwidth",
    "bridge",
    "tunnel",
    "layer",
    "service",
    "ref",
    "barrier",
    "amenity",
    "building",
    "landuse",
    "natural",
    "aeroway",
    "man_made",
    "office",
    "military",
    "waterway",
    "place",
    "entrance",
    "railway",
)


@dataclass
class Feature:
    feature_id: str
    layer: str
    osm_type: str
    osm_id: int
    geometry_type: str
    coordinates: list
    tags: dict
    inside_port: bool = False
    length_m: float | None = None
    area_m2: float | None = None
    extra: dict = field(default_factory=dict)


def merge_elements(elements: list[dict]) -> tuple[dict[int, dict], dict[int, dict], dict[int, dict]]:
    """Merge body and skeleton records. Tagged versions win over bare skeletons."""
    nodes: dict[int, dict] = {}
    ways: dict[int, dict] = {}
    relations: dict[int, dict] = {}
    for element in elements:
        kind = element.get("type")
        element_id = element.get("id")
        if kind == "node":
            _merge_record(nodes, element_id, element)
        elif kind == "way":
            _merge_record(ways, element_id, element)
        elif kind == "relation":
            _merge_record(relations, element_id, element)
    return nodes, ways, relations


def _merge_record(store: dict[int, dict], element_id: int, element: dict) -> None:
    current = store.get(element_id)
    if current is None:
        store[element_id] = element
        return
    if element.get("tags") and not current.get("tags"):
        tags = element["tags"]
        current.clear()
        current.update(element)
        current["tags"] = tags
        return
    if element.get("tags") and current.get("tags"):
        store[element_id] = element
        return
    for key in ("lat", "lon", "nodes", "members", "version", "timestamp"):
        if key in element and key not in current:
            current[key] = element[key]


def way_coords(way: dict, nodes: dict[int, dict]) -> list[tuple[float, float]] | None:
    coords: list[tuple[float, float]] = []
    for node_id in way.get("nodes") or []:
        node = nodes.get(node_id)
        if not node or "lat" not in node or "lon" not in node:
            return None
        coords.append((node["lon"], node["lat"]))
    if len(coords) < 2:
        return None
    return coords


def geom_coords_from_overpass(geometry: list[dict]) -> list[tuple[float, float]]:
    return [(point["lon"], point["lat"]) for point in geometry if "lat" in point and "lon" in point]


def is_closed(coords: list[tuple[float, float]]) -> bool:
    return len(coords) >= 4 and coords[0] == coords[-1]


def as_area(tags: dict, coords: list[tuple[float, float]]) -> bool:
    if tags.get("area") == "no" or not is_closed(coords):
        return False
    if tags.get("area") == "yes":
        return True
    if any(key in tags for key in ("building", "landuse", "leisure", "natural")):
        return True
    if tags.get("aeroway") in {"helipad", "apron", "aerodrome"}:
        return True
    if tags.get("amenity") and "highway" not in tags:
        return True
    if tags.get("highway") in AREA_HIGHWAYS:
        return True
    if "area:highway" in tags:
        return True
    return False


def classify(tags: dict, geometry_kind: str) -> str:
    barrier = tags.get("barrier")
    amenity = tags.get("amenity")
    office = tags.get("office")
    military = tags.get("military")
    highway = tags.get("highway")
    if (
        barrier in CHECKPOINT_BARRIERS
        or amenity in CHECKPOINT_AMENITIES
        or office in CHECKPOINT_OFFICES
        or military in CHECKPOINT_MILITARY
        or tags.get("checkpoint")
    ):
        return "checkpoints"
    if barrier:
        return "barriers"
    if tags.get("aeroway"):
        return "aeroway"
    if amenity == "parking" or "parking" in tags:
        return "parking"
    if highway in {"bus_stop", "platform"}:
        return "facilities"
    if highway and geometry_kind == "line":
        return "roads"
    if (highway or "area:highway" in tags) and geometry_kind == "polygon":
        return "road_areas"
    if tags.get("building"):
        return "buildings"
    if geometry_kind == "point" and (
        highway in TRAFFIC_HIGHWAYS or tags.get("traffic_calming") or tags.get("crossing")
    ):
        return "traffic_control"
    if any(key in tags for key in ("amenity", "office", "man_made", "shop", "tourism", "emergency")) or military:
        return "facilities"
    if tags.get("landuse") or tags.get("leisure"):
        return "landuse"
    if tags.get("natural") or tags.get("waterway") or tags.get("water"):
        return "natural"
    if tags.get("boundary"):
        return "boundaries"
    if tags.get("place"):
        return "places"
    if highway:
        return "roads"
    return "other"


def parse_lanes(tags: dict) -> tuple[int | None, bool]:
    raw = tags.get("lanes")
    if not raw:
        return None, False
    token = str(raw).split(";")[0].strip()
    try:
        return int(float(token)), True
    except ValueError:
        return None, False


def oneway_mode(tags: dict) -> tuple[str, bool]:
    raw = tags.get("oneway")
    if raw in {"yes", "1", "true"}:
        return "forward", False
    if raw in {"-1", "reverse"}:
        return "reverse", False
    if raw in {"no", "0", "false"}:
        return "both", False
    if tags.get("junction") in {"roundabout", "circular"}:
        return "forward", True
    if tags.get("highway") in {"motorway", "motorway_link"}:
        return "forward", True
    return "both", False


def road_status(tags: dict) -> str:
    highway = tags.get("highway")
    if highway == "proposed":
        return "proposed"
    if highway == "construction":
        return "construction"
    return "operational"


def vehicle_allowed(tags: dict) -> bool:
    if tags.get("highway") in NON_VEHICLE_HIGHWAYS:
        return False
    if tags.get("access") == "no" or tags.get("motor_vehicle") == "no":
        return False
    return "highway" in tags


def _hits_port(geometry_type: str, coords, port_ring: list[tuple[float, float]] | None) -> bool:
    if not port_ring:
        return False
    if geometry_type == "Point":
        lon, lat = coords
        return point_in_ring(lon, lat, port_ring)
    if geometry_type == "LineString":
        return line_hits_ring(coords, port_ring)
    if geometry_type == "Polygon":
        ring = coords[0]
        if any(point_in_ring(lon, lat, port_ring) for lon, lat in ring):
            return True
        lon = sum(point[0] for point in ring) / len(ring)
        lat = sum(point[1] for point in ring) / len(ring)
        return point_in_ring(lon, lat, port_ring)
    return False


def _base_properties(feature: Feature) -> dict:
    tags = feature.tags
    properties = {
        "id": feature.feature_id,
        "layer": feature.layer,
        "osm_type": feature.osm_type,
        "osm_id": feature.osm_id,
        "name": tags.get("name"),
        "name_en": tags.get("name:en") or tags.get("name"),
        "name_ar": tags.get("name:ar"),
        "inside_port": feature.inside_port,
        "scope": "port" if feature.inside_port else "approach",
        "length_m": None if feature.length_m is None else round(feature.length_m, 2),
        "area_m2": None if feature.area_m2 is None else round(feature.area_m2, 1),
        "tags": tags,
    }
    for key in PROMOTED_TAGS:
        if key in tags:
            properties[key] = tags[key]
    if "highway" in tags and feature.geometry_type == "LineString":
        lanes, tagged = parse_lanes(tags)
        mode, inferred = oneway_mode(tags)
        properties["lanes"] = lanes
        properties["lanes_tagged"] = tagged
        properties["oneway_mode"] = mode
        properties["oneway_inferred"] = inferred
        properties["vehicle"] = vehicle_allowed(tags)
        properties["status"] = road_status(tags)
    properties.update(feature.extra)
    return properties


def feature_to_wgs84(feature: Feature) -> dict:
    return {
        "type": "Feature",
        "id": feature.feature_id,
        "properties": _base_properties(feature),
        "geometry": {"type": feature.geometry_type, "coordinates": _round_geometry(feature, local=False)},
    }


def feature_to_local(feature: Feature, origin: LocalOrigin) -> dict:
    return {
        "type": "Feature",
        "id": feature.feature_id,
        "properties": _base_properties(feature),
        "geometry": {
            "type": feature.geometry_type,
            "coordinates": _project_geometry(feature, origin),
        },
    }


def _round_geometry(feature: Feature, local: bool) -> list:
    if feature.geometry_type == "Point":
        return round_lonlat(*feature.coordinates)
    if feature.geometry_type == "LineString":
        return [round_lonlat(*point) for point in feature.coordinates]
    return [[round_lonlat(*point) for point in ring] for ring in feature.coordinates]


def _project_geometry(feature: Feature, origin: LocalOrigin):
    if feature.geometry_type == "Point":
        lon, lat = feature.coordinates
        return round_xy(*local_xy(lat, lon, origin))
    if feature.geometry_type == "LineString":
        return [round_xy(*local_xy(lat, lon, origin)) for lon, lat in feature.coordinates]
    return [
        [round_xy(*local_xy(lat, lon, origin)) for lon, lat in ring]
        for ring in feature.coordinates
    ]


def collection(features: list[Feature], origin: LocalOrigin, frame: str, layer: str) -> dict:
    if frame == "local":
        encoded = [feature_to_local(feature, origin) for feature in features]
        coordinate_note = (
            "Coordinates are meters [east, north] relative to local_origin. "
            "EPSG:32639 translated to the port. Z is not in the geometry; use the DEM for elevation."
        )
    else:
        encoded = [feature_to_wgs84(feature) for feature in features]
        coordinate_note = "Coordinates are WGS84 [longitude, latitude] as required by GeoJSON."
    return {
        "type": "FeatureCollection",
        "name": layer,
        "frame": frame,
        "purpose": LAYER_PURPOSE.get(layer, ""),
        "coordinate_note": coordinate_note,
        "local_origin": origin.as_dict(),
        "features": encoded,
    }


def _make_feature(
    feature_id: str,
    osm_type: str,
    osm_id: int,
    geometry_type: str,
    coordinates,
    tags: dict,
    port_ring: list[tuple[float, float]] | None,
    origin: LocalOrigin,
    extra: dict | None = None,
) -> Feature | None:
    layer = classify(tags, _kind(geometry_type))
    feature = Feature(
        feature_id=feature_id,
        layer=layer,
        osm_type=osm_type,
        osm_id=osm_id,
        geometry_type=geometry_type,
        coordinates=coordinates,
        tags=tags,
        inside_port=_hits_port(geometry_type, coordinates, port_ring)
        or (osm_type == "way" and osm_id == PORT_OSM_WAY_ID),
        extra=extra or {},
    )
    if geometry_type == "LineString":
        feature.length_m = polyline_length_m(coordinates, origin)
        if feature.length_m < 0.05:
            return None
    elif geometry_type == "Polygon":
        feature.area_m2 = polygon_area_m2(coordinates[0], origin)
        if feature.area_m2 < 0.5:
            return None
    return feature


def _kind(geometry_type: str) -> str:
    return {"Point": "point", "LineString": "line", "Polygon": "polygon"}[geometry_type]


def build_features(
    nodes: dict[int, dict],
    ways: dict[int, dict],
    relations: dict[int, dict],
    aoi: BBox,
    port_ring: list[tuple[float, float]] | None,
    origin: LocalOrigin,
) -> tuple[dict[str, list[Feature]], list[dict]]:
    layers: dict[str, list[Feature]] = {name: [] for name in LAYER_PURPOSE}
    restrictions: list[dict] = []
    consumed_ways: set[int] = set()

    for relation in relations.values():
        tags = relation.get("tags") or {}
        if tags.get("type") == "restriction" or any(key.startswith("restriction") for key in tags):
            restrictions.append(_restriction_record(relation, nodes, origin))
            continue
        polygon = _relation_polygon(relation, ways, nodes)
        if not polygon:
            continue
        clipped = clip_polygon(polygon, aoi)
        if not clipped:
            continue
        feature = _make_feature(
            f"relation/{relation['id']}",
            "relation",
            relation["id"],
            "Polygon",
            [clipped],
            tags,
            port_ring,
            origin,
        )
        if feature:
            layers[feature.layer].append(feature)
            for member in relation.get("members") or []:
                if member.get("type") == "way" and member.get("role") in {"outer", "inner", ""}:
                    way = ways.get(member["ref"])
                    if way and not way.get("tags"):
                        consumed_ways.add(member["ref"])

    for way in ways.values():
        tags = way.get("tags") or {}
        if not tags or way["id"] in consumed_ways:
            continue
        coords = way_coords(way, nodes)
        if not coords:
            continue
        if as_area(tags, coords):
            clipped = clip_polygon(close_ring(coords), aoi)
            if not clipped:
                continue
            feature = _make_feature(
                f"way/{way['id']}",
                "way",
                way["id"],
                "Polygon",
                [clipped],
                tags,
                port_ring,
                origin,
            )
            if feature:
                layers[feature.layer].append(feature)
            continue
        for part_index, part in enumerate(clip_linestring(coords, aoi)):
            suffix = "" if part_index == 0 else f"#p{part_index}"
            feature = _make_feature(
                f"way/{way['id']}{suffix}",
                "way",
                way["id"],
                "LineString",
                part,
                tags,
                port_ring,
                origin,
            )
            if feature:
                layers[feature.layer].append(feature)

    for node in nodes.values():
        tags = node.get("tags") or {}
        if not tags or "lat" not in node:
            continue
        lon, lat = node["lon"], node["lat"]
        if not aoi.contains(lon, lat):
            continue
        feature = _make_feature(
            f"node/{node['id']}",
            "node",
            node["id"],
            "Point",
            (lon, lat),
            tags,
            port_ring,
            origin,
        )
        if feature:
            layers[feature.layer].append(feature)

    return layers, restrictions


def _chain_outer_ways(parts: list[list[tuple[float, float]]]) -> list[tuple[float, float]] | None:
    if not parts:
        return None
    unused = parts[:]
    chain = unused.pop(0)
    guard = 0
    while unused and guard < 10000:
        guard += 1
        end = chain[-1]
        for index, part in enumerate(unused):
            if part[0] == end:
                chain.extend(part[1:])
                unused.pop(index)
                break
            if part[-1] == end:
                chain.extend(reversed(part[:-1]))
                unused.pop(index)
                break
        else:
            break
    if len(chain) < 4:
        return None
    return close_ring(chain)


def _relation_polygon(relation: dict, ways: dict[int, dict], nodes: dict[int, dict]) -> list[tuple[float, float]] | None:
    outers: list[list[tuple[float, float]]] = []
    for member in relation.get("members") or []:
        if member.get("type") != "way" or member.get("role") not in {"outer", ""}:
            continue
        way = ways.get(member["ref"])
        if not way:
            continue
        coords = way_coords(way, nodes)
        if coords:
            outers.append(coords)
    if len(outers) == 1 and is_closed(outers[0]):
        return close_ring(outers[0])
    return _chain_outer_ways(outers)


def _restriction_record(relation: dict, nodes: dict[int, dict], origin: LocalOrigin) -> dict:
    tags = relation.get("tags") or {}
    record = {
        "osm_id": relation["id"],
        "restriction": next(
            (tags[key] for key in tags if key == "restriction" or key.startswith("restriction:")),
            None,
        ),
        "except": tags.get("except"),
        "from_ways": [],
        "to_ways": [],
        "via_nodes": [],
        "via_ways": [],
        "tags": tags,
    }
    for member in relation.get("members") or []:
        role = member.get("role")
        if role == "from" and member.get("type") == "way":
            record["from_ways"].append(member["ref"])
        elif role == "to" and member.get("type") == "way":
            record["to_ways"].append(member["ref"])
        elif role == "via" and member.get("type") == "way":
            record["via_ways"].append(member["ref"])
        elif role == "via" and member.get("type") == "node":
            node = nodes.get(member["ref"]) or {}
            via = {"osm_id": member["ref"]}
            if "lat" in node:
                via["longitude"] = node["lon"]
                via["latitude"] = node["lat"]
                x, y = local_xy(node["lat"], node["lon"], origin)
                via["x"], via["y"] = round(x, 3), round(y, 3)
            record["via_nodes"].append(via)
    return record


def empty_layers() -> dict[str, list]:
    return defaultdict(list)
