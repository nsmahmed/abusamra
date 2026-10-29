"""Build the ground textures from the mosaic + registered Google Earth close-ups.

Run from pipeline/work after mosaic.py and register.py:
    python ../ground.py
Outputs (into assets/):
    ground_4096.jpg   whole extent (mosaic + PAD), close-ups downsampled in, desert synthesized outside coverage
    hr_*.jpg          oriented high-resolution tiles over the close-up coverage (~0.58 m/texel)
    tex.json          texture extents, sand colour and the tile frames (corners in mosaic px)
"""
import cv2, numpy as np, json, os, time
HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "..", "data", "map-imagery")
A = os.path.join(HERE, "..", "assets")
rng = np.random.default_rng(5)
t0 = time.time()
log = lambda *a: print(f"[{time.time()-t0:6.1f}s]", *a, flush=True)

mos = cv2.imread("mosaic.png").astype(np.float32)
cov = cv2.imread("cov.png", 0) > 0
H, W = cov.shape
PAD = 700
C = json.load(open("closeups.json"))


def ui_mask(h, w):
    m = np.full((h, w), 255, np.uint8)
    m[h - 95:, :] = 0; m[:10, :] = 0; m[h - 200:, w - 560:] = 0; m[h - 190:, :160] = 0
    m[:, :3] = 0; m[:, -3:] = 0  # so the feather reaches zero at the side edges too
    return m


# ---------- load close-ups with feathered weights ----------
CL = []
for name, v in C.items():
    img = cv2.imread(os.path.join(D, name))[..., :3].astype(np.float32)
    h, w = img.shape[:2]
    dist = cv2.distanceTransform(ui_mask(h, w), cv2.DIST_L2, 5)
    CL.append({"name": name, "img": img, "H": np.array(v["H"]), "dist": dist})
log("loaded", len(CL), "close-ups")


