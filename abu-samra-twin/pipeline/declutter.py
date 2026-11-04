"""Clean-up passes for the illustrated ground (called from illustrate.py).

remove_vehicles(img, px_m): finds the photographed vehicles that the satellite imagery bakes into the ground
    (bright or coloured clusters on dark asphalt) and inpaints them, so only the simulated 3D trucks remain.
    Thin lane markings survive because a cluster must be at least a vehicle wide and dense; long thin lines,
    crossings and canopies are rejected by size and shape.
paint_roads(img, px_m, M, roads): paints proper roads (dark asphalt, white edge lines, dashed white centre line,
    yellow kerb line) along polylines given in mosaic px, only where the ground under them is not already road.
"""
import cv2, numpy as np


def _s(px_m):
    return lambda m: max(1, int(round(m / px_m)))


def vehicle_mask(img, px_m):
    s = _s(px_m)
    f = img.astype(np.float32); g = f.mean(2)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    # background brightness with the vehicles suppressed: median over ~25 m
    bg = cv2.medianBlur(img, min(255, s(25) | 1)).astype(np.float32).mean(2)
    paved = (bg < 120)  # asphalt and dark paving (illustrated asphalt ramp tops out ~95)
    paved = cv2.erode(paved.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    bright = ((g - bg) > 38) & (hsv[..., 1] < 26)            # white / silver bodies (illustrated sand sits ~35-60)
    colour = (hsv[..., 1] > 120) & (hsv[..., 2] > 70) & ((g - bg) > 12) & ~((hsv[..., 0] > 8) & (hsv[..., 0] < 28) & (hsv[..., 1] < 150))
    cand = ((bright | colour) & paved).astype(np.uint8)
    asph = ((g < 105) & (hsv[..., 1] < 60)).astype(np.float32)  # plain asphalt
    # cluster nearby pieces of one vehicle (photographs render trucks as rows of short stripes)
    k = s(1.6) * 2 + 1
    cl = cv2.dilate(cand, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lb, st, _ = cv2.connectedComponentsWithStats(cl)
    keep = np.zeros(n, np.uint8)
    # painted lines: single continuous stripes that are long (>= 28 m, longer than any truck) and thin (<= 2.4 m). A cluster holding one is a
    # marking field (stop bars, lane dividers, hatching), not a vehicle.
    n2, lb2, st2, _ = cv2.connectedComponentsWithStats(cand)
    line_px = np.zeros(cand.shape, np.uint8)
    for j in range(1, n2):
        x, y, w, h, area = st2[j]
        if max(w, h) * px_m < 12: continue
        ys, xs = np.nonzero(lb2[y:y + h, x:x + w] == j)
        (_, _), (a, b), _ = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
        if max(a, b) * px_m >= 28 and min(a, b) * px_m <= 2.4: line_px[y:y + h, x:x + w][lb2[y:y + h, x:x + w] == j] = 1
    has_line = np.zeros(n, bool); has_line[np.unique(lb[line_px > 0])] = True
    for i in range(1, n):
        x, y, w, h, area = st[i]
        if area * px_m ** 2 > 900 or has_line[i]:  # canopy / building / marking field
            continue
        ys, xs = np.nonzero(lb[y:y + h, x:x + w] == i)
        (_, _), (a, b), _ = cv2.minAreaRect(np.stack([xs, ys], 1).astype(np.float32))
        L, W = max(a, b) * px_m, min(a, b) * px_m
        dens = cand[y:y + h, x:x + w][lb[y:y + h, x:x + w] == i].mean()
        # after the 1.6 m dilation a lane line is ~3.5 m wide, a car ~5 m, a truck ~5.5 m
        if L > 48 or dens < 0.2 or L / max(W, 1e-3) > 7:  # long thin: stop line, kerb, marking
            continue
        car = W < 4.2
        if car:  # narrower than a truck: accept only a compact, car-sized blob (lane dashes are long and thin)
            core = cand[y:y + h, x:x + w][lb[y:y + h, x:x + w] == i].sum() * px_m ** 2
            if not (W >= 3.6 and 4 <= core <= 16 and L <= 9):
                continue
        # the vehicle must stand on asphalt: the ring around the cluster is mostly plain asphalt
        r = s(4); y0, x0 = max(0, y - r), max(0, x - r); sub = (lb[y0:y + h + r, x0:x + w + r] == i).astype(np.uint8)
        ring = cv2.dilate(sub, np.ones((2 * r + 1, 2 * r + 1), np.uint8)) & (1 - sub)
        if ring.sum() == 0 or asph[y0:y + h + r, x0:x + w + r][ring > 0].mean() < (0.85 if car else 0.62):
            continue
        keep[i] = 1
    m = keep[lb] & (cl > 0)
    m = (m & cv2.dilate(cand, np.ones((3, 3), np.uint8))).astype(np.uint8)
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (s(1.2) * 2 + 1,) * 2))
    return m


def remove_vehicles(img, px_m, protect=None):
    m = vehicle_mask(img, px_m)
    if protect is not None:
        m &= (1 - protect).astype(np.uint8)
    if not m.any():
        return img, m
    out = cv2.inpaint(img, m * 255, max(3, _s(px_m)(3)), cv2.INPAINT_TELEA)
    # a touch of the asphalt grain back so the patches don't read as smears
    noise = np.random.default_rng(5).normal(0, 1.6, img.shape[:2]).astype(np.float32)[..., None]
    soft = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.2)[..., None]
    out = np.clip(out.astype(np.float32) + noise * soft, 0, 255).astype(np.uint8)
    return out, m


ASPHALT = np.float32([70, 69, 68]); EDGE = np.float32([228, 231, 233]); YEL = np.float32([52, 176, 222])


