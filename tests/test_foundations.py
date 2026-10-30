"""Geometry, classification, and road-graph tests. No network."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from abu_samra.elevation import DemGrid
from abu_samra.geo import (
    BBox,
    clip_linestring,
    clip_polygon,
    expand_bbox,
    local_xy,
    make_origin,
    point_in_ring,
    polyline_length_m,
    wgs84_to_utm,
)
from abu_samra.osm_model import classify, parse_lanes
from abu_samra.road_graph import build_road_graph


class GeoTests(unittest.TestCase):
    def test_central_meridian_easting(self):
        easting, _northing = wgs84_to_utm(24.7415083, 51.0, zone=39)
        self.assertEqual(39, int((51.0 + 180) / 6) + 1)
        self.assertAlmostEqual(500000.0, easting, delta=0.05)

    def test_local_distance_matches_a_degree_of_latitude(self):
        origin = make_origin(24.74, 50.84)
        length = polyline_length_m([(50.84, 24.74), (50.84, 24.75)], origin)
        self.assertAlmostEqual(1107.3, length, delta=1.0)
        x0, y0 = local_xy(24.74, 50.84, origin)
        self.assertAlmostEqual(0.0, x0, delta=0.01)
        self.assertAlmostEqual(0.0, y0, delta=0.01)

    def test_expand_bbox_grows_on_every_side(self):
        bbox = BBox(24.73, 50.83, 24.75, 50.85)
        wider = expand_bbox(bbox, {"south": 1000, "west": 1000, "north": 2000, "east": 2000})
        self.assertLess(wider.south, bbox.south)
        self.assertLess(wider.west, bbox.west)
        self.assertGreater(wider.north, bbox.north)
        self.assertGreater(wider.east, bbox.east)

    def test_clip_linestring_keeps_the_inside_portion(self):
        bbox = BBox(0, 0, 1, 1)
        parts = clip_linestring([(-1, 0.5), (2, 0.5)], bbox)
        self.assertEqual(1, len(parts))
        self.assertAlmostEqual(0.0, parts[0][0][0])
        self.assertAlmostEqual(1.0, parts[0][-1][0])

    def test_clip_polygon_drops_an_outside_ring(self):
        bbox = BBox(0, 0, 1, 1)
        self.assertEqual([], clip_polygon([(2, 2), (3, 2), (3, 3), (2, 2)], bbox))

    def test_point_in_ring(self):
        ring = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)]
        self.assertTrue(point_in_ring(0.5, 0.5, ring))
        self.assertFalse(point_in_ring(1.5, 0.5, ring))


class LayerTests(unittest.TestCase):
    def test_border_post_is_a_checkpoint_area(self):
        tags = {"barrier": "border_control", "highway": "services", "area": "yes", "name:en": "Abu Samra Border Post"}
        self.assertEqual("checkpoints", classify(tags, "polygon"))

    def test_untagged_lanes_stay_unknown(self):
        lanes, tagged = parse_lanes({"highway": "trunk", "oneway": "yes"})
        self.assertIsNone(lanes)
        self.assertFalse(tagged)

    def test_gate_is_a_barrier(self):
        self.assertEqual("barriers", classify({"barrier": "gate"}, "point"))

    def test_road_graph_splits_at_the_shared_node_and_does_not_invent_lanes(self):
        origin = make_origin(24.74, 50.84)
        nodes = {
            1: {"id": 1, "lat": 24.740, "lon": 50.840},
            2: {"id": 2, "lat": 24.741, "lon": 50.841},
            3: {"id": 3, "lat": 24.742, "lon": 50.842},
            4: {"id": 4, "lat": 24.742, "lon": 50.844},
        }
        ways = {
            10: {"id": 10, "nodes": [1, 2, 3], "tags": {"highway": "trunk", "name:en": "Salwa Road", "oneway": "yes"}},
            11: {"id": 11, "nodes": [3, 4], "tags": {"highway": "service", "oneway": "no"}},
        }
        graph = build_road_graph(ways, nodes, origin, None)
        self.assertEqual(1, sum(1 for edge in graph["edges"] if edge["osm_way_id"] == 10))
        self.assertEqual(2, sum(1 for edge in graph["edges"] if edge["osm_way_id"] == 11))
        self.assertTrue(all(edge["lanes"] is None for edge in graph["edges"]))
        self.assertGreater(graph["stats"]["vehicle_centerline_m"], 0)

    def test_road_graph_is_clipped_to_the_study_area(self):
        origin = make_origin(24.74, 50.84)
        nodes = {
            1: {"id": 1, "lat": 24.740, "lon": 50.840},
            2: {"id": 2, "lat": 25.200, "lon": 51.200},
        }
        ways = {10: {"id": 10, "nodes": [1, 2], "tags": {"highway": "trunk", "oneway": "yes"}}}
        aoi = BBox(24.73, 50.83, 24.75, 50.85)
        graph = build_road_graph(ways, nodes, origin, None, aoi)
        self.assertEqual(1, len(graph["edges"]))
        self.assertLess(graph["stats"]["vehicle_centerline_m"], 4000)
        for edge in graph["edges"]:
            for lon, lat in edge["coordinates"]:
                self.assertGreaterEqual(lat, aoi.south - 1e-6)
                self.assertLessEqual(lat, aoi.north + 1e-6)
                self.assertGreaterEqual(lon, aoi.west - 1e-6)
                self.assertLessEqual(lon, aoi.east + 1e-6)


class DemTests(unittest.TestCase):
    def test_bilinear_sample(self):
        grid = DemGrid(
            lat_by_row=[1.0, 0.0],
            lon_by_col=[10.0, 11.0],
            elevation_m=[0.0, 10.0, 0.0, 10.0],
        )
        self.assertAlmostEqual(5.0, grid.sample(0.5, 10.5), delta=0.01)
        self.assertIsNone(grid.sample(2.0, 10.0))


if __name__ == "__main__":
    unittest.main()
