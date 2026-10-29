"""Snap the sparse truck routes in geo.json onto road centrelines.

Run from pipeline/work after composite.py:  python ../roads.py [--write]
For each route, a least-cost path (skimage MCP) is found inside a corridor around the hand/flow-map polyline.
Cost is low on asphalt and lowest on the road centreline (distance transform of the road mask), so the result
follows the real carriageway instead of cutting corners. The dense path is simplified, smoothed, and the stage
anchor indices are re-mapped to the nearest dense vertex. Without --write it only draws roads_vis.jpg.
"""
import cv2, numpy as np, json, os, sys
from skimage.graph import MCP_Geometric
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
g = json.load(open(os.path.join(A, "geo.json"), encoding="utf-8"))
if "path_src" not in g["import"]:  # keep the original sparse polylines + anchors so re-runs are idempotent
    for f in ("import", "export"):
        g[f]["path_src"] = g[f]["path"]; g[f]["st_src"] = {k: v["idx"] for k, v in g[f]["st"].items()}
        for k, v in g[f]["st"].items():
            for kk in ("from", "to"):
                if kk in v: g[f]["st_src"][k + "." + kk] = v[kk]
        g[f]["opStart_src"] = g[f]["opStart"]

if os.path.exists("best_mosaic.png"):
    img = cv2.imread("best_mosaic.png")
else:
    mos = cv2.imread("mosaic.png"); HR = cv2.imread("hr_full.png")
    hr = cv2.resize(HR, (mos.shape[1], mos.shape[0]), interpolation=cv2.INTER_AREA); img = np.where((hr.max(2) > 0)[..., None], hr, mos)
H, W = img.shape[:2]
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV); v = hsv[..., 2].astype(int); s = hsv[..., 1].astype(int)
road = ((v < 110) & (s < 75)).astype(np.uint8)
road = cv2.morphologyEx(cv2.morphologyEx(road, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
dist = cv2.distanceTransform(road, cv2.DIST_L2, 5)
cost = np.where(road > 0, 1.0 / (1.0 + 0.5 * dist), 4.0).astype(np.float64)
CORR = {"import": 30, "export": 34}


def snap(pts, corridor):
    pts = np.float32(pts); out = [pts[0]]
    for a, b in zip(pts[:-1], pts[1:]):
        inside = [p for p in (a, b) if 0 <= p[0] < W and 0 <= p[1] < H]
        if len(inside) < 2:  # outside the imagery: keep the straight segment
            out.append(b); continue
        x0, y0 = np.floor(np.minimum(a, b) - corridor - 5).astype(int); x1, y1 = np.ceil(np.maximum(a, b) + corridor + 5).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, W), min(y1, H)
        c = cost[y0:y1, x0:x1].copy()
        m = np.zeros(c.shape, np.uint8); cv2.line(m, tuple((a - [x0, y0]).astype(int)), tuple((b - [x0, y0]).astype(int)), 1, 1)
        dm = cv2.distanceTransform((1 - m).astype(np.uint8), cv2.DIST_L2, 5); c[dm > corridor] = 1e6
        mcp = MCP_Geometric(c); st = (int(a[1] - y0), int(a[0] - x0)); en = (int(b[1] - y0), int(b[0] - x0))
        mcp.find_costs([st], [en]); tr = np.float32(mcp.traceback(en))[:, ::-1] + [x0, y0]
        out.extend(tr[1:])
    return np.float32(out)


def smooth(P, eps=2.0, it=2):
    P = cv2.approxPolyDP(P.reshape(-1, 1, 2), eps, False).reshape(-1, 2).astype(np.float64)
    for _ in range(it):  # Chaikin corner cutting, endpoints fixed
        Q = [P[0]]
        for a, b in zip(P[:-1], P[1:]): Q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        Q.append(P[-1]); P = np.array(Q)
    # resample to ~6 px spacing so the app has smooth, even vertices
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]; n = max(2, int(d[-1] / 6))
    t = np.linspace(0, d[-1], n); return np.stack([np.interp(t, d, P[:, 0]), np.interp(t, d, P[:, 1])], 1)


vis = cv2.resize(img, None, fx=0.5, fy=0.5)
for f, col in (("import", (0, 220, 255)), ("export", (255, 60, 255))):
    src = np.float32(g[f]["path_src"]); dense = smooth(snap(src, CORR[f]))
    near = lambda p: int(np.argmin(np.linalg.norm(dense - p, axis=1)))
    idx_of = {k: near(src[i]) for k, i in g[f]["st_src"].items()}
    cv2.polylines(vis, [(src * 0.5).astype(np.int32)], False, (80, 80, 80), 1)
    cv2.polylines(vis, [(dense * 0.5).astype(np.int32)], False, col, 2)
    for k, i in idx_of.items():
        if "." not in k: cv2.putText(vis, k, tuple((dense[i] * 0.5).astype(int)), 0, 0.5, (0, 0, 255), 2)
    if "--write" in sys.argv:
        g[f]["path"] = dense.round(1).tolist(); g[f]["opStart"] = near(src[g[f]["opStart_src"]])
        for k, i in idx_of.items():
            if "." in k: kk, fld = k.split("."); g[f]["st"][kk][fld] = i
            else: g[f]["st"][k]["idx"] = i
    print(f, len(src), "->", len(dense), "vertices")
cv2.imwrite("roads_vis.jpg", vis)
if "--write" in sys.argv:
    json.dump(g, open(os.path.join(A, "geo.json"), "w", encoding="utf-8"), separators=(",", ":")); print("geo.json updated")