def road_need(img, M, path, px_m, half_m):
    """Per-vertex flag: the ground along this stretch of route is not already asphalt."""
    s = _s(px_m)
    P = cv2.perspectiveTransform(np.float32(path).reshape(-1, 1, 2), M).reshape(-1, 2)
    g = cv2.blur(img, (s(6) | 1, s(6) | 1)).astype(np.float32)
    hsv = cv2.cvtColor(g.astype(np.uint8), cv2.COLOR_BGR2HSV)
    h, w = img.shape[:2]; need = np.zeros(len(P), bool)
    for i, (x, y) in enumerate(P):
        xi, yi = int(round(x)), int(round(y))
        if not (0 <= xi < w and 0 <= yi < h):
            continue
        r = s(half_m * 0.6)
        patch = g[max(0, yi - r):yi + r + 1, max(0, xi - r):xi + r + 1].reshape(-1, 3)
        pv = hsv[max(0, yi - r):yi + r + 1, max(0, xi - r):xi + r + 1].reshape(-1, 3)
        dark = ((patch.mean(1) < 105) & (pv[:, 1] < 70)).mean()
        need[i] = dark < 0.7
    return P, need


def runs(flag, close, minlen):
    f = flag.copy(); n = len(f); i = 0
    while i < n:  # close short gaps
        if not f[i]:
            j = i
            while j < n and not f[j]: j += 1
            if 0 < i and j < n and j - i <= close: f[i:j] = True
            i = j
        else:
            i += 1
    out = []; i = 0
    while i < n:
        if f[i]:
            j = i
            while j < n and f[j]: j += 1
            if j - i >= minlen: out.append((i, j))
            i = j
        else:
            i += 1
    return out


def _offset(P, off):
    d = np.gradient(P, axis=0); d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-6)
    return P + np.stack([-d[:, 1], d[:, 0]], 1) * off


def paint_roads(img, px_m, M, roads, protect=None, always=True):
    """roads: list of (path_mosaic_px, half_width_m). Paints each run that needs it inside its own bounding box.
    always=True paints the whole route (outside `protect`) so every truck road shares one clean style; with False only
    stretches whose ground is not already asphalt are painted."""
    out = img.astype(np.float32); H, W = img.shape[:2]; SS = 4; rng = np.random.default_rng(11)
    for path, half in roads:
        P, need = road_need(img, M, path, px_m, half)
        if always: need[:] = True
        for a, b in runs(need, 14, 8):
            a = max(0, a - 3); b = min(len(P), b + 3)
            Qf = P[a:b]
            if len(Qf) < 2: continue
            pad = int((half + 4) / px_m) + 4
            x0, y0 = int(max(0, Qf[:, 0].min() - pad)), int(max(0, Qf[:, 1].min() - pad))
            x1, y1 = int(min(W, Qf[:, 0].max() + pad)), int(min(H, Qf[:, 1].max() + pad))
            if x1 - x0 < 4 or y1 - y0 < 4: continue
            h, w = y1 - y0, x1 - x0; Q = Qf - [x0, y0]
            mk = lambda q: (q * SS).astype(np.int32).reshape(-1, 1, 2)
            def stroke(q, width_m, target, val=255):
                cv2.polylines(target, [mk(q)], False, val, max(1, int(round(width_m / px_m * SS))), cv2.LINE_AA, shift=2)
            lay = np.zeros((h, w), np.uint8); stroke(Q, half * 2 + 1.0, lay)  # carriageway + shoulders
            body = cv2.GaussianBlur(lay.astype(np.float32) / 255, (0, 0), 0.8)
            # feather the run ends so the painted road meets the real one without a seam
            fade = np.zeros((h, w), np.float32)
            n = len(Q); wts = np.minimum(1, np.minimum(np.arange(n), n - 1 - np.arange(n)) / 4.0)
            for i in range(n - 1):
                cv2.line(fade, tuple((Q[i] * SS).astype(int)), tuple((Q[i + 1] * SS).astype(int)), float(max(0.05, wts[i])),
                         max(1, int(round((half * 2 + 3) / px_m * SS))), cv2.LINE_AA, shift=2)
            al = body * fade
            if protect is not None: al *= (1 - protect[y0:y1, x0:x1])
            seg = out[y0:y1, x0:x1]
            col = ASPHALT + rng.normal(0, 2.0, (h, w, 1)).astype(np.float32)
            seg = seg * (1 - al[..., None]) + col * al[..., None]
            lines = np.zeros((h, w), np.uint8); ylines = np.zeros((h, w), np.uint8)
            lw = max(0.3, px_m * 0.6); al = al * 1.0
            stroke(_offset(Q, (half - 0.5) / px_m), lw, lines)     # right edge line, white
            stroke(_offset(Q, -(half - 0.5) / px_m), lw, ylines)   # left kerb line, yellow
            cum = np.r_[0, np.cumsum(np.linalg.norm(np.diff(Q, axis=0), axis=1))] * px_m
            for i in range(len(Q) - 1):                            # dashed centre line: 6 m dash, 9 m gap
                if (cum[i] % 15) < 6: stroke(Q[i:i + 2], lw, lines)
            la = cv2.GaussianBlur(lines.astype(np.float32) / 255, (0, 0), 0.5) * al * 0.85
            ya = cv2.GaussianBlur(ylines.astype(np.float32) / 255, (0, 0), 0.5) * al * 0.8
            seg = seg * (1 - la[..., None]) + EDGE * la[..., None]
            out[y0:y1, x0:x1] = seg * (1 - ya[..., None]) + YEL * ya[..., None]
    return np.clip(out, 0, 255).astype(np.uint8)
