"""Headless walk through the WASL features with screenshots.

Usage: python tests/ui_test.py out_dir [--quick]   (--quick skips the goal-seek run, which takes minutes under SwiftShader)
Shots: trucks close-up, X-ray tunnels, operational parking (export), Filters + bottleneck pattern, Text to map,
goal seek studio (light and dark), a visualized plan.
"""
import asyncio, sys, pathlib
from playwright.async_api import async_playwright

R = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(next((a for a in sys.argv[1:] if not a.startswith("--")), R / "tests" / "ui"))
QUICK = "--quick" in sys.argv
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]


def cam(mx, my, dist, el, az):
    return f"""(()=>{{userMoved=true;follow=false;camAnim=null;const [x,z]=conv([{mx},{my}]);controls.target.set(x,0,z);
      camera.position.set(x+Math.cos({az})*Math.cos({el})*{dist},Math.sin({el})*{dist},z+Math.sin({az})*Math.cos({el})*{dist});controls.update()}})()"""


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
        await pg.wait_for_timeout(10000)
        shot = lambda n: pg.screenshot(path=str(OUT / n))
        await shot("u1_overview.png")
        await pg.evaluate("setSpeed(0.1666667)")
        await pg.evaluate(cam(1500, 2760, 9, 0.38, 2.4)); await pg.wait_for_timeout(2500); await shot("u2_trucks.png")
        await pg.evaluate(cam(1500, 2700, 5, 0.25, 1.4)); await pg.wait_for_timeout(2500); await shot("u2b_trucks_close.png")
        await pg.evaluate(cam(1363, 2449, 18, 0.55, 2.9)); await pg.wait_for_timeout(2500); await shot("u3_xray.png")
        await pg.evaluate("setParam('xrayLanes',8,true)"); await pg.wait_for_timeout(2500); await shot("u3b_xray_added.png")
        await pg.evaluate("setParam('xrayLanes',6,false);setSpeed(2)")
        await pg.evaluate("recenter.click();setFold('right',false);openTab('filters')"); await pg.wait_for_timeout(4000)
        await pg.evaluate("updateFilterPanel(true)"); await pg.wait_for_timeout(500); await shot("u4_filters.png")
        await pg.evaluate("toggleF(facets()[0],'red')"); await pg.wait_for_timeout(1500); await shot("u4b_filter_red.png")
        await pg.evaluate("clearFilters();setPtab('text');document.getElementById('ttmIn').value='Add 2 X-ray lanes, cut clearance time by 30 minutes and expand main parking by 100 slots. Also paint the gates blue.';runTTM()")
        await pg.wait_for_timeout(800); await shot("u5_text.png")
        await pg.evaluate("document.documentElement.dataset.theme='dark'"); await pg.wait_for_timeout(800); await shot("u5b_text_dark.png")
        await pg.evaluate("document.documentElement.dataset.theme='light';setFlow('export')"); await pg.wait_for_timeout(5000)
        await pg.evaluate(cam(1600, 1545, 30, 0.85, 1.3)); await pg.wait_for_timeout(2500); await shot("u6_export_park.png")
        await pg.evaluate("setFlow('import')"); await pg.wait_for_timeout(4000)
        if not QUICK:
            await pg.evaluate("setPtab('goal')"); await pg.wait_for_timeout(6000); await shot("u7_goal.png")
            await pg.evaluate("(async()=>{await refreshGoalNow();setGoal(4);GS.touched=true;document.getElementById('gsRun').click()})()")
            for _ in range(600):
                await pg.wait_for_timeout(1000)
                if await pg.evaluate("!!GS.res&&!GS.running"): break
            await pg.wait_for_timeout(1000); await shot("u8_studio.png")
            await pg.mouse.move(700, 700); await pg.wait_for_timeout(400); await shot("u8b_studio_hover.png")
            await pg.evaluate("document.documentElement.dataset.theme='dark'"); await pg.wait_for_timeout(800); await shot("u8c_studio_dark.png")
            await pg.evaluate("document.documentElement.dataset.theme='light';visualizePlan('balanced')"); await pg.wait_for_timeout(6000); await shot("u9_visualized.png")
        print("\n".join([l for l in logs if "GPU stall" not in l][:30]))
        await b.close()

asyncio.run(main())
