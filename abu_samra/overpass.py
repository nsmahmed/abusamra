"""OpenStreetMap download through the public Overpass API. No API key."""

from __future__ import annotations

import hashlib
import json
import time

from abu_samra.config import OVERPASS_ENDPOINTS, PORT_NAME_EN, PORT_OSM_WAY_ID
from abu_samra.geo import BBox
from abu_samra.http_util import post_form


class OverpassError(RuntimeError):
    pass


def _interpret(query: str, timeout: float = 150) -> dict:
    errors: list[str] = []
    for round_index in range(3):
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                print(f"[abu-samra] Overpass query via {endpoint}")
                raw = post_form(endpoint, {"data": query}, timeout=timeout, attempts=1)
            except Exception as exc:  # network or HTTP, try the next mirror
                errors.append(f"{endpoint}: {exc}")
                print(f"[abu-samra] Overpass mirror failed: {exc}")
                continue
            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError as exc:
                errors.append(f"{endpoint}: invalid JSON ({exc})")
                continue
            if payload.get("remark") and not payload.get("elements"):
                errors.append(f"{endpoint}: {payload['remark']}")
                print(f"[abu-samra] Overpass remark: {payload['remark']}")
                continue
            payload["_endpoint"] = endpoint
            return payload
        if round_index < 2:
            delay = 8 * (round_index + 1)
            print(f"[abu-samra] Overpass mirrors failed this round; waiting {delay}s")
            time.sleep(delay)
    raise OverpassError("All Overpass mirrors failed. " + " | ".join(errors[-6:]))


def fetch_port_seed() -> dict:
    """Return the Abu Samra Border Post way, with geometry inline."""
    queries = (
        f"[out:json][timeout:90];way({PORT_OSM_WAY_ID});out geom meta;",
        (
            f'[out:json][timeout:90];way["barrier"="border_control"]'
            f'["name:en"="{PORT_NAME_EN}"];out geom meta;'
        ),
    )
    last_error: Exception | None = None
    for query in queries:
        try:
            payload = _interpret(query, timeout=120)
        except OverpassError as exc:
            last_error = exc
            continue
        ways = [element for element in payload.get("elements", []) if element.get("type") == "way"]
        if ways:
            ways.sort(key=lambda element: element.get("id") != PORT_OSM_WAY_ID)
            return ways[0]
    raise OverpassError(f"Could not find the Abu Samra Border Post way. {last_error}")


def movement_query(bbox: BBox) -> str:
    box = bbox.overpass()
    selectors = "\n".join(
        [
            f'  way{box}["highway"];',
            f'  way{box}["area:highway"];',
            f'  way{box}["barrier"];',
            f'  node{box}["highway"];',
            f'  node{box}["barrier"];',
            f'  node{box}["entrance"];',
            f'  node{box}["traffic_calming"];',
            f'  node{box}["crossing"];',
            f'  relation{box}["type"="restriction"];',
        ]
    )
    return f"[out:json][timeout:180];\n(\n{selectors}\n);\nout body meta;\n>;\nout skel qt;"


def context_query(bbox: BBox) -> str:
    box = bbox.overpass()
    way_keys = (
        "building",
        "landuse",
        "natural",
        "leisure",
        "amenity",
        "man_made",
        "aeroway",
        "office",
        "military",
        "waterway",
        "place",
        "railway",
        "government",
    )
    node_keys = ("amenity", "office", "man_made", "place", "aeroway", "military", "government", "shop")
    relation_keys = ("building", "landuse", "amenity", "man_made", "barrier")
    lines = [f'  way{box}["{key}"];' for key in way_keys]
    lines += [f'  node{box}["{key}"];' for key in node_keys]
    lines += [f'  relation{box}["{key}"];' for key in relation_keys]
    selectors = "\n".join(lines)
    return f"[out:json][timeout:180];\n(\n{selectors}\n);\nout body meta;\n>;\nout skel qt;"


def boundary_query(bbox: BBox) -> str:
    box = bbox.overpass()
    return (
        f"[out:json][timeout:120];\n(\n  way{box}[\"boundary\"];\n);\n"
        "out body meta;\n>;\nout skel qt;"
    )


def fetch_study_area(bbox: BBox, cache_dir=None, refresh: bool = False) -> dict:
    """Download tagged map features in the study area and merge the responses.

    Each query is cached on disk so a later mirror failure does not discard
    the parts that already succeeded.
    """
    queries = {
        "movement": movement_query(bbox),
        "context": context_query(bbox),
        "boundaries": boundary_query(bbox),
    }
    merged: list[dict] = []
    endpoints: list[str] = []
    for name, query in queries.items():
        payload = _cached_query(name, query, cache_dir, refresh)
        elements = payload.get("elements", [])
        print(f"[abu-samra] {name}: {len(elements)} OSM elements")
        merged.extend(elements)
        endpoints.append(payload.get("_endpoint", ""))
        time.sleep(3)
    return {"elements": merged, "endpoints": endpoints, "queries": queries}


def _cached_query(name: str, query: str, cache_dir, refresh: bool) -> dict:
    token = hashlib.sha256(query.encode("utf-8")).hexdigest()[:16]
    path = None if cache_dir is None else cache_dir / f"{name}.json"
    if path is not None and path.exists() and not refresh:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("query_hash") == token:
            print(f"[abu-samra] Reusing OSM {name} download")
            cached["_endpoint"] = cached.get("endpoint", "cache")
            return cached
    payload = _interpret(query)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "query_hash": token,
                    "endpoint": payload.get("_endpoint"),
                    "elements": payload.get("elements", []),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
    return payload
