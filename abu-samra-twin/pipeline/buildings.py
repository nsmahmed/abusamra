"""Curated building footprints, refined against the high-res composite, written into assets/geo.json.

Run from pipeline/work after ground.py (needs hr_full.png from the composite step in README):
    python ../buildings.py
Each seed: centre (mosaic px), long side L, short side W (mosaic px), angle of the long side (deg, image frame),
height (m), kind (shed | bld | canopy | tower), optional role (ramps_import / ramps_export) and refine flag.
Refinement grows a colour region from the centre on the composite and fits a rectangle; when the fit disagrees
with the seed size by more than ~40 % the hand-measured seed is kept.
"""
import cv2, numpy as np, json, os
import lotclean
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
S = 1.38
HR = cv2.imread("hr_full.png")
LAB = cv2.cvtColor(HR, cv2.COLOR_BGR2LAB).astype(np.float32)

SEEDS = [
    # inspection yard (import ramps): three sheds with dock doors on both long sides
    dict(c=(2200, 2225), L=181, W=55, a=46, h=12, k="shed", role="ramps_import", refine=True),
    dict(c=(2117, 2306), L=181, W=55, a=46, h=12, k="shed", role="ramps_import", refine=True),
    dict(c=(2061, 2423), L=94, W=49, a=46, h=11, k="shed", role="ramps_import", refine=True),
    # export inspection building in its walled yard
    dict(c=(1500, 1561), L=81, W=50, a=53, h=10, k="shed", role="ramps_export", refine=True),
    # yard support buildings
    dict(c=(2066, 2112), L=130, W=46, a=-42, h=10, k="bld", refine=True),
    dict(c=(1983, 2200), L=60, W=40, a=-44, h=8, k="bld"),
    dict(c=(2164, 2067), L=50, W=30, a=46, h=7, k="bld"),
    # central customs area: two large inspection canopies over the lanes
    dict(c=(1611, 1885), L=74, W=73, a=-46, h=10, k="canopy", refine=True),
    dict(c=(1724, 1997), L=73, W=68, a=46, h=10, k="canopy", refine=True),
    # main administration block, customs hall, tower
    dict(c=(1855, 1869), L=84, W=70, a=-41, h=14, k="bld"),
    dict(c=(1722, 1902), L=100, W=28, a=-42, h=10, k="bld"),
    dict(c=(1803, 1810), L=40, W=30, a=-42, h=18, k="tower"),
    # two long lane canopies (passenger/light vehicle booths)
    dict(c=(1644, 1740), L=217, W=14, a=-44.2, h=6, k="canopy"),
    dict(c=(1649, 1761), L=239, W=14, a=-44.2, h=6, k="canopy"),
    # gate canopies
    dict(c=(1534, 1692), L=92, W=14, a=43, h=7, k="canopy"),
    dict(c=(2116, 1685), L=50, W=43, a=90, h=8, k="canopy", refine=True),
    # east side offices
    dict(c=(2082, 1850), L=55, W=40, a=-38, h=9, k="bld"),
    dict(c=(1992, 1834), L=90, W=22, a=-40, h=9, k="bld"),
    dict(c=(1976, 1908), L=45, W=35, a=-40, h=8, k="bld"),
    # twin rotunda buildings (north and south of the plaza)
    dict(c=(1816, 1607), L=62, W=22, a=0, h=10, k="bld", dome=True),
    dict(c=(1661, 2147), L=65, W=25, a=0, h=10, k="bld", dome=True),
    # X-ray area: pyramid shade, canopy, scanning halls
    dict(c=(1869, 2147), L=80, W=50, a=-44, h=5, k="canopy"),
    dict(c=(1812, 2221), L=90, W=12, a=45, h=6, k="canopy"),
    dict(c=(1320, 2370), L=100, W=26, a=-42, h=7, k="canopy"),
    dict(c=(1347, 2483), L=175, W=18, a=-42, h=7, k="canopy"),
    dict(c=(1370, 2511), L=180, W=18, a=-42, h=7, k="canopy"),
    dict(c=(1783, 2453), L=75, W=60, a=-44, h=10, k="bld"),
    dict(c=(1730, 2410), L=25, W=20, a=-44, h=5, k="bld"),
    # north: services complex near the Doha roundabout, export gate canopies
    dict(c=(2457, 850), L=66, W=50, a=-30, h=8, k="bld"),
    dict(c=(2366, 894), L=70, W=55, a=-30, h=6, k="bld"),
    dict(c=(2503, 1019), L=106, W=16, a=-20, h=6, k="bld"),
    dict(c=(2275, 1235), L=190, W=14, a=-43, h=7, k="canopy"),
    dict(c=(2300, 1260), L=190, W=14, a=-43, h=7, k="canopy"),
]


