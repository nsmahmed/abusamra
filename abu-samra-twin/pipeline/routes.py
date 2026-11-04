"""Hand-traced road centrelines and parking-lot frames for both flows -> assets/geo.json.

Run from pipeline/work:  python ../routes.py   (writes routes_vis.jpg for checking)
Waypoints (mosaic px) were digitised on zoom2.py grids, following the GAC trip diagrams in data/map-details
(note: "import trip.png" shows the EXPORT flow and "export trip.png" the IMPORT flow). Each route is
Chaikin-smoothed and resampled to ~5 px. Stage anchors are given as coordinates and snapped to the nearest
vertex; `exit` anchors are where trucks rejoin the route after leaving an off-route lot.

Lot frames (`lot`): o = corner of the slot grid, e = direction along a row (bay to bay), r = row-to-row
direction, rows x bays with pitches in mosaic px; `entry`/`exit` points sit on the lot's internal road.
Trucks drive entry -> row aisle -> bay and leave bay -> next aisle -> exit (see app.js lotSlots()).
"""
import cv2, numpy as np, json, os
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")

IMPORT = [(-500, 3690), (40, 3430), (150, 3378), (250, 3328), (305, 3305), (355, 3292), (410, 3300), (460, 3328),
          (500, 3358), (545, 3395), (600, 3440), (660, 3475), (720, 3498), (800, 3510), (880, 3510), (950, 3494),
          (1010, 3462), (1070, 3412), (1130, 3360), (1190, 3305), (1250, 3250), (1310, 3195), (1370, 3140),
          (1430, 3085), (1490, 3030), (1545, 2980), (1590, 2940), (1600, 2900), (1535, 2824), (1470, 2748),
          (1404, 2673), (1385, 2668), (1330, 2712), (1270, 2762), (1210, 2812), (1150, 2842), (1098, 2830),
          (1066, 2792), (1068, 2738), (1108, 2692), (1170, 2640), (1230, 2585), (1295, 2525), (1363, 2449),
          (1400, 2405), (1428, 2355), (1462, 2312), (1520, 2292), (1580, 2290), (1640, 2300), (1700, 2322),
          (1755, 2362), (1810, 2412), (1860, 2446), (1915, 2452), (1948, 2420), (1958, 2345), (2000, 2290),
          (2060, 2228), (2110, 2175), (2150, 2140), (2200, 2160), (2260, 2215), (2310, 2265), (2318, 2300),
          (2280, 2345), (2220, 2400), (2160, 2455), (2110, 2500), (2070, 2522), (2020, 2500), (1980, 2478),
          (1962, 2520), (1961, 2600), (1959, 2700), (1957, 2800), (1955, 2900), (1950, 3100), (1945, 3400)]
IMPORT_ST = {"road": (430, 3312), "rad": (505, 3362), "hold": (600, 3440), "hold.exit": (650, 3470), "appt": (730, 3500),
             "park": (1600, 2900), "park.exit": (1404, 2673), "xray": (1363, 2449), "ramps": (1958, 2345),
             "ramps.exit": (2070, 2522), "rel": (1975, 2490)}
IMPORT_OP = (1600, 2900)
IMPORT_LOTS = {
    # proposed holding area in the unused south-west lot (100 bays by default)
    "hold": dict(o=(752, 3402), e=(0.848, -0.530), r=(-0.530, -0.848), rows=6, bays=24, rowPitch=40, bayPitch=5.8,
                 entry=(640, 3440), exit=(680, 3465), head="r", poly=[[726, 3479], [1316, 3110], [1010, 2784], [474, 3216]]),
}
IMPORT_LABEL = {"road": (300, 3250), "rad": (480, 3300), "hold": (850, 3250), "appt": (760, 3460), "park": (1560, 2700),
                "xray": (1330, 2400), "ramps": (2200, 2180), "rel": (1930, 2520)}

# Export, re-traced 2026-11 on measured carriageway centres (dark-run profiles of best_mosaic.png):
# the access road west of the external lot is two-way (inbound NW-bound, outbound SE-bound on the same centreline);
# after the junction trucks take the west carriageway of the dual road (right-hand traffic) down to the E-W road.
EXPORT = [(3300, 100), (3050, 430), (2850, 693), (2739, 839), (2640, 970), (2575, 1055), (2530, 1085), (2490, 1068),
          (2450, 1066), (2418, 1078), (2385, 1048), (2350, 1003), (2318, 958), (2292, 918), (2272, 880), (2267, 850),
          (2255, 820), (2239, 790), (2218, 760), (2212, 735), (2240, 700), (2300, 672), (2372, 642), (2380, 625), (2350, 560),
          (2310, 470), (2270, 380), (2252, 345), (2200, 350), (2130, 357), (2080, 363), (2045, 378), (2015, 398),
          (1994, 425), (1993, 450), (2006, 475), (2025, 505), (2047, 535), (2068, 565), (2090, 595), (2112, 625),
          (2135, 655), (2158, 685), (2180, 715), (2203, 745), (2222, 775), (2240, 805), (2254, 835), (2262, 862),
          (2252, 886), (2228, 902), (2203, 916), (2176, 935), (2142, 960), (2108, 985), (2074, 1010), (2040, 1035),
          (2005, 1060), (1971, 1085), (1937, 1110), (1904, 1135), (1871, 1160), (1845, 1185), (1826, 1210),
          (1811, 1235), (1800, 1260), (1790, 1285), (1782, 1312), (1780, 1340), (1778, 1370), (1770, 1400),
          (1760, 1430), (1748, 1456), (1730, 1474), (1700, 1490), (1665, 1505), (1632, 1519), (1606, 1532),
          (1585, 1546), (1563, 1540), (1540, 1517), (1518, 1495), (1495, 1488), (1470, 1500), (1452, 1520),
          (1436, 1545), (1428, 1572), (1435, 1595), (1420, 1615), (1400, 1645), (1385, 1680),
          (1365, 1725), (1340, 1775), (1300, 1840), (1250, 1910), (1150, 2050), (1000, 2280), (850, 2500)]
