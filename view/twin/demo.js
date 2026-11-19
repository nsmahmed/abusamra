/* Demo mode: the WASL story played inside the twin, like a guided video. Each scene drives the
   twin's own features (camera views, ride-along, scenario planner, goal seeking, executive board)
   and pops the headline number at the top. Every number comes from the learned model. */

import { fmtH, fmtQAR } from "./planner.js";
import { COUNTRY } from "./plates.js";

const WHY = { hour: "arrival hour", xray: "X-ray", decl: "several declarations", shared: "shared declaration", prefiled: "filing", cat: "goods category", country: "plate country" };

const fmtN = (v) => Math.round(v).toLocaleString("en-US");

export function createDemo(api) {
  const { pm } = api;
  const root = document.createElement("div");
  root.id = "demo";
  root.innerHTML = `
    <div class="dm-card">
      <div class="dm-kick"><b class="dm-letter"></b><span class="dm-chap"></span></div>
      <div class="dm-big"></div>
      <div class="dm-line"></div>
      <div class="dm-sub"></div>
      <div class="dm-bar"><i></i></div>
      <div class="dm-ctl">
        <button type="button" data-a="prev" title="Previous scene">‹</button>
        <button type="button" data-a="pause" title="Pause">❚❚</button>
        <button type="button" data-a="next" title="Next scene">›</button>
        <span class="dm-dots"></span>
        <button type="button" data-a="exit" title="End the demo (Esc)">✕</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const q = (s) => root.querySelector(s);

  const today = () => pm.baseRun;
  const surge2030 = Math.round((pm.growthFactor(2030) - 1) * 100);
  const ctx = {};

  /* Each scene: chapter letter, enter() sets the twin up and returns the caption, hold seconds. */
  const scenes = [
    {
      L: "", chap: "Abu Samra land port · digital twin", hold: 8,
      enter() {
        api.reset();
        api.view("overview");
        return { big: "WASL · وصل", line: "We connect you to your vision", sub: "Watch · Anticipate · Simulate · Lead", title: true };
      },
    },
    {
      L: "W", chap: "Watch · the port today", hold: 10,
      enter() {
        api.view("yard");
        return { count: [0, today().lamDay, fmtN], unit: "trucks a day", line: "A median day at Abu Samra", sub: "Demand, hourly rhythm and goods mix learned from 2026 gate passes" };
      },
    },
    {
      L: "W", chap: "Watch · time in port", hold: 10,
      enter() {
        const r = today();
        return { count: [0, r.median, (v) => v.toFixed(1)], unit: "hours", line: "Median time a truck spends in the port", sub: `Slowest 10%: ${fmtH(r.p90)} · ${Math.round(r.over12)}% of trucks stay over 12 hours` };
      },
    },
    {
      L: "W", chap: "Watch · the bottleneck", hold: 11,
      enter() {
        api.view("ramps");
        const r = today();
        return { count: [0, r.stages.decl.share, (v) => `${Math.round(v)}%`], line: "of all truck-hours are spent waiting for the declaration", sub: `No declaration is filed before the truck arrives · nearly every truck goes to the red lane` };
      },
    },
    {
      L: "W", chap: "Watch · every truck is learned", hold: 15,
      enter() {
        const v = api.followTruck();
        const risk = v && v.profile ? Math.round(v.profile.r * 100) : null;
        if (risk === null) return { big: "AI", line: "Every truck is drawn from the distributions learned from 198,665 real trucks", sub: "Plate, goods category, ramp and stage times" };
        /* how long this truck stays at each stage, from the learned model */
        const j = pm.journey(v.profile, today());
        const dur = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
        const stages = j ? [["Declaration", j.decl], v.profile.x ? ["X-ray", j.xq] : null, ["Wait for inspection", j.iq], ["Inspection", j.insp], ["Release", j.exit]].filter(Boolean).map(([n, m]) => `${n} ${dur(m)}`).join(" · ") : "";
        return {
          count: [0, risk, (x) => `${Math.round(x)}%`],
          line: `delay risk for this ${v.country ? `${(COUNTRY[v.country] || COUNTRY.XX).en}-plated ` : ""}truck${v.profile.why ? `, driven by ${v.profile.why.map((w) => WHY[w] || w).join(", ")}` : ""}`,
          sub: j ? `Time at each stage: ${stages} · total ${fmtH(j.total / 60)}` : "Synthetic truck learned from 198,665 real ones",
        };
      },
    },
    {
      L: "A", chap: "Anticipate · 2030 if nothing changes", hold: 11,
      enter() {
        api.stopFollow();
        api.setScenario({ ...pm.today, surge: surge2030 });
        api.view("overview");
        const r = pm.evaluate({ ...pm.today, surge: surge2030 });
        ctx.r2030 = r;
        return { count: [today().median, r.median, (v) => v.toFixed(1)], unit: "hours", bad: true, line: `Median time in port in 2030 · ${fmtN(r.lamDay)} trucks a day`, sub: `Learned growth of food declarations, damped to 2030 (+${surge2030}% trucks) · same resources as today` };
      },
    },
    {
      L: "A", chap: "Anticipate · where it breaks", hold: 11,
      enter() {
        api.view("yard");
        const r = ctx.r2030;
        return { count: [today().util.parking * 100, r.util.parking * 100, (v) => `${Math.round(v)}%`], bad: true, line: "Main parking at peak hour", sub: `${r.overflow > 0 ? `${fmtN(r.overflow)} trucks wait outside the gate · ` : ""}slowest 10% wait ${fmtH(r.p90)} · ${Math.round(r.over12)}% over 12 hours` };
      },
    },
    {
      L: "S", chap: "Simulate · set a goal", hold: 8, wait: true,
      async enter(show) {
        ctx.goal = 3.5;
        show({ big: `${ctx.goal} h`, line: "Goal: median time in port by 2030", sub: "Goal seeking runs the learned model in reverse over every lever within its limits…" });
        const g = await api.goalSeek(ctx.goal);
        ctx.g = g;
        return { count: [0, g.feasible, fmtN], line: `of ${fmtN(g.searched)} scenarios reach ${ctx.goal} h`, sub: "Each one is costed from public unit costs · three different plans are kept" };
      },
    },
    {
      L: "L", chap: "Lead · the decision", hold: 10,
      enter() {
        const g = ctx.g;
        const p = g.plans.find((x) => x.id === "resilient") || g.plans[0];
        ctx.p = p;
        /* the camera visits each change the plan makes; the scene lasts until it has seen them all */
        const secs = api.applyPlan(p);
        /* the plan already carries the 2030 traffic as its load increase */
        const after = pm.evaluate(p.s);
        ctx.after = after;
        const top = p.contrib.filter((c) => c.hours > 0.02).slice(0, 3).map((c) => ({ prefile: "pre-arrival filing", green: "green channel", overlap: "shift overlap", docks: "docks", xray: "X-ray lanes" }[c.lever] || c.lever));
        return { hold: Math.max(10, secs + 5), count: [ctx.r2030.median, after.median, (v) => v.toFixed(1)], unit: "hours", good: true, line: `${p.name} plan · median in 2030`, sub: `${fmtQAR(p.cost)} over 5 years · in service in ${p.lead} months · ${top.join(" + ")}` };
      },
    },
    {
      L: "L", chap: "Lead · before and after", hold: 11,
      enter() {
        api.exec(true);
        const saved = ctx.r2030.median - ctx.after.median;
        return { count: [0, saved, (v) => v.toFixed(1)], unit: "hours saved", good: true, line: "per truck in 2030, against continuing as is", sub: `As is: ${fmtH(ctx.r2030.median)} · with the plan: ${fmtH(ctx.after.median)} · today: ${fmtH(today().median)}` };
      },
    },
    {
      L: "", chap: "WASL", hold: 9,
      enter() {
        api.exec(false);
        api.view("overview");
        return { big: "WASL", line: "We connect you to your vision", sub: "Watch · Anticipate · Simulate · Lead", title: true };
      },
    },
  ];

  q(".dm-dots").innerHTML = scenes.map(() => "<i></i>").join("");
  const dots = [...root.querySelectorAll(".dm-dots i")];
  let k = -1;
  let left = 0;
  let paused = false;
  let busy = false;
  let anim = 0;
  let timer = 0;
  let token = 0;

  function show(c) {
    cancelAnimationFrame(anim);
    const big = q(".dm-big");
    root.classList.toggle("title", !!c.title);
    big.className = `dm-big ${c.bad ? "bad" : c.good ? "good" : ""}`;
    const unit = c.unit ? `<small>${c.unit}</small>` : "";
    if (c.count) {
      const [a, b, fmt] = c.count;
      const t0 = performance.now();
      const step = (t) => {
        const f = Math.min(1, (t - t0) / 2400);
        const e = 1 - (1 - f) ** 3;
        big.innerHTML = `${fmt(a + (b - a) * e)}${unit}`;
        if (f < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    } else big.innerHTML = `${c.big}${unit}`;
    q(".dm-line").textContent = c.line || "";
    q(".dm-sub").textContent = c.sub || "";
    const card = q(".dm-card");
    card.classList.remove("pop");
    void card.offsetWidth;
    card.classList.add("pop");
  }

  async function go(i) {
    if (i < 0) i = 0;
    if (i >= scenes.length) return stop();
    const my = ++token;
    k = i;
    const s = scenes[k];
    q(".dm-letter").textContent = s.L;
    q(".dm-letter").style.display = s.L ? "" : "none";
    q(".dm-chap").textContent = s.chap;
    dots.forEach((d, j) => d.classList.toggle("on", j <= k));
    busy = true;
    const c = await s.enter(show);
    if (my !== token) return;
    busy = false;
    show(c);
    left = total = c.hold || s.hold;
  }

  let total = 1;
  function tick() {
    if (paused || busy || k < 0) return;
    left -= 0.1;
    q(".dm-bar i").style.width = `${Math.max(0, Math.min(100, (1 - left / total) * 100))}%`;
    if (left <= 0) go(k + 1);
  }

  function start() {
    api.prepare();
    document.body.classList.add("demo-on");
    root.classList.add("on");
    paused = false;
    q('[data-a="pause"]').textContent = "❚❚";
    clearInterval(timer);
    timer = setInterval(tick, 100);
    go(0);
  }
  function stop() {
    token += 1;
    clearInterval(timer);
    cancelAnimationFrame(anim);
    k = -1;
    root.classList.remove("on");
    document.body.classList.remove("demo-on");
    api.finish();
  }

  root.addEventListener("click", (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (!a) return;
    if (a === "exit") stop();
    else if (a === "next" && !busy) go(k + 1);
    else if (a === "prev" && !busy) go(k - 1);
    else if (a === "pause") {
      paused = !paused;
      e.target.textContent = paused ? "▶" : "❚❚";
    }
  });
  addEventListener("keydown", (e) => {
    if (k < 0) return;
    if (e.key === "Escape") stop();
    else if (e.key === "ArrowRight" && !busy) go(k + 1);
    else if (e.key === "ArrowLeft" && !busy) go(k - 1);
  });

  return { start, stop, get running() { return k >= 0; } };
}
