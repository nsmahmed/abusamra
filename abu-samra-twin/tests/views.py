"""Screenshot named camera views of dist/wasl.html (for checking geometry by eye).

Usage: python tests/views.py out_dir name=flow,mx,my,dist,el,az [name=...] [--js "expr"]
  flow: import|export; mx,my: mosaic px of the camera target; dist in world units (10 m); el, az in radians.
  --js runs an expression after load (e.g. "setParam('xrayLanes',8,true)").
"""
import asyncio, sys, pathlib
from playwright.async_api import async_playwright

R = pathlib.Path(__file__).resolve().parent.parent
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
argv = sys.argv[1:]
OUT = pathlib.Path(argv.pop(0))
JS = []
while "--js" in argv:
    i = argv.index("--js"); JS.append(argv[i + 1]); del argv[i:i + 2]
VIEWS = [(a.split("=")[0], a.split("=")[1].split(",")) for a in argv]


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        b = None
        for ch in ("msedge", "chrome", None):
            try:
                b = await (p.chromium.launch(channel=ch, args=ARGS) if ch else p.chromium.launch(args=ARGS)); break
            except Exception:
                pass
        pg = await b.new_page(viewport={"width": 1600, "height": 900})
        logs = []
        pg.on("console", lambda m: logs.append(m.type + ": " + m.text))
        pg.on("pageerror", lambda e: logs.append("PAGEERROR: " + str(e)))
        await pg.add_init_script("try{localStorage.setItem('ast:helped','true')}catch(e){}")
        await pg.goto((R / "dist" / "wasl.html").as_uri())
        await pg.wait_for_timeout(9000)
        for j in JS:
            await pg.evaluate(j); await pg.wait_for_timeout(1500)
        flow = None
        for name, (f, mx, my, dist, el, az) in VIEWS:
            if f != flow and f in ("import", "export"):
                await pg.evaluate(f"setFlow('{f}')"); await pg.wait_for_timeout(5000); flow = f
            if name.startswith("ui"):
                await pg.screenshot(path=str(OUT / (name + ".png"))); continue
            await pg.evaluate(f"""(()=>{{userMoved=true;follow=false;camAnim=null;const [x,z]=conv([{mx},{my}]);controls.target.set(x,0,z);
              camera.position.set(x+Math.cos({az})*Math.cos({el})*{dist},Math.sin({el})*{dist},z+Math.sin({az})*Math.cos({el})*{dist});controls.update()}})()""")
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path=str(OUT / (name + ".png")))
        print("\n".join([l for l in logs if "GPU stall" not in l and "WebGL" not in l][:30]))
        await b.close()

asyncio.run(main())
