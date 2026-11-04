"""Assemble the single-file WASL twin from src/ + assets/.

    python build.py   -> dist/wasl.html  (illustrated ground from assets/illus/, alpha masks from assets/)
"""
import json, base64, pathlib
R = pathlib.Path(__file__).parent; S = R / "src"; A = R / "assets"; IL = A / "illus"
g = json.load(open(A / "geo.json", encoding="utf-8")); t = json.load(open(A / "tex.json")); t.update({"W": 3598, "H": 3580, "PAD": 700})
rd = lambda f: (S / f).read_text(encoding="utf-8")
strip = lambda f: "\n".join(l for l in rd(f).splitlines() if not l.startswith("if(typeof module"))
b64 = lambda p: base64.b64encode(p.read_bytes()).decode()
uris = {}
for tl in t.get("tiles", []):
    uris[tl["file"]] = f"data:image/jpeg;base64,{b64(IL / tl['file'])}"
    uris[tl["mask"]] = f"data:image/png;base64,{b64(A / tl['mask'])}"
# the engine source again as a string, so goal seeking can run forecasts in Web Workers (blob URLs)
sim_src = strip("sim.js") + "\n" + strip("flows.js")
data = (f"const SIM_SRC={json.dumps(sim_src)};\nconst GEOJ={json.dumps(g, separators=(',', ':'))};\nconst TEXINFO={json.dumps(t, separators=(',', ':'))};\n"
        f"const GROUND_URI='data:image/jpeg;base64,{b64(IL / 'ground_4096.jpg')}';\nconst HR_URIS={json.dumps(uris)};\n")
html = (rd("head.html")
        + '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>\n'
        + '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>\n'
        + "<script>\n" + data + strip("sim.js") + "\n" + strip("flows.js") + "\n" + strip("plan.js") + "\n" + rd("app.js") + "\n</script>\n" + rd("tail.html"))
(R / "dist").mkdir(exist_ok=True)
(R / "dist" / "wasl.html").write_text(html, encoding="utf-8"); print("built wasl.html", len(html) // 1024, "KB")
