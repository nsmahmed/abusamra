"""Checks the WASL port model in a headless browser (no Node needed).

    python tests/model_test.py            # calibration, scenarios, goal seek
    python tests/model_test.py --js "m.evaluate({...m.today, xray: 3}).median"

It starts view/serve.py on a spare port, imports view/twin/portmodel.js and prints JSON.
Fails (exit 1) if today's synthetic median drifts from the learned current median by more than
0.6 h, if more capacity ever makes the median worse, or if goal seek returns no plans.
"""
import json, subprocess, sys, time, os, socket
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


CHECK = r"""
async () => {
  const { loadModel, CATS } = await import('/view/twin/portmodel.js');
  const m = await loadModel('/view/twin/');
  const t = m.today, r0 = m.baseRun, L = m.L;
  const run = (patch) => { const r = m.evaluate({ ...t, ...patch }); return { median: +r.median.toFixed(2), p90: +r.p90.toFixed(1), over12: +r.over12.toFixed(1), limit: r.limit, cap: Math.round(r.capacity), unstable: r.unstable }; };
  const out = {
    calib: m.calib, inferredAlloc: m.inferred, handover: m.handover.map(v => +v.toFixed(2)),
    today: { median: r0.median, p90: r0.p90, over12: r0.over12, learnedMedian: L.current.kpis.medianStayH, learnedP90: L.current.kpis.p90StayH,
             stages: Object.fromEntries(Object.entries(r0.stages).map(([k, v]) => [k, [Math.round(v.median), +v.share.toFixed(1)]])),
             util: r0.util, capacity: Math.round(r0.capacity), limit: r0.limit, bottleneck: r0.bottleneck, byCat: r0.byCat },
    xray3: run({ xray: 3 }), xray1: run({ xray: 1 }), docks160: run({ docks: 160, alloc: m.smartAlloc(160) }), smart130: run({ alloc: m.smartAlloc(130) }),
    shed: run({ alloc: { chem: 34, oga: 67, health: 29 } }), prefile50: run({ prefile: 50 }), green30: run({ green: 30 }), overlap: run({ overlap: 1 }),
    surge30: run({ surge: 30 }), surge109: run({ surge: 109 }), park450: run({ parking: 450 }),
    projection: m.projection(t).map(p => [p.year, Math.round(p.perDay), +p.median.toFixed(2), +p.p90.toFixed(1), p.limit, p.unstable]),
    presets: m.presets(), explain: m.explain(m.evaluate({ ...t, xray: 3, docks: 150, alloc: m.smartAlloc(150), prefile: 40 })).map(e => e.text),
  };
  const t0 = performance.now();
  const gs = await m.goalSeek({ target: 3.5 });
  out.goalSeek = { ms: Math.round(performance.now() - t0), searched: gs.searched, feasible: gs.feasible, reached: gs.reached,
    plans: gs.plans.map(p => ({ name: p.name, median: +p.median.toFixed(2), stress: +p.stress.toFixed(2), costM: +(p.cost / 1e6).toFixed(1), lead: p.lead, s: { x: p.s.xray, d: p.s.docks, a: p.s.alloc, pf: p.s.prefile, g: p.s.green, o: p.s.overlap, pk: p.s.parking }, contrib: p.contrib.map(c => [c.lever, +c.hours.toFixed(2)]) })) };
  const gs30 = await m.goalSeek({ target: 3.5, year: 2030 });
  out.goalSeek2030 = gs30.plans.map(p => ({ name: p.name, median: +p.median.toFixed(2), stress: +p.stress.toFixed(2), costM: +(p.cost / 1e6).toFixed(1), lead: p.lead, x: p.s.xray, d: p.s.docks, pf: p.s.prefile, g: p.s.green, o: p.s.overlap, pk: p.s.parking }));
  return out;
}
"""


def main():
    port = free_port()
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "view", "serve.py"), str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.2)
        with sync_playwright() as p:
            b = p.chromium.launch(channel="msedge", headless=True)
            pg = b.new_page()
            pg.on("console", lambda m: print("console:", m.text) if m.type == "error" else None)
            pg.goto(f"http://127.0.0.1:{port}/view/twin/config.json")
            if "--js" in sys.argv:
                expr = sys.argv[sys.argv.index("--js") + 1]
                res = pg.evaluate("async (e) => { const { loadModel } = await import('/view/twin/portmodel.js'); const m = await loadModel('/view/twin/'); return eval(e); }", expr)
                print(json.dumps(res, indent=1, default=str))
                return 0
            res = pg.evaluate(CHECK)
            print(json.dumps(res, indent=1, ensure_ascii=False))
            b.close()
        bad = []
        if abs(res["today"]["median"] - res["today"]["learnedMedian"]) > 0.6:
            bad.append("today's median drifts from the learned median")
        if res["xray3"]["median"] > res["today"]["median"] + 1e-6 or res["docks160"]["median"] > res["today"]["median"] + 1e-6:
            bad.append("more capacity made the median worse")
        if not res["goalSeek"]["plans"]:
            bad.append("goal seek returned no plans")
        for b_ in bad:
            print("FAIL:", b_)
        return 1 if bad else 0
    finally:
        srv.terminate()


if __name__ == "__main__":
    sys.exit(main())
