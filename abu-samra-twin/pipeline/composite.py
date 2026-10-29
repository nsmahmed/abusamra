"""Full-resolution composite of the registered close-ups in mosaic-aligned axes (1.38 px per mosaic px).
Run from pipeline/work after register.py. Writes hr_full.png, used by buildings.py, trees.py and lotclean.py."""
import cv2, numpy as np, json, os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "map-imagery")
C = json.load(open("closeups.json")); S = 1.38; W, H = int(3598 * S), int(3580 * S)
M = np.diag([S, S, 1.0]); acc = np.zeros((H, W, 3), np.float32); ws = np.zeros((H, W), np.float32)
for name, v in C.items():
    img = cv2.imread(os.path.join(D, name))[..., :3].astype(np.float32); h, w = img.shape[:2]
    mk = np.full((h, w), 255, np.uint8); mk[h - 95:] = 0; mk[:10] = 0; mk[h - 200:, w - 560:] = 0; mk[h - 190:, :160] = 0; mk[:, :3] = 0; mk[:, -3:] = 0
    d = np.clip(cv2.distanceTransform(mk, cv2.DIST_L2, 5) / 80, 0, 1) ** 3; Mi = M @ np.array(v["H"])
    wt = cv2.warpPerspective(d, Mi, (W, H)); acc += cv2.warpPerspective(img, Mi, (W, H), flags=cv2.INTER_CUBIC) * wt[..., None]; ws += wt
out = (acc / np.maximum(ws, 1e-6)[..., None]).clip(0, 255).astype(np.uint8); out[ws < 1e-4] = 0
cv2.imwrite("hr_full.png", out); print(out.shape)
