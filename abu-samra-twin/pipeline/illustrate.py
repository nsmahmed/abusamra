"""Illustrated ("rendered") ground for the second variant of the twin -> assets/illus/.

Run from anywhere:  python pipeline/illustrate.py
Turns the satellite ground texture and the high-res tiles into a clean, map-like rendering:
edge-preserving smoothing, a curated palette (sand, sabkha, asphalt, roofs, greenery), crisp road markings,
soft ink outlines and a gentle paper grain. Geometry is unchanged, so every overlay stays aligned.
Then declutter.py removes the vehicles photographed into the ground (the twin draws its own 3D trucks) and paints
proper asphalt with lane markings along the truck routes wherever the ground under them is not already road
(stretches outside the close-up coverage, and roads the sabkha rule warmed to sand).
"""
import cv2, numpy as np, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from declutter import remove_vehicles, paint_roads
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"); O = os.path.join(A, "illus"); os.makedirs(O, exist_ok=True)
rng = np.random.default_rng(3)
SAND_L, SAND_D = np.float32([196, 220, 236]), np.float32([128, 160, 196])   # BGR: light dune / darker sand
SABKHA = np.float32([104, 128, 160])
ASPH, ASPH_EDGE = np.float32([86, 82, 80]), np.float32([60, 58, 57])
MARK = np.float32([235, 240, 242])
ROOF = np.float32([238, 240, 240])
GREEN = np.float32([92, 140, 104])


def ramp(stops, x):
    xs = np.float32([q[0] for q in stops]); cs = np.float32([q[1] for q in stops])
    return np.stack([np.interp(x, xs, cs[:, c]) for c in range(3)], -1).astype(np.float32)


# gradient maps (BGR): neutral surfaces -> clean cool greys (asphalt, concrete, roofs); warm surfaces -> sand / sabkha
COOL = [(0.0, (46, 42, 40)), (0.30, (78, 74, 72)), (0.42, (92, 89, 87)), (0.62, (168, 170, 172)), (0.82, (226, 228, 230)), (1.0, (248, 250, 251))]
WARM = [(0.0, (52, 64, 82)), (0.30, (98, 118, 146)), (0.45, (136, 166, 200)), (0.62, (170, 200, 226)), (0.80, (204, 226, 242)), (1.0, (236, 246, 252))]


# paved areas wider than a road (lots, plazas, yards), in mosaic px. Wide dark ground elsewhere is sabkha.
PAVED = [[[1190, 2803], [1637, 2410], [1880, 2650], [1450, 3080]], [[700, 3500], [1330, 3110], [1010, 2760], [440, 3216]],
         [[2040, 330], [2270, 300], [2420, 640], [2215, 725]], [[1440, 1540], [1720, 1470], [2170, 1830], [2230, 2150], [1900, 2470], [1520, 2380], [1280, 2110]],
         [[2040, 2030], [2440, 2300], [2150, 2620], [1860, 2380]], [[2140, 1190], [2370, 1350], [2260, 1520], [2030, 1350]], [[2280, 640], [2560, 640], [2560, 1000], [2280, 1000]]]
# yards where route paint must not go (the route crosses them, but they are concrete aprons, not roads)
NO_ROAD = PAVED + [[[1500, 1445], [1597, 1545], [1495, 1665], [1378, 1555]],   # export inspection compound
                   [[1597, 1530], [1680, 1494], [1712, 1575], [1630, 1615]]]   # export operational parking apron
GEO = json.load(open(os.path.join(A, "geo.json"), encoding="utf-8"))
ROADS = [(GEO[f]["path"], 5.0) for f in ("import", "export")]


