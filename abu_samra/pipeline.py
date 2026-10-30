"""Download and write the Abu Samra customs-port dataset."""

from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone

from abu_samra.config import (
    AOI_MARGINS_M,
    DATA_DIR,
    FALLBACK_PORT_BBOX,
    LAYER_PURPOSE,
    LAYERS,
    LOCAL_DIR,
    PORT_NAME_AR,
    PORT_NAME_EN,
    PORT_OSM_WAY_ID,
    PROCESSED_DIR,
    RAW_ELEVATION_DIR,
    RAW_OSM_DIR,
    ROOT,
    SITE,
    WGS84_DIR,
)
from abu_samra.elevation import clip_tile, crosscheck, ensure_tile, read_hgt, write_dem
from abu_samra.geo import BBox, clip_polygon, close_ring, expand_bbox, make_origin, meters_per_degree, ring_bounds, vertex_mean
from abu_samra.osm_model import (
    _make_feature,
    build_features,
    collection,
    geom_coords_from_overpass,
    merge_elements,
)
from abu_samra.overpass import OverpassError, boundary_query, context_query, fetch_port_seed, fetch_study_area, movement_query
from abu_samra.road_graph import apply_elevations, build_road_graph
from abu_samra.validate import validate

HELIPAD_LAT = 24.7477333
HELIPAD_LON = 50.851499


def fetch_all(refresh: bool = False) -> dict:
    RAW_OSM_DIR.mkdir(parents=True, exist_ok=True)
    seed, seed_source = _load_seed(refresh)
    port_ring = _seed_ring(seed)
    port_bbox = ring_bounds(port_ring)
    aoi = expand_bbox(port_bbox, AOI_MARGINS_M)
    lon, lat = vertex_mean(port_ring)
    origin = make_origin(lat, lon)
    per_lat, per_lon = meters_per_degree((aoi.south + aoi.north) / 2)
    print(
        "[abu-samra] study area "
        f"{(aoi.north - aoi.south) * per_lat / 1000:.2f} km north-south by "
        f"{(aoi.east - aoi.west) * per_lon / 1000:.2f} km east-west"
    )

    raw = _load_study_area(aoi, refresh)
    nodes, ways, relations = merge_elements(raw["elements"])
    print(f"[abu-samra] merged {len(nodes)} nodes, {len(ways)} ways, {len(relations)} relations")
    if not ways:
        raise RuntimeError("OSM download contained no ways for the study area")
    layers, restrictions = build_features(nodes, ways, relations, aoi, port_ring, origin)
    footprint = _ensure_port_footprint(layers, seed, port_ring, aoi, origin)
    for name in LAYERS:
        layers[name].sort(key=lambda feature: (feature.osm_type, feature.osm_id, feature.feature_id))

    graph = build_road_graph(ways, nodes, origin, port_ring, aoi)
    tile = ensure_tile(RAW_ELEVATION_DIR)
    values, size = read_hgt(tile)
    grid = clip_tile(values, size, aoi)
    print(f"[abu-samra] DEM {grid.rows} x {grid.cols} posts")
    cross = crosscheck(grid)
    dem_meta = write_dem(grid, origin, PROCESSED_DIR / "elevation", tile, cross)
    apply_elevations(graph, grid.sample)
    helipad_m = grid.sample(HELIPAD_LAT, HELIPAD_LON)

    _write_layers(layers, origin)
    _write_json(WGS84_DIR / "port_footprint.geojson", _footprint_collection(footprint, origin, "wgs84"))
    _write_json(LOCAL_DIR / "port_footprint.json", _footprint_collection(footprint, origin, "local"))
    _write_json(PROCESSED_DIR / "road_graph.json", graph)
    _write_json(
        PROCESSED_DIR / "turn_restrictions.json",
        {"count": len(restrictions), "restrictions": restrictions, "local_origin": origin.as_dict()},
    )
    _write_json(
        PROCESSED_DIR / "aoi.geojson",
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "name_en": "Abu Samra study area",
                        "margins_m": AOI_MARGINS_M,
                        "reason": (
                            "Port polygon plus Salwa Road approach toward Doha (north and east) "
                            "and the exit toward the border (south and west). "
                            "The Saudi Salwa post is outside this box."
                        ),
                    },
                    "geometry": {"type": "Polygon", "coordinates": [aoi.polygon()]},
                }
            ],
        },
    )
    _write_text(PROCESSED_DIR / "DATA_SOURCES.txt", _attribution())

    coverage = _coverage(layers, graph)
    manifest = {
        "site": SITE,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "port_footprint_source": seed_source,
        "aoi": aoi.as_dict(),
        "port_bbox": port_bbox.as_dict(),
        "margins_m": AOI_MARGINS_M,
        "local_origin": origin.as_dict(),
        "frame": {
            "geographic": "EPSG:4326",
            "projected": "EPSG:32639",
            "local": "EPSG:32639 meters translated so the port centroid is the origin",
            "axes": "x east, y north, elevation up. Not a Y-up 3D scene.",
        },
        "coverage": coverage,
        "elevation": {
            "rows": dem_meta["rows"],
            "cols": dem_meta["cols"],
            "stats": dem_meta["stats"],
            "helipad_sample_m": helipad_m,
            "helipad_published_m": 5,
            "open_meteo_crosscheck": cross,
            "path": "data/processed/elevation/dem.json",
        },
        "overpass_endpoints": raw.get("endpoints", []),
        "files": {
            "catalog": "data/processed/catalog.json",
            "road_graph": "data/processed/road_graph.json",
            "turn_restrictions": "data/processed/turn_restrictions.json",
            "port_footprint_local": "data/processed/local/port_footprint.json",
            "dem": "data/processed/elevation/dem.json",
        },
    }
    catalog = _catalog(layers, manifest)
    _write_json(PROCESSED_DIR / "manifest.json", manifest)
    _write_json(PROCESSED_DIR / "catalog.json", catalog)
    _print_summary(manifest)
    errors = validate()
    if errors:
        raise SystemExit(1)
    return manifest


