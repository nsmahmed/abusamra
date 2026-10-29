"""Rebuild the periodic main import lot without the photographed trucks.

The lot is a row of angled bays every ~34.5 mosaic px along `e`. We work in a rectified frame (s along e, u along r),
estimate the exact row pitch by autocorrelation, take the per-pixel median over all rows (trucks occupy any given
bay in well under half of the rows) and tile that clean row back over the lot interior.
Used by ground.py; run standalone (from pipeline/work, needs hr_full.png) to preview: python ../lotclean.py
"""
import cv2, numpy as np

LOTS = [dict(poly=[[1221, 2803], [1637, 2444], [1846, 2650], [1450, 3044]], e=(0.758, -0.652), r=(0.652, 0.758), pitch=34.5, ends=28)]
Q = 2.0  # rectified px per mosaic px


def frame(lot):
    """(A, W, H): A maps rectified px -> mosaic px."""
    P = np.float64(lot["poly"]); e = np.float64(lot["e"]); r = np.float64(lot["r"])
    S = (P - P[0]) @ e; U = (P - P[0]) @ r
    s0, s1, u0, u1 = S.min(), S.max(), U.min(), U.max()
    A = np.array([[e[0] / Q, r[0] / Q, P[0][0] + e[0] * s0 + r[0] * u0],
                  [e[1] / Q, r[1] / Q, P[0][1] + e[1] * s0 + r[1] * u0], [0, 0, 1]])
    return A, int((s1 - s0) * Q), int((u1 - u0) * Q)


def clean_rect(rect, lot):
    """rect: lot imagery in the rectified frame -> (clean rectified image, pitch in mosaic px, correlation)."""
    H, W = rect.shape[:2]
    g = cv2.cvtColor(np.clip(rect, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    prof = g[int(H * 0.2):int(H * 0.8)].mean(0); prof -= prof.mean(); n = len(prof)
    best = None
    for P in np.arange(lot["pitch"] * Q * 0.92, lot["pitch"] * Q * 1.08, 0.05):
        xs = np.arange(0, n - int(P) - 1); a = np.interp(xs + P, np.arange(n), prof); c = np.corrcoef(prof[xs], a)[0, 1]
        if best is None or c > best[0]: best = (c, P)
    P = best[1]
    rows = [cv2.warpAffine(rect, np.float32([[1, 0, k * P], [0, 1, 0]]), (int(np.ceil(P)) + 1, H), flags=cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR)
            for k in range(int(W // P))]
    tmpl = np.median(np.stack(rows), axis=0).astype(np.float32)
    mapx = np.tile(np.mod(np.arange(W, dtype=np.float32), P), (H, 1)).astype(np.float32)
    mapy = np.tile(np.arange(H, dtype=np.float32)[:, None], (1, W))
    return cv2.remap(tmpl, mapx, mapy, cv2.INTER_LINEAR), P / Q, best[0]


def paint(img, M, lot, A, clean):
    """Blend the clean lot into img (float32 BGR, modified in place). M maps mosaic px -> img px."""
    P = np.float32(lot["poly"]); r = np.float32(lot["r"])
    inner = np.float32([P[0] + r * lot["ends"], P[1] + r * lot["ends"], P[2] - r * lot["ends"], P[3] - r * lot["ends"]])
    q = cv2.perspectiveTransform(inner.reshape(-1, 1, 2), M).reshape(-1, 2)
    if q[:, 0].max() < 0 or q[:, 1].max() < 0 or q[:, 0].min() > img.shape[1] or q[:, 1].min() > img.shape[0]: return False
    back = cv2.warpPerspective(clean, M @ A, (img.shape[1], img.shape[0]), flags=cv2.INTER_LINEAR)
    mk = np.zeros(img.shape[:2], np.float32); cv2.fillPoly(mk, [q.astype(np.int32)], 1.0)
    mk = cv2.GaussianBlur(cv2.erode(mk, np.ones((3, 3), np.uint8)), (0, 0), max(1.5, 3 * np.sqrt(abs(np.linalg.det(M[:2, :2])))))
    img[:] = img * (1 - mk[..., None]) + back * mk[..., None]
    return True


if __name__ == "__main__":
    S = 1.38; HR = cv2.imread("hr_full.png").astype(np.float32); lot = LOTS[0]
    A, W, H = frame(lot)
    rect = cv2.warpPerspective(HR, np.diag([S, S, 1.0]) @ A, (W, H), flags=cv2.WARP_INVERSE_MAP | cv2.INTER_LINEAR)
    clean, pitch, corr = clean_rect(rect, lot); print("pitch %.2f corr %.2f" % (pitch, corr))
    x0, y0, x1, y1 = [int(v * S) for v in (1180, 2400, 1880, 3080)]
    crop = HR[y0:y1, x0:x1].copy(); paint(crop, np.array([[S, 0, -x0], [0, S, -y0], [0, 0, 1.0]]), lot, A, clean)
    cv2.imwrite("lot_clean.jpg", cv2.resize(np.clip(crop, 0, 255).astype(np.uint8), None, fx=0.7, fy=0.7))
