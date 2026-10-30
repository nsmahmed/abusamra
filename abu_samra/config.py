"""Study area and source settings for the Abu Samra customs port dataset.

Abu Samra is Qatar's land border port with Saudi Arabia, on Salwa Road in
Al Rayyan. The General Authority of Customs operates it 24 hours a day.
The Saudi post at Salwa is a different facility, about 8 km southwest, and
is outside this study area.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
RAW_OSM_DIR = DATA_DIR / "raw" / "osm"
RAW_ELEVATION_DIR = DATA_DIR / "raw" / "elevation"
PROCESSED_DIR = DATA_DIR / "processed"
WGS84_DIR = PROCESSED_DIR / "wgs84"
LOCAL_DIR = PROCESSED_DIR / "local"

USER_AGENT = "MalCust-AbuSamra-DigitalTwin/1.0 (Qatar customs port mapping; educational)"

# OpenStreetMap way for "منفذ أبو سمرة الحدودي" / Abu Samra Border Post.
# Surveyed on 2026-10-30. The fetch also falls back to a name search.
PORT_OSM_WAY_ID = 1456475677
PORT_NAME_EN = "Abu Samra Border Post"
PORT_NAME_AR = "منفذ أبو سمرة الحدودي"

# Measured extent of that way, used only if the live Overpass seed fails.
FALLBACK_PORT_BBOX = {
    "south": 24.7338092,
    "west": 50.8333185,
    "north": 24.7492074,
    "east": 50.8514724,
}

# Meters added around the port polygon. North and east follow Salwa Road
# toward Doha (the arrival queue). South and west follow the exit toward
# the border without reaching the Saudi Salwa post.
AOI_MARGINS_M = {
    "south": 1000,
    "west": 1400,
    "north": 2600,
    "east": 2200,
}

# Salwa Road at the port is in UTM zone 39N.
UTM_ZONE = 39
UTM_EPSG = 32639

OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
)

# SRTM 1 arc-second tile whose southwest corner is 24N, 50E.
# US public-domain SRTM, from the public elevation-tiles-prod bucket.
SRTM_TILE_NAME = "N24E050"
SRTM_URLS = (
    "https://elevation-tiles-prod.s3.amazonaws.com/skadi/N24/N24E050.hgt.gz",
    "https://s3.amazonaws.com/elevation-tiles-prod/skadi/N24/N24E050.hgt.gz",
)
SRTM_SOUTHWEST = (24, 50)
ELEVATION_CROSSCHECK_URL = "https://api.open-meteo.com/v1/elevation"

SITE = {
    "id": "abu-samra-border-post",
    "name_en": PORT_NAME_EN,
    "name_ar": PORT_NAME_AR,
    "kind": "land_border_customs_port",
    "country": "Qatar",
    "municipality": "Al Rayyan",
    "road": "Salwa Road",
    "operator": "Qatar General Authority of Customs",
    "operator_ar": "الهيئة العامة للجمارك",
    "hours": "24 hours, 7 days",
    "paired_crossing": {
        "name_en": "Salwa Border Post",
        "name_ar": "منفذ سلوى",
        "country": "Saudi Arabia",
        "note": "About 8 km southwest of Abu Samra. Not included in this dataset.",
    },
    "osm_way_id": PORT_OSM_WAY_ID,
    "references": [
        "https://www.openstreetmap.org/way/1456475677",
        "https://www.customs.gov.qa/English/Contact/Pages/Contact-Numbers.aspx",
        "https://en.wikipedia.org/wiki/Abu_Samra",
    ],
}

# Draw order is not important. Priority during classification is the order
# in osm_model.classify, which picks a single layer per feature.
LAYER_PURPOSE = {
    "checkpoints": (
        "Customs and border-control extent, plus customs or immigration offices. "
        "The Abu Samra Border Post polygon is the port footprint."
    ),
    "barriers": (
        "Walls, fences, gates, blocks, and booths that constrain vehicle movement."
    ),
    "roads": (
        "Linear roads, including each mapped Salwa Road carriageway through the port "
        "and the approach and exit. One way is one drawn carriageway, not a guess at lane count."
    ),
    "road_areas": "Road or service-area polygons.",
    "traffic_control": "Signals, stop and give-way points, and crossings.",
    "parking": "Parking and vehicle holding areas.",
    "buildings": "Building footprints for context. Heights are not surveyed.",
    "facilities": "Support sites such as fuel, offices, weighbridges, and toilets.",
    "landuse": "Mapped ground cover around the roads.",
    "natural": "Natural cover such as sand or water.",
    "aeroway": "Airside features, including the border-post helipad.",
    "boundaries": "Administrative or border lines that cross the study area.",
    "places": "Place names.",
    "other": "Remaining tagged features, kept so mapped detail is not dropped.",
}

LAYERS = tuple(LAYER_PURPOSE)

NON_VEHICLE_HIGHWAYS = frozenset(
    {"footway", "pedestrian", "steps", "path", "cycleway", "bridleway", "corridor"}
)
