"""Checks that the fetched dataset is usable by a later 2D/3D model."""

from __future__ import annotations

import json
from pathlib import Path

from abu_samra.config import LAYERS, LOCAL_DIR, PROCESSED_DIR, WGS84_DIR


def _load(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(path)
    return json.loads(path.read_text(encoding="utf-8"))


def _names(collection: dict) -> str:
    chunks = []
    for feature in collection.get("features", []):
        props = feature.get("properties") or {}
        chunks.append(" ".join(str(props.get(key) or "") for key in ("name", "name_en", "name_ar")))
    return " ".join(chunks)


def validate() -> list[str]:
    errors: list[str] = []
    warnings: list[str] = []
    manifest_path = PROCESSED_DIR / "manifest.json"
    if not manifest_path.exists():
        return ["missing data/processed/manifest.json; run: python -m abu_samra fetch"]
    manifest = _load(manifest_path)

    for name in LAYERS:
        wgs = WGS84_DIR / f"{name}.geojson"
        local = LOCAL_DIR / f"{name}.json"
        if not wgs.exists() or not local.exists():
            errors.append(f"missing layer files for {name}")
            continue
        wgs_data = _load(wgs)
        local_data = _load(local)
        if len(wgs_data.get("features", [])) != len(local_data.get("features", [])):
            errors.append(f"{name} WGS84 and local feature counts differ")
        for feature in local_data.get("features", []):
            flat = json.dumps(feature["geometry"]["coordinates"])
            if "NaN" in flat or "Infinity" in flat:
                errors.append(f"{name} has a non-finite coordinate")
                break
            coords = feature["geometry"]["coordinates"]
            sample = _first_xy(coords)
            if sample and (abs(sample[0]) > 20000 or abs(sample[1]) > 20000):
                errors.append(f"{name} local coordinates are not relative to the port origin")
                break

    footprint = LOCAL_DIR / "port_footprint.json"
    if not footprint.exists():
        errors.append("missing port footprint")
    else:
        text = _names(_load(footprint))
        if "Abu Samra" not in text and "سمرة" not in text:
            errors.append("port footprint does not carry the Abu Samra name")

    roads = _load(LOCAL_DIR / "roads.json") if (LOCAL_DIR / "roads.json").exists() else {"features": []}
    if len(roads.get("features", [])) < 10:
        errors.append(f"expected at least 10 road features, found {len(roads.get('features', []))}")
    road_names = _names(roads)
    if "Salwa" not in road_names and "سلوى" not in road_names:
        errors.append("Salwa Road was not found in the roads layer")

    graph_path = PROCESSED_DIR / "road_graph.json"
    if not graph_path.exists():
        errors.append("missing road graph")
    else:
        graph = _load(graph_path)
        if len(graph.get("edges", [])) < 10:
            errors.append("road graph has fewer than 10 edges")
        if not graph.get("nodes"):
            errors.append("road graph has no nodes")

    dem_path = PROCESSED_DIR / "elevation" / "dem.json"
    if not dem_path.exists():
        errors.append("missing DEM")
    else:
        dem = _load(dem_path)
        stats = dem.get("stats") or {}
        if dem.get("rows", 0) < 10 or dem.get("cols", 0) < 10:
            errors.append("DEM grid is too small")
        minimum = stats.get("min_m")
        maximum = stats.get("max_m")
        if minimum is None or maximum is None or not (-20 <= minimum <= maximum <= 200):
            errors.append(f"DEM elevations look wrong: min={minimum} max={maximum}")
        if minimum == maximum:
            errors.append("DEM is a single flat value")

    checkpoints = _load(LOCAL_DIR / "checkpoints.json") if (LOCAL_DIR / "checkpoints.json").exists() else {"features": []}
    if not checkpoints.get("features"):
        errors.append("checkpoints layer is empty; the border post polygon should be here")

    for name in ("parking", "buildings", "barriers"):
        path = LOCAL_DIR / f"{name}.json"
        if path.exists() and not _load(path).get("features"):
            warnings.append(f"{name} layer is empty in OpenStreetMap for this area")

    coverage = manifest.get("coverage") or {}
    lanes_pct = coverage.get("roads", {}).get("lanes_tagged_length_pct")
    if lanes_pct is not None and lanes_pct < 50:
        warnings.append(
            f"only {lanes_pct}% of road length has an explicit lanes tag; "
            "untagged ways must be drawn as one carriageway each"
        )

    print("[abu-samra] validation")
    for warning in warnings:
        print(f"  warning: {warning}")
    if errors:
        for error in errors:
            print(f"  error: {error}")
    else:
        roads_n = len(roads.get("features", []))
        print(f"  ok: {roads_n} road features, DEM {manifest.get('elevation', {}).get('rows')} rows")
    return errors


def _first_xy(coordinates):
    if not coordinates:
        return None
    if isinstance(coordinates[0], (int, float)):
        return coordinates
    return _first_xy(coordinates[0])