def illustrate(img, px_m, M=None):
    """img: BGR uint8; px_m: metres per pixel (controls filter sizes); M: mosaic px -> img px (3x3)."""
    s = lambda m: max(1, int(round(m / px_m)))
    sm = cv2.edgePreservingFilter(img, flags=1, sigma_s=60, sigma_r=0.3).astype(np.float32)
    lab = cv2.cvtColor(sm.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[..., 0] / 255.0
    L = (L - 0.12) / 0.80                                   # stretch
    L = np.clip(0.55 * L + 0.45 * np.round(L * 9) / 9, 0, 1)  # soft posterise
    warm = np.clip((lab[..., 2] - 132) / 14, 0, 1)
    if M is not None:  # wide dark neutral ground outside known paved areas = sabkha -> warm
        dark = ((L < 0.5) & (np.abs(lab[..., 2] - 128) < 9)).astype(np.uint8)
        k = s(85) | 1; wide = cv2.morphologyEx(dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        pv = np.zeros(dark.shape, np.uint8)
        for poly in PAVED: cv2.fillPoly(pv, [cv2.perspectiveTransform(np.float32(poly).reshape(-1, 1, 2), M).reshape(-1, 2).astype(np.int32)], 1)
        sab = cv2.GaussianBlur((wide & (1 - pv)).astype(np.float32), (0, 0), s(6))
        warm = np.maximum(warm, sab); L = np.clip(L + 0.14 * sab, 0, 1)
    warm = cv2.GaussianBlur(warm, (0, 0), s(1.2))[..., None]
    out = ramp(COOL, L) * (1 - warm) + ramp(WARM, L) * warm
    # greenery: dark compact blobs on lighter ground
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32); bg = cv2.medianBlur(img, min(255, s(9) | 1)).astype(np.float32).mean(2)
    tree = ((bg - g) > 26).astype(np.uint8); tree = cv2.morphologyEx(tree, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    n, lb, st, _ = cv2.connectedComponentsWithStats(tree); keep = np.zeros(n, np.uint8)
    amax = (9 / px_m) ** 2
    for i in range(1, n):
        x, y, w, h, ar = st[i]
        if ar <= amax and max(w, h) <= 2.6 * min(w, h) and bg[y + h // 2, x + w // 2] > 95: keep[i] = 1
    tree = cv2.GaussianBlur(keep[lb].astype(np.float32), (0, 0), 0.8)[..., None]
    out = out * (1 - tree) + np.float32([70, 128, 86]) * tree
    # a little of the photo's fine detail, then ink outlines and paper grain
    out += (sm - cv2.GaussianBlur(sm, (0, 0), s(4))) * 0.25
    e = cv2.Canny(cv2.GaussianBlur(sm.astype(np.uint8), (0, 0), 1.0), 30, 90).astype(np.float32) / 255
    out *= 1 - 0.28 * cv2.GaussianBlur(e, (0, 0), 0.6)[..., None]
    out += rng.normal(0, 1.4, img.shape[:2])[..., None].astype(np.float32)
    out = np.clip(out, 0, 255).astype(np.uint8)
    out, _ = remove_vehicles(out, px_m)
    if M is not None:
        keep = np.zeros(out.shape[:2], np.uint8)
        for poly in NO_ROAD: cv2.fillPoly(keep, [cv2.perspectiveTransform(np.float32(poly).reshape(-1, 1, 2), M).reshape(-1, 2).astype(np.int32)], 1)
        out = paint_roads(out, px_m, M, ROADS, protect=cv2.GaussianBlur(keep.astype(np.float32), (0, 0), 2))
    return out


T = json.load(open(os.path.join(A, "tex.json")))
base = cv2.imread(os.path.join(A, "ground_4096.jpg"))
px_base = 0.8 * (T["W"] + 2 * T["PAD"]) / base.shape[1]
KB = base.shape[1] / (T["W"] + 2 * T["PAD"]); MB = np.float64([[KB, 0, T["PAD"] * KB], [0, KB, T["PAD"] * KB], [0, 0, 1]])
cv2.imwrite(os.path.join(O, "ground_4096.jpg"), illustrate(base, px_base, MB), [cv2.IMWRITE_JPEG_QUALITY, 84, cv2.IMWRITE_JPEG_OPTIMIZE, 1]); print("base done")
for tl in T["tiles"]:
    im = cv2.imread(os.path.join(A, tl["file"]))
    p00, p10, p01 = (np.float64(tl[k]) for k in ("p00", "p10", "p01"))
    Mt = np.float64([[(p10 - p00)[0] / tl["w"], (p01 - p00)[0] / tl["h"], p00[0]], [(p10 - p00)[1] / tl["w"], (p01 - p00)[1] / tl["h"], p00[1]], [0, 0, 1]])
    cv2.imwrite(os.path.join(O, tl["file"]), illustrate(im, 0.8 / 1.38, np.linalg.inv(Mt)), [cv2.IMWRITE_JPEG_QUALITY, 82, cv2.IMWRITE_JPEG_OPTIMIZE, 1]); print(tl["file"], "done")