def rect(c, L, W, a):
    r = np.deg2rad(a); u = np.array([np.cos(r), np.sin(r)]); v = np.array([-u[1], u[0]]); c = np.array(c, float)
    return [(c + u * L / 2 + v * W / 2), (c - u * L / 2 + v * W / 2), (c - u * L / 2 - v * W / 2), (c + u * L / 2 - v * W / 2)]


def refine(sd):
    cx, cy = sd["c"]; R = 0.8 * max(sd["L"], sd["W"]) + 15
    x0, y0 = int((cx - R) * S), int((cy - R) * S); x1, y1 = int((cx + R) * S), int((cy + R) * S)
    lab = LAB[y0:y1, x0:x1]; h, w = lab.shape[:2]; sx, sy = int(cx * S) - x0, int(cy * S) - y0
    r0 = max(3, int(0.22 * min(sd["L"], sd["W"]) * S))
    disk = np.zeros((h, w), np.uint8); cv2.circle(disk, (sx, sy), r0, 1, -1)
    ref = np.median(lab[disk > 0], axis=0); dist = np.linalg.norm(lab - ref, axis=2)
    best = None; target = sd["L"] * sd["W"]
    for thr in (10, 14, 18, 24):
        m = (dist < thr).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        n, lab_, st, _ = cv2.connectedComponentsWithStats(m)
        i = lab_[sy, sx]
        if i == 0: continue
        cnt, _ = cv2.findContours((lab_ == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        (rx, ry), (rw, rh), ra = cv2.minAreaRect(max(cnt, key=cv2.contourArea))
        area = rw * rh / S / S; ratio = area / target
        if 0.6 < ratio < 1.45 and (best is None or abs(np.log(ratio)) < abs(np.log(best[0]))):
            if rw < rh: rw, rh, ra = rh, rw, ra + 90
            best = (ratio, ((rx + x0) / S, (ry + y0) / S), rw / S, rh / S, ra)
    return best


out = []; vis = cv2.resize(HR, None, fx=0.5, fy=0.5)
for sd in SEEDS:
    poly = rect(sd["c"], sd["L"], sd["W"], sd["a"]); tag = "seed"
    if sd.get("refine"):
        b = refine(sd)
        if b:
            _, c, L, W, a = b; poly = rect(c, L, W, a); tag = f"refined {L * 0.8:.0f}x{W * 0.8:.0f} m"
    print(f"{sd['k']:6s} {str(sd['c']):12s} {tag}")
    e = {"poly": [np.round(p, 1).tolist() for p in poly], "h": sd["h"], "k": sd["k"]}
    for key in ("role", "dome"):
        if key in sd: e[key] = sd[key]
    out.append(e)
    q = (np.float32(poly) * S * 0.5).astype(np.int32)
    cv2.polylines(vis, [q], True, (0, 0, 255) if sd["k"] != "canopy" else (255, 200, 0), 2)
g = json.load(open(os.path.join(A, "geo.json"), encoding="utf-8")); g["buildings"] = out
# main import parking: angled bays on the real row lattice (fitted to the photographed trucks, see lotclean.py)
# row k centre line: s = phase + tilt*u + pitch*k (s along e, u along r, from lot corner 0), trucks head east
lot = lotclean.LOTS[0]
g["import"]["st"]["park"] = {"idx": g["import"]["st"]["park"]["idx"], "layout": "bays", "polys": [lot["poly"]], "o": lot["poly"][0],
                             "e": list(lot["e"]), "r": list(lot["r"]), "pitch": 36.1, "phase": 33.5, "tilt": 0.058, "bay": 8.6, "heading": 0}
json.dump(g, open(os.path.join(A, "geo.json"), "w", encoding="utf-8"), separators=(",", ":"))
x0, y0 = int(1150 * S * 0.5), int(700 * S * 0.5); x1, y1 = int(2650 * S * 0.5), int(2650 * S * 0.5)
cv2.imwrite("bld_vis.jpg", vis[y0:y1, x0:x1], [cv2.IMWRITE_JPEG_QUALITY, 85])
print(len(out), "buildings")
