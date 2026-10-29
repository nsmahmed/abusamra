"""Gridded zoom of best_mosaic.png (mosaic px) with the current routes drawn. usage: python ../zoom2.py x0 y0 x1 y1 scale out.jpg"""
import cv2, numpy as np, json, os, sys
A = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets")
x0, y0, x1, y1, S = map(float, sys.argv[1:6]); out = sys.argv[6]
img = cv2.imread("best_mosaic.png"); g = json.load(open(os.path.join(A, "geo.json"), encoding="utf-8"))
M = np.float32([[S, 0, -x0 * S], [0, S, -y0 * S]]); W, H = int((x1 - x0) * S), int((y1 - y0) * S)
im = cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC)
for f, col in (("import", (0, 200, 255)), ("export", (255, 80, 255))):
    for key in ("path",) + (("path_src",) if "--src" in sys.argv else ()):
        if key not in g[f]: continue
        q = ((np.float32(g[f][key]) - [x0, y0]) * S).astype(np.int32); cv2.polylines(im, [q], False, col, 1, cv2.LINE_AA)
step = 25
for gx in np.arange(np.ceil(x0 / step) * step, x1, step):
    X = int((gx - x0) * S); cv2.line(im, (X, 0), (X, H), (0, 255, 255) if gx % 100 == 0 else (0, 140, 140), 1)
    if gx % 50 == 0: cv2.putText(im, str(int(gx)), (X + 2, 12), 0, 0.42, (0, 255, 255), 1)
for gy in np.arange(np.ceil(y0 / step) * step, y1, step):
    Y = int((gy - y0) * S); cv2.line(im, (0, Y), (W, Y), (0, 255, 255) if gy % 100 == 0 else (0, 140, 140), 1)
    if gy % 50 == 0: cv2.putText(im, str(int(gy)), (2, Y - 2), 0, 0.42, (0, 255, 255), 1)
cv2.imwrite(out, im, [cv2.IMWRITE_JPEG_QUALITY, 88])