def _load_seed(refresh: bool) -> tuple[dict, str]:
    path = RAW_OSM_DIR / "port_seed.json"
    if path.exists() and not refresh:
        print(f"[abu-samra] Reusing port seed {path}")
        return _read_json(path), "openstreetmap_cache"
    try:
        seed = fetch_port_seed()
    except OverpassError:
        if path.exists():
            print("[abu-samra] Overpass seed failed; using the cached port polygon")
            return _read_json(path), "openstreetmap_cache"
        print("[abu-samra] Overpass seed failed; using the surveyed fallback footprint")
        return _fallback_seed(), "fallback_survey_2026_10_30"
    _write_json(path, seed)
    return seed, "openstreetmap"


def _fallback_seed() -> dict:
    bbox = BBox(**FALLBACK_PORT_BBOX)
    ring = bbox.polygon()
    return {
        "type": "way",
        "id": PORT_OSM_WAY_ID,
        "tags": {
            "name": PORT_NAME_AR,
            "name:en": PORT_NAME_EN,
            "name:ar": PORT_NAME_AR,
            "barrier": "border_control",
            "highway": "services",
            "area": "yes",
        },
        "geometry": [{"lon": lon, "lat": lat} for lon, lat in ring],
    }


def _seed_ring(seed: dict) -> list[tuple[float, float]]:
    if seed.get("geometry"):
        coords = geom_coords_from_overpass(seed["geometry"])
    else:
        coords = []
    if len(coords) < 4:
        bbox = BBox(**FALLBACK_PORT_BBOX)
        coords = [(lon, lat) for lon, lat in bbox.polygon()]
    return close_ring(coords)


