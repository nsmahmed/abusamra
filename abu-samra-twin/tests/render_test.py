"""Headless render of dist/abu-samra-twin.html with screenshots.

Usage: python tests/render_test.py [out_dir] [--night] [--illustrated]
Uses installed Edge/Chrome (channel) when available, else Playwright's Chromium.
three.js is served from node_modules/three when present (sandboxed CI), otherwise from the CDN.
"""
import asyncio, os, sys, pathlib
from playwright.async_api import async_playwright

R = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(next((a for a in sys.argv[1:] if not a.startswith("--")), R / "tests" / "shots"))
NIGHT = "--night" in sys.argv
PAGE = "abu-samra-twin-illustrated.html" if "--illustrated" in sys.argv else "abu-samra-twin.html"
NM = R / "node_modules" / "three"
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


async def launch(p):
    for ch in ("msedge", "chrome"):
        try:
            return await p.chromium.launch(channel=ch, args=ARGS)
        except Exception:
            pass
    return await p.chromium.launch(args=ARGS)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        b = await launch(p)
        pg = await b.new_page(viewport={"width": 1600, "height": 900})
        logs = []
        pg.on("console", lambda m: logs.append(m.type + ": " + m.text))
        pg.on("pageerror", lambda e: logs.append("PAGEERROR: " + str(e)))
        if NM.exists():
            async def route(r):
                u = r.request.url
                if "three.min.js" in u:
                    await r.fulfill(path=str(NM / "build/three.min.js"), content_type="application/javascript")
                elif "OrbitControls" in u:
                    await r.fulfill(path=str(NM / "examples/js/controls/OrbitControls.js"), content_type="application/javascript")
                else:
                    await r.continue_()
            await pg.route("**/*", route)
        await pg.add_init_script("try{localStorage.setItem('ast:helped','true')}catch(e){}")  # skip the first-run help
        await pg.goto((R / "dist" / PAGE).as_uri())
        await pg.wait_for_timeout(12000)
        shot = lambda n: pg.screenshot(path=str(OUT / n))
        await shot("r1_overview.png")
        box = await pg.locator("#stage").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        await pg.mouse.move(cx, cy)
        for _ in range(6):
            await pg.mouse.wheel(0, -300)
            await pg.wait_for_timeout(150)
        await pg.wait_for_timeout(2500)
        await shot("r2_zoom.png")
        # scripted low-angle views of the central customs plaza, the inspection yard and the main lot
        for name, (mx, my, dist, el, az) in {"r7_central.png": (1720, 1880, 55, 0.42, 2.3), "r8_yard.png": (2150, 2270, 45, 0.5, 2.6),
                                             "r9_lot.png": (1500, 2760, 50, 0.45, 2.2)}.items():
            await pg.evaluate(f"""(()=>{{userMoved=true;follow=false;const [x,z]=conv([{mx},{my}]);controls.target.set(x,0,z);
              camera.position.set(x+Math.cos({az})*Math.cos({el})*{dist},Math.sin({el})*{dist},z+Math.sin({az})*Math.cos({el})*{dist});controls.update()}})()""")
            await pg.wait_for_timeout(3500)
            await shot(name)
        # capacity change shown on the map: two more release lanes (gold) at the release gate
        await pg.evaluate("setParam('relGates',4,true)")
        await pg.wait_for_timeout(3500)
        await shot("r10_capacity.png")
        await pg.evaluate("setParam('relGates',2,true)")
        await pg.click("#recenter")
        await pg.evaluate("setFold('right',false);openTab('track')")
        await pg.click("#randBtn")
        await pg.wait_for_timeout(4000)
        await shot("r3_track.png")
        await pg.click("#fExport")
        await pg.wait_for_timeout(7000)
        await shot("r4_export.png")
        if NIGHT:  # jump the simulation clock to 21:30 (frame rate under SwiftShader is too low to time-lapse there)
            await pg.click("#fImport")
            await pg.wait_for_timeout(5000)
            await pg.click("#lighting [data-h='22.5']")
            await pg.wait_for_timeout(4000)
            await shot("r5_night.png")
            await pg.mouse.move(cx, cy)
            for _ in range(5):
                await pg.mouse.wheel(0, -300)
                await pg.wait_for_timeout(150)
            await pg.wait_for_timeout(3000)
            await shot("r6_night_zoom.png")
        print("\n".join([l for l in logs if "GPU stall" not in l][:25]))
        await b.close()

asyncio.run(main())