EXPORT_ST = {"road": (2239, 790), "ext": (2240, 700), "ext.exit": (2015, 398), "permit": (1994, 440), "entry": (2190, 926),
             "park": (1700, 1490), "park.exit": (1606, 1532), "ramps": (1563, 1540), "ramps.exit": (1420, 1615), "rel": (1395, 1660)}
EXPORT_OP = (2190, 926)
# operational parking: the apron south of the kerb, between the road and the export inspection compound (the lot
# where the imagery shows trucks waiting). Trucks stand perpendicular to the kerb, two rows of 12; they enter from the
# kerb-side strip at the north-east end and leave at the south-west end, next to the compound gate.
_K = (0.920, -0.390); _R = (0.390, 0.920)
EXPORT_LOTS = {
    "ext": dict(o=(2236, 666), e=(-0.400, -0.917), r=(0.925, -0.379), rows=4, bays=56, rowPitch=40, bayPitch=5.8,
                entry=(2245, 690), exit=(2085, 372), head="r", poly=[[2065, 345], [2255, 322], [2400, 632], [2222, 705]]),
    "park": dict(o=(1606, 1540), e=_K, r=_R, rows=2, bays=12, rowPitch=32, bayPitch=5.8,
                 entry=(1690, 1491), exit=(1590, 1535), head="r",
                 poly=[[1604, 1538], [1672, 1510], [1696, 1568], [1628, 1597]]),
}
EXPORT_LABEL = {"road": (2330, 1010), "ext": (2330, 430), "permit": (1935, 440), "entry": (2150, 900), "park": (1700, 1600),
                "ramps": (1470, 1480), "rel": (1330, 1650)}


def smooth(P, it=3, step=5.0):
    P = np.float64(P)
    for _ in range(it):
        Q = [P[0]]
        for a, b in zip(P[:-1], P[1:]): Q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        Q.append(P[-1]); P = np.array(Q)
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]; n = max(2, int(d[-1] / step))
    t = np.linspace(0, d[-1], n); return np.stack([np.interp(t, d, P[:, 0]), np.interp(t, d, P[:, 1])], 1)


g = json.load(open(os.path.join(A, "geo.json"), encoding="utf-8"))
vis = cv2.resize(cv2.imread("best_mosaic.png"), None, fx=0.5, fy=0.5) if os.path.exists("best_mosaic.png") else None
for f, pts, ST, OP, LOTS, LBL, col in (("import", IMPORT, IMPORT_ST, IMPORT_OP, IMPORT_LOTS, IMPORT_LABEL, (0, 200, 255)),
                                       ("export", EXPORT, EXPORT_ST, EXPORT_OP, EXPORT_LOTS, EXPORT_LABEL, (255, 60, 255))):
    P = smooth(pts)
    def near(p, lo=0):  # anchors are snapped in route order, so a road used twice (export access road) resolves correctly
        return lo + int(np.argmin(np.linalg.norm(P[lo:] - np.float64(p), axis=1)))
    G = g[f]; G["path"] = P.round(1).tolist(); lo = 0; opk = None
    for k, xy in ST.items():
        i = near(xy, lo); lo = i
        if tuple(xy) == tuple(OP) and opk is None: opk = i
        if "." in k:
            s, fld = k.split("."); G["st"][s][fld + "Idx"] = i
        else:
            G["st"][k]["idx"] = i
    G["opStart"] = opk if opk is not None else near(OP)
    for k, L in LOTS.items():
        G["st"][k].update({"layout": "lot", "lot": {kk: (list(v) if isinstance(v, tuple) else v) for kk, v in L.items()}})
        for stale in ("poly", "polys", "from", "to", "side", "fromIdx", "toIdx"): G["st"][k].pop(stale, None)
    G["label"] = {k: list(v) for k, v in LBL.items()}
    for k in ("path_src", "st_src", "opStart_src"): G.pop(k, None)
    print(f, len(P), "vertices", {k: G["st"][k]["idx"] for k in ST if "." not in k})
    if vis is not None:
        cv2.polylines(vis, [(P * 0.5).astype(np.int32)], False, col, 2, cv2.LINE_AA)
        for k, xy in ST.items(): cv2.putText(vis, k, (int(xy[0] * 0.5) + 4, int(xy[1] * 0.5)), 0, 0.5, (0, 0, 255), 2)
        for k, L in LOTS.items():
            o, e, r = np.float64(L["o"]), np.float64(L["e"]), np.float64(L["r"])
            for a in range(L["rows"]):
                p0 = o + r * a * L["rowPitch"]; p1 = p0 + e * L["bays"] * L["bayPitch"]
                cv2.line(vis, tuple((p0 * 0.5).astype(int)), tuple((p1 * 0.5).astype(int)), (0, 255, 0), 1)
# the main import lot keeps its fitted bay lattice; record its entry/exit on the internal aisle network
g["import"]["st"]["park"].update({"entry": [1600, 2900], "exit": [1404, 2673]})
json.dump(g, open(os.path.join(A, "geo.json"), "w", encoding="utf-8"), separators=(",", ":"))
if vis is not None: cv2.imwrite("routes_vis.jpg", vis)