def _load_study_area(aoi: BBox, refresh: bool) -> dict:
    queries = {
        "movement": movement_query(aoi),
        "context": context_query(aoi),
        "boundaries": boundary_query(aoi),
    }
    token = hashlib.sha256(json.dumps(queries, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    meta_path = RAW_OSM_DIR / "fetch_meta.json"
    area_path = RAW_OSM_DIR / "study_area.json"
    if area_path.exists() and meta_path.exists() and not refresh:
        meta = _read_json(meta_path)
        if meta.get("query_hash") == token:
            print(f"[abu-samra] Reusing OSM download {area_path}")
            return _read_json(area_path)
    payload = fetch_study_area(aoi, cache_dir=RAW_OSM_DIR / "parts", refresh=refresh)
    saved = {"elements": payload["elements"], "endpoints": payload.get("endpoints", [])}
    _write_json(area_path, saved, indent=None)
    _write_json(
        meta_path,
        {"query_hash": token, "aoi": aoi.as_dict(), "queries": queries, "endpoints": payload.get("endpoints", [])},
    )
    return saved


def _ensure_port_footprint(layers, seed, port_ring, aoi, origin):
    existing = next((feature for feature in layers["checkpoints"] if feature.osm_id == PORT_OSM_WAY_ID), None)
    if existing:
        existing.extra["role"] = "port_extent"
        return existing
    clipped = clip_polygon(port_ring, aoi) or port_ring
    feature = _make_feature(
        f"way/{PORT_OSM_WAY_ID}",
        "way",
        PORT_OSM_WAY_ID,
        "Polygon",
        [clipped],
        seed.get("tags") or {},
        port_ring,
        origin,
        extra={"role": "port_extent"},
    )
    if feature is None:
        raise RuntimeError("Port footprint could not be built")
    layers["checkpoints"].append(feature)
    return feature


def _footprint_collection(feature, origin, frame: str) -> dict:
    payload = collection([feature], origin, frame, "checkpoints")
    payload["name"] = "port_footprint"
    payload["purpose"] = "Abu Samra Border Post extent. Use this polygon as the port mask."
    return payload


def _write_layers(layers, origin) -> None:
    for name in LAYERS:
        features = layers.get(name, [])
        _write_json(WGS84_DIR / f"{name}.geojson", collection(features, origin, "wgs84", name), indent=None)
        _write_json(LOCAL_DIR / f"{name}.json", collection(features, origin, "local", name), indent=None)
        print(f"[abu-samra] {name}: {len(features)} features")


def _coverage(layers, graph) -> dict:
    roads = layers["roads"]
    road_length = sum(feature.length_m or 0 for feature in roads)
    tagged_length = sum((feature.length_m or 0) for feature in roads if feature.tags.get("lanes"))
    inside_length = sum((feature.length_m or 0) for feature in roads if feature.inside_port)
    by_class: dict[str, float] = defaultdict(float)
    for feature in roads:
        by_class[str(feature.tags.get("highway"))] += feature.length_m or 0
    barriers = Counter(feature.tags.get("barrier", "unknown") for feature in layers["barriers"])
    names = sorted(
        {
            (
                feature.layer,
                feature.tags.get("name:en") or feature.tags.get("name"),
                feature.tags.get("name:ar"),
            )
            for group in layers.values()
            for feature in group
            if feature.tags.get("name")
        }
    )
    return {
        "roads": {
            "features": len(roads),
            "length_m": round(road_length, 1),
            "inside_port_length_m": round(inside_length, 1),
            "approach_length_m": round(road_length - inside_length, 1),
            "lanes_tagged_length_pct": round(100 * tagged_length / road_length, 1) if road_length else 0,
            "length_m_by_highway": {key: round(value, 1) for key, value in sorted(by_class.items())},
        },
        "road_graph": graph["stats"],
        "barriers": dict(barriers),
        "buildings": {
            "features": len(layers["buildings"]),
            "area_m2": round(sum(feature.area_m2 or 0 for feature in layers["buildings"]), 1),
        },
        "parking_features": len(layers["parking"]),
        "checkpoints": len(layers["checkpoints"]),
        "traffic_control": len(layers["traffic_control"]),
        "aeroway": len(layers["aeroway"]),
        "named_features": [
            {"layer": layer, "name_en": name_en, "name_ar": name_ar} for layer, name_en, name_ar in names
        ],
        "layer_counts": {name: len(layers[name]) for name in LAYERS},
    }


def _catalog(layers, manifest) -> dict:
    return {
        "site_id": SITE["id"],
        "ready_for": ["2d_map", "3d_terrain_and_road_network"],
        "not_included": [
            "surveyed building heights",
            "satellite imagery",
            "live traffic or vehicle positions",
            "the Saudi Salwa border post",
        ],
        "start_here": {
            "roads_local": "data/processed/local/roads.json",
            "port_footprint_local": "data/processed/local/port_footprint.json",
            "barriers_local": "data/processed/local/barriers.json",
            "road_graph": "data/processed/road_graph.json",
            "terrain": "data/processed/elevation/dem.json",
            "terrain_csv": "data/processed/elevation/dem_posts.csv",
            "loader": "from abu_samra.loaders import load_layer, load_road_graph, load_dem, iter_dem_posts",
        },
        "frame": manifest["frame"],
        "local_origin": manifest["local_origin"],
        "lane_policy": (
            "Draw one ribbon per road way. lanes is null when OpenStreetMap did not tag a count."
        ),
        "layers": {
            name: {
                "purpose": LAYER_PURPOSE[name],
                "features": len(layers[name]),
                "wgs84": f"data/processed/wgs84/{name}.geojson",
                "local": f"data/processed/local/{name}.json",
            }
            for name in LAYERS
        },
    }


def _attribution() -> str:
    return "\n".join(
        [
            "Abu Samra customs port — data sources",
            "",
            "Map data © OpenStreetMap contributors, licensed under ODbL.",
            "https://www.openstreetmap.org/copyright",
            "",
            "Elevation: SRTM 1 arc-second tile N24E050.",
            "SRTM is US public-domain data, fetched from the public elevation-tiles-prod S3 bucket.",
            "Elevations are orthometric meters (EGM96), not a building survey.",
            "",
            "A few elevations are compared with the keyless Open-Meteo elevation API.",
            "",
            "This dataset is a geometric foundation for a later 2D/3D model.",
            "It does not include surveyed building dimensions.",
            "",
        ]
    )


def _print_summary(manifest: dict) -> None:
    roads = manifest["coverage"]["roads"]
    elevation = manifest["elevation"]["stats"]
    print("[abu-samra] dataset ready")
    print(f"  roads: {roads['features']} features, {roads['length_m']} m")
    print(f"  inside port: {roads['inside_port_length_m']} m")
    print(f"  lanes tagged: {roads['lanes_tagged_length_pct']}% of length")
    print(
        "  terrain: "
        f"{elevation['min_m']} to {elevation['max_m']} m, mean {elevation['mean_m']} m"
    )
    print(f"  catalog: {ROOT / 'data' / 'processed' / 'catalog.json'}")


def _read_json(path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path, payload, indent: int | None = 2) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=indent), encoding="utf-8")


def _write_text(path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# Imported so a caller can see where the dataset lands.
OUTPUT_DIR = DATA_DIR