# ---------- photometric gain compensation between close-ups (at mosaic scale) ----------
def warp_to(c, M, size, feather):
    src, wsrc = c["img"], np.clip(c["dist"] / feather, 0, 1)
    sc = np.sqrt(abs(np.linalg.det(M[:2, :2])))
    if sc < 0.8:  # warpPerspective has no area filter: pre-shrink to avoid aliasing
        src = cv2.resize(src, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
        wsrc = cv2.resize(wsrc, (src.shape[1], src.shape[0]), interpolation=cv2.INTER_AREA)
        M = M @ np.diag([1 / sc, 1 / sc, 1.0])
    im = cv2.warpPerspective(src, M, size, flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    wt = cv2.warpPerspective(wsrc, M, size, flags=cv2.INTER_LINEAR)
    return im, wt


S0 = 0.25  # quarter mosaic scale is plenty for gains
sz0 = (int(W * S0), int(H * S0)); M0 = np.diag([S0, S0, 1.0])
lows = [warp_to(c, M0 @ c["H"], sz0, 40) for c in CL]
n = len(CL); I = np.zeros((n, n, 3)); N = np.zeros((n, n))
for i in range(n):
    for j in range(n):
        if i == j: continue
        ov = (lows[i][1] > 0.99) & (lows[j][1] > 0.99)
        if ov.sum() > 400:
            N[i, j] = ov.sum(); I[i, j] = lows[i][0][ov].mean(0)
gains = np.ones((n, 3))
for ch in range(3):  # Brown & Lowe gain compensation
    Am = np.zeros((n, n)); b = np.zeros(n); sn, sg = 10.0, 0.1
    for i in range(n):
        for j in range(n):
            if N[i, j] == 0: continue
            Am[i, i] += N[i, j] * (I[i, j, ch] ** 2 / sn ** 2 + 1 / sg ** 2)
            Am[i, j] -= N[i, j] * I[i, j, ch] * I[j, i, ch] / sn ** 2
            b[i] += N[i, j] / sg ** 2
    gains[:, ch] = np.linalg.solve(Am + np.eye(n) * 1e-6, b)
log("gains", np.round(gains, 3).tolist())
for c, g in zip(CL, gains):
    c["img"] *= g


def composite(M_of, size, feather, power=3.0):
    """Feathered composite of all close-ups into a frame; M_of(c) maps close-up px -> frame px.
    The weight power narrows the transition so overlaps don't ghost."""
    acc = np.zeros((size[1], size[0], 3), np.float32); ws = np.zeros((size[1], size[0]), np.float32)
    for c in CL:
        M = M_of(c)
        corners = cv2.perspectiveTransform(np.float32([[0, 0], [c["img"].shape[1], 0], [c["img"].shape[1], c["img"].shape[0]], [0, c["img"].shape[0]]]).reshape(-1, 1, 2), M).reshape(-1, 2)
        if corners[:, 0].max() < 0 or corners[:, 1].max() < 0 or corners[:, 0].min() > size[0] or corners[:, 1].min() > size[1]:
            continue
        im, wt = warp_to(c, M, size, feather)
        wt = wt ** power
        acc += im * wt[..., None]; ws += wt
    out = acc / np.maximum(ws, 1e-6)[..., None]
    return out, np.clip(ws, 0, 1) if power == 1 else (ws > 1e-4).astype(np.float32) * np.clip(ws ** (1 / power) * 4, 0, 1)


# ---------- clean (truck-free) rebuild of the main import lot, from the close-ups in the rectified lot frame ----------
import lotclean
LOTCLEAN = []
for lot in lotclean.LOTS:
    A_, W_, H_ = lotclean.frame(lot)
    rect, _ = composite(lambda c: np.linalg.inv(A_) @ c["H"], (W_, H_), 80, 3.0)
    clean, pitch, corr = lotclean.clean_rect(rect, lot); LOTCLEAN.append((lot, A_, clean))
    log("lot template: pitch %.2f mosaic px, corr %.2f" % (pitch, corr))


def clear_lots(img, M, px_m=None):
    for lot, A_, clean in LOTCLEAN:
        lotclean.paint(img, M, lot, A_, clean)
    return img


# ---------- colour-match the high-level mosaic to the close-ups ----------
lo, lw = composite(lambda c: M0 @ c["H"], sz0, 40, 1.0)
mos_s = cv2.resize(mos, sz0, interpolation=cv2.INTER_AREA); cov_s = cv2.resize(cov.astype(np.uint8), sz0, interpolation=cv2.INTER_NEAREST) > 0
ov = (lw > 0.99) & cov_s
fit = []
for ch in range(3):
    x = mos_s[..., ch][ov]; y = lo[..., ch][ov]
    a, b = np.polyfit(x, y, 1); fit.append((a, b))
log("mosaic->close-up colour fit", np.round(fit, 3).tolist())
for ch, (a, b) in enumerate(fit):
    mos[..., ch] = mos[..., ch] * a + b
mos = np.clip(mos, 0, 255)

# drop sea / watermark pixels at the NW corner from coverage (teal hue)
hsv = cv2.cvtColor(mos.astype(np.uint8), cv2.COLOR_BGR2HSV)
sea = (hsv[..., 0] > 70) & (hsv[..., 0] < 110) & (hsv[..., 1] > 50)
sea = cv2.morphologyEx(sea.astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
sea = cv2.dilate(sea, np.ones((41, 41), np.uint8)) > 0
cov = cov & ~sea
log("sea px masked", int(sea.sum()))

# ---------- base texture (4096^2 over mosaic + PAD) ----------
Wp, Hp = W + 2 * PAD, H + 2 * PAD
B = 4096; KB = B / Wp
TB = np.array([[KB, 0, PAD * KB], [0, KB, PAD * KB], [0, 0, 1]])  # mosaic px -> base texel
img = cv2.warpAffine(mos, TB[:2], (B, B), flags=cv2.INTER_AREA)
m = cv2.warpAffine(cov.astype(np.float32), TB[:2], (B, B), flags=cv2.INTER_LINEAR)
m = cv2.erode((m > 0.98).astype(np.float32), np.ones((5, 5), np.uint8))
hi, hw = composite(lambda c: TB @ c["H"], (B, B), 60, 1.0)
hi = clear_lots(hi, TB, 0.8 / KB)
img = img * (1 - hw[..., None]) + hi * hw[..., None]
m = np.maximum(m, (hw > 0.98).astype(np.float32))
log("base composite done")

# 1) push-pull colour extension at 1/8 resolution
DS = 8
smallI = cv2.resize(img * m[..., None], (B // DS, B // DS), interpolation=cv2.INTER_AREA)
smallM = cv2.resize(m, (B // DS, B // DS), interpolation=cv2.INTER_AREA)
def nc(s):
    a = cv2.GaussianBlur(smallI, (0, 0), s / DS); b = cv2.GaussianBlur(smallM, (0, 0), s / DS)
    return a / np.maximum(b, 1e-6)[..., None], b
mos8 = mos.astype(np.uint8); hsv = cv2.cvtColor(mos8, cv2.COLOR_BGR2HSV)
sand = cov & (hsv[..., 2] > 120) & (hsv[..., 1] < 120)
gmean = mos[sand].mean(0)
base = np.empty_like(smallI); base[:] = gmean
for s in [400, 200, 90, 40]:
    L, b = nc(s); w = np.clip(b * 4, 0, 1)[..., None]; base = base * (1 - w) + L * w
base = cv2.resize(base, (B, B), interpolation=cv2.INTER_CUBIC)

# 2) fractal tone variation (light sand <-> brown sabkha) far from the imagery
def fbm(h, w, octs=6, seed=0):
    r = np.random.default_rng(seed); acc = np.zeros((h, w), np.float32); amp = 1; tot = 0
    for o in range(octs):
        nz = r.random((max(2, h >> (8 - o)), max(2, w >> (8 - o)))).astype(np.float32)
        acc += amp * cv2.resize(nz, (w, h), interpolation=cv2.INTER_CUBIC); tot += amp; amp *= 0.55
    return acc / tot
n1 = fbm(B, B, 7, 1); n1 = (n1 - n1.mean()) / n1.std()
light = np.float32(np.percentile(mos[sand], 80, axis=0)); dark = np.float32(np.percentile(mos[sand], 15, axis=0))
dist = cv2.distanceTransform((m < 0.5).astype(np.uint8), cv2.DIST_L2, 5)
far = np.clip(dist / 500, 0, 1)[..., None]
t = np.clip(0.5 + 0.35 * n1, 0, 1)[..., None]
tone = dark * (1 - t) + light * t
base = base * (1 - far * 0.75) + tone * (far * 0.75)

# 3) fine detail: zero-mean high-pass quilted from plain-sand patches
gray = cv2.cvtColor(mos8, cv2.COLOR_BGR2GRAY); edges = cv2.Canny(gray, 40, 110)
P = 256; cands = []
for y in range(0, H - P, 64):
    for x in range(0, W - P, 64):
        if sand[y:y + P, x:x + P].mean() < 0.97: continue
        if edges[y:y + P, x:x + P].mean() < 5: cands.append((x, y))
log("sand patches", len(cands))
hp = lambda p: p - cv2.GaussianBlur(p, (0, 0), 18)
det = np.zeros((B, B, 3), np.float32); ws = np.zeros((B, B), np.float32)
win = np.outer(np.hanning(P), np.hanning(P)).astype(np.float32) + 1e-3
for y in range(-P // 2, B, P // 2):
    for x in range(-P // 2, B, P // 2):
        sx, sy = cands[rng.integers(len(cands))]
        p = np.rot90(hp(mos[sy:sy + P, sx:sx + P]), rng.integers(4)).copy()
        y0, x0 = max(0, y), max(0, x); y1, x1 = min(B, y + P), min(B, x + P)
        if y1 <= y0 or x1 <= x0: continue
        py, px = y0 - y, x0 - x; ww = win[py:py + y1 - y0, px:px + x1 - x0]
        det[y0:y1, x0:x1] += p[py:py + y1 - y0, px:px + x1 - x0] * ww[..., None]; ws[y0:y1, x0:x1] += ww
det /= np.maximum(ws, 1e-3)[..., None]
syn = base + det * 1.1
del det, ws, base, tone, t, n1, far, smallI, smallM, hi, hw, lows, lo, lw
import gc; gc.collect()

# 4) Laplacian pyramid blend of imagery over the synthesis
def pyr_blend(Aa, Bb, mask, levels=6):
    ga = [Aa]; gb = [Bb]; gm = [mask]
    for _ in range(levels):
        ga.append(cv2.pyrDown(ga[-1])); gb.append(cv2.pyrDown(gb[-1])); gm.append(cv2.pyrDown(gm[-1]))
    out = ga[-1] * gm[-1][..., None] + gb[-1] * (1 - gm[-1][..., None])
    for i in range(levels - 1, -1, -1):
        size = (ga[i].shape[1], ga[i].shape[0])
        la = ga[i] - cv2.pyrUp(ga[i + 1], dstsize=size); lb = gb[i] - cv2.pyrUp(gb[i + 1], dstsize=size)
        out = cv2.pyrUp(out, dstsize=size) + la * gm[i][..., None] + lb * (1 - gm[i][..., None])
    return out
Aimg = img; Aimg[m < 0.5] = syn[m < 0.5]
mk = cv2.GaussianBlur(cv2.erode(m, np.ones((31, 31), np.uint8)), (0, 0), 14)
out = np.clip(pyr_blend(Aimg, syn, mk), 0, 255)
log("base blend done; coverage kept", round(float((mk > 0.5).mean()), 3))

# 5) asphalt where the routes leave the imagery
g = json.load(open(os.path.join(A, "geo.json"))); road = np.zeros((B, B), np.uint8)
def dp(pts, w): cv2.polylines(road, [((np.float32(pts) + PAD) * KB).astype(np.int32)], False, 255, max(2, int(w * KB)), cv2.LINE_AA)
def ext(a, b, L=2600):
    a = np.float32(a); d = a - np.float32(b); d /= np.linalg.norm(d); return (a + d * L).tolist()
imp = g["import"]["path"]; exp = g["export"]["path"]
dp([ext(imp[0], imp[1])] + imp[:2], 24); dp([ext(exp[0], exp[1])] + exp[:3], 44)
dp(imp[-3:] + [ext(imp[-1], imp[-2])], 24); dp(exp[-3:] + [ext(exp[-1], exp[-2])], 24)
cvm = cv2.dilate((m > 0.5).astype(np.uint8), np.ones((11, 11), np.uint8)).astype(bool)
rm = ((road > 0) & ~cvm).astype(np.float32); rmf = cv2.GaussianBlur(rm, (0, 0), 1.2)
sh = cv2.GaussianBlur(cv2.dilate(rm, np.ones((11, 11), np.uint8)), (0, 0), 5)
out = out * (1 - 0.22 * sh[..., None]) + np.float32([165, 175, 182]) * 0.22 * sh[..., None]
asph = np.float32([66, 68, 70]) + rng.normal(0, 3.5, (B, B, 1)).astype(np.float32)
out = np.clip(out * (1 - rmf[..., None]) + asph * rmf[..., None], 0, 255).astype(np.uint8)
cv2.imwrite(os.path.join(A, "ground_4096.jpg"), out, [cv2.IMWRITE_JPEG_QUALITY, 82, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
cv2.imwrite("ground_prev.jpg", cv2.resize(out, (1400, 1400), interpolation=cv2.INTER_AREA))
base_full = out.astype(np.float32)
log("base written")

# ---------- oriented high-resolution tiles ----------
hm = np.zeros((H, W), np.uint8)
for c in CL:
    h, w = c["img"].shape[:2]
    q = cv2.perspectiveTransform(np.float32([[0, 0], [w, 0], [w, h - 95], [0, h - 95]]).reshape(-1, 1, 2), c["H"]).reshape(-1, 2)
    cv2.fillPoly(hm, [q.astype(np.int32)], 255)
cnt, _ = cv2.findContours(hm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
(rcx, rcy), (rw, rh), rang = cv2.minAreaRect(max(cnt, key=cv2.contourArea))
a_ = np.deg2rad(rang); e1 = np.array([np.cos(a_), np.sin(a_)]); e2 = np.array([-np.sin(a_), np.cos(a_)])
if rw < rh: e1, e2, rw, rh = e2, e1, rh, rw          # e1 = long side
u = e1 if e1[1] > 0 else -e1                          # long axis, pointing "down" the image
v = np.array([-u[1], u[0]]); mu = np.array([rcx, rcy])
SCALE = 1.38                                           # texels per mosaic px (~0.58 m/texel, native close-up)
u0, u1 = -rw / 2 - 16, rw / 2 + 16; v0, v1 = -rh / 2 - 16, rh / 2 + 16
TU = 2048; nu = int(np.ceil((u1 - u0) * SCALE / TU)); nv = 1
TV = int(np.ceil((v1 - v0) * SCALE / 128) * 128)       # one row across the strip (NPOT is fine in WebGL2)
u0 -= (nu * TU / SCALE - (u1 - u0)) / 2; v0 -= (TV / SCALE - (v1 - v0)) / 2
log("tile grid", nu, "x", nv, "tile", TU, "x", TV)
tiles = []
for iu in range(nu):
    for iv in range(nv):
        o = mu + u * (u0 + iu * TU / SCALE) + v * (v0 + iv * TV / SCALE)
        # tile texel (a,b) -> mosaic p = o + a/S*v + b/S*u   (a across = image x, b along = image y)
        Mt = np.array([[v[0] / SCALE, u[0] / SCALE, o[0]], [v[1] / SCALE, u[1] / SCALE, o[1]], [0, 0, 1]])
        Mi = np.linalg.inv(Mt)  # mosaic -> tile
        hi, hw = composite(lambda c: Mi @ c["H"], (TV, TU), 80, 3.0)
        if (hw > 0.5).mean() < 0.03:
            continue
        hi = clear_lots(hi, Mi, 0.8 / SCALE)
        # fill/feather with the (upsampled) base texture outside close-up coverage
        bm = TB @ Mt
        bg = cv2.warpPerspective(base_full, bm, (TV, TU), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        fm = cv2.GaussianBlur(cv2.erode((hw > 0.5).astype(np.float32), np.ones((25, 25), np.uint8)), (0, 0), 10)
        fm = fm * (cv2.GaussianBlur(hw, (0, 0), 3) > 0.5)  # hard zero outside coverage
        flat = cv2.GaussianBlur(bg, (0, 0), 25)              # cheap-to-compress fill where the tile is transparent
        t_img = hi * fm[..., None] + bg * (1 - fm[..., None])
        t_img = np.where((fm < 0.01)[..., None], flat, t_img)
        t_img = np.clip(t_img, 0, 255).astype(np.uint8)
        name = f"hr_{iu}{iv}.jpg"; mname = f"hm_{iu}{iv}.png"
        cv2.imwrite(os.path.join(A, name), t_img, [cv2.IMWRITE_JPEG_QUALITY, 80, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
        cv2.imwrite(os.path.join(A, mname), cv2.resize((fm * 255).astype(np.uint8), (TV // 4, TU // 4), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_PNG_COMPRESSION, 9])
        corner = lambda a, b: (Mt @ np.array([a, b, 1.0]))[:2].round(2).tolist()
        tiles.append({"file": name, "mask": mname, "w": TV, "h": TU, "p00": corner(0, 0), "p10": corner(TV, 0), "p01": corner(0, TU)})
        log("tile", name, f"{os.path.getsize(os.path.join(A, name)) / 1e6:.2f} MB", "coverage", round(float((hw > 0.5).mean()), 2))

json.dump({"W": W, "H": H, "PAD": PAD, "Wp": Wp, "Hp": Hp, "edge": [float(x) for x in gmean[::-1]], "tiles": tiles},
          open(os.path.join(A, "tex.json"), "w"), indent=1)
log("done")
