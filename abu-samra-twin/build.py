"""Assemble the single-file twins from src/ + assets/.

    python build.py            -> dist/abu-samra-twin.html              (satellite imagery)
                                  dist/abu-samra-twin-illustrated.html  (illustrated rendering, when assets/illus/ exists)
Each page links to the other through ALT_HREF (relative, so both must sit in the same folder).
"""
import json, base64, pathlib
R = pathlib.Path(__file__).parent; S = R / "src"; A = R / "assets"
VARIANTS = {"photo": ("abu-samra-twin.html", A, "abu-samra-twin-illustrated.html"),
            "illustrated": ("abu-samra-twin-illustrated.html", A / "illus", "abu-samra-twin.html")}
g = json.load(open(A / "geo.json", encoding="utf-8")); t = json.load(open(A / "tex.json")); t.update({"W": 3598, "H": 3580, "PAD": 700})
rd = lambda f: (S / f).read_text(encoding="utf-8")
strip = lambda f: "\n".join(l for l in rd(f).splitlines() if not l.startswith("if(typeof module"))
mime = lambda f: "image/png" if f.endswith(".png") else "image/jpeg"
have_illus = (A / "illus" / "ground_4096.jpg").exists()
(R / "dist").mkdir(exist_ok=True)
for variant, (out, src, alt) in VARIANTS.items():
    if variant == "illustrated" and not have_illus:
        continue
    b64 = lambda f: base64.b64encode((src / f).read_bytes()).decode()
    # alpha masks are shared; colour tiles come from the variant folder
    uris = {}
    for tl in t.get("tiles", []):
        uris[tl["file"]] = f"data:{mime(tl['file'])};base64,{b64(tl['file'])}"
        uris[tl["mask"]] = f"data:image/png;base64,{base64.b64encode((A / tl['mask']).read_bytes()).decode()}"
    data = (f"const VARIANT={json.dumps(variant)};const ALT_HREF={json.dumps(alt if have_illus else '')};\n"
            f"const GEOJ={json.dumps(g, separators=(',', ':'))};\nconst TEXINFO={json.dumps(t, separators=(',', ':'))};\n"
            f"const GROUND_URI='data:image/jpeg;base64,{b64('ground_4096.jpg')}';\nconst HR_URIS={json.dumps(uris)};\n")
    title = "Abu Samra Twin" + (" — Illustrated" if variant == "illustrated" else "")
    html = (rd("head.html").replace("<title>Abu Samra Twin</title>", f"<title>{title}</title>")
            + '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>\n'
            + '<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>\n'
            + "<script>\n" + data + strip("sim.js") + "\n" + strip("flows.js") + "\n" + rd("app.js") + "\n</script>\n" + rd("tail.html"))
    (R / "dist" / out).write_text(html, encoding="utf-8"); print("built", out, len(html) // 1024, "KB")
