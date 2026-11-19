/* Demo mode: the WASL story played inside the twin, like a guided video. Each scene drives the
   twin's own features (camera views, ride-along, scenario planner, goal seeking, executive board)
   and pops the headline number at the top. Every number comes from the learned model. */

import { fmtH, fmtQAR } from "./planner.js";

/* count-up length, and the reading speed used to give long captions enough time */
const COUNT_MS = 3500;
const WORDS_PER_SEC = 2;
const YEARS = [2026, 2027, 2028, 2029, 2030];

/* A small line chart for the story card; lines draw in from left to right. */
function chartSVG(ch) {
  const W = 560, H = 180, L = 50, R = 92, T = 16, B = 28;
  const all = ch.series.flatMap((s) => s.v).concat(ch.goal != null ? [ch.goal] : []);
  const top = Math.max(...all);
  const lo0 = ch.min ?? Math.min(...all) * 0.9;
  const raw = (top * 1.05 - lo0) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((v) => v >= raw);
  const lo = Math.floor(lo0 / step) * step;
  const hi = lo + step * Math.ceil((top * 1.02 - lo) / step);
  const x = (i) => L + (i / (ch.x.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let g = "";
  for (let v = lo; v <= hi + 1e-9; v += step) g += `<line class="ax" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${ch.yFmt(Math.round(v * 10) / 10)}</text>`;
  ch.x.forEach((yr, i) => (g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${yr}</text>`));
  if (ch.axis) g += `<text x="${L}" y="${T - 6}" font-size="10">${ch.axis}</text>`;
  if (ch.goal != null) g += `<line class="goal" x1="${L}" x2="${W - R}" y1="${y(ch.goal)}" y2="${y(ch.goal)}"/><text class="goal-t fade" x="${L + 6}" y="${y(ch.goal) - 6}">Goal ${ch.goal} h</text>`;
  for (const s of ch.series) {
    const d = s.v.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const last = s.v[s.v.length - 1];
    const ex = x(s.v.length - 1);
    const ey = y(last);
    g += `<path class="ln" d="${d}" stroke="${s.color}"/>`;
    g += `<g class="fade"><circle cx="${ex}" cy="${ey}" r="4.5" fill="${s.color}"/><text class="end" x="${ex + 10}" y="${ey + (s.label ? 0 : 5)}" style="fill:${s.color}">${s.fmt(last)}</text>${s.label ? `<text x="${ex + 10}" y="${ey + 14}">${s.label}</text>` : ""}</g>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}">${g}</svg>`;
}

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
      <div class="dm-chart"></div>
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
      L: "", chap: "Abu Samra land port · digital twin", hold: 12,
      enter() {
        api.reset();
        api.view("overview");
        return { big: "WASL · وصل", line: "We connect you to your vision", sub: "Watch · Anticipate · Simulate · Lead", title: true };
      },
    },
    {
      L: "W", chap: "Watch · the port today", hold: 16,
      enter() {
        api.view("yard");
        return { count: [0, today().lamDay, fmtN], unit: "trucks a day", line: "A median day at Abu Samra", sub: "Demand, hourly rhythm and goods mix learned from 2026 gate passes" };
      },
    },
    {
      L: "W", chap: "Watch · time in port", hold: 16,
      enter() {
        const r = today();
        return { count: [0, r.median, (v) => v.toFixed(1)], unit: "hours", line: "Median time a truck spends in the port", sub: `Slowest 10%: ${fmtH(r.p90)} · ${Math.round(r.over12)}% of trucks stay over 12 hours` };
      },
    },
    {
      L: "W", chap: "Watch · the bottleneck", hold: 18,
      enter() {
        api.view("ramps");
        const r = today();
        return { count: [0, r.stages.decl.share, (v) => `${Math.round(v)}%`], line: "of all truck-hours are spent waiting for the declaration", sub: `No declaration is filed before the truck arrives · nearly every truck goes to the red lane` };
      },
    },
    {
      L: "W", chap: "Watch · every truck is learned", hold: 24,
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
          line: "delay risk for this truck (over 8 hours in port)",
          sub: j ? `Time at each stage: ${stages} · total ${fmtH(j.total / 60)}` : "Synthetic truck learned from 198,665 real ones",
        };
      },
    },
    {
      L: "A", chap: "Anticipate · traffic to 2030", hold: 20,
      enter() {
        api.stopFollow();
        api.setScenario({ ...pm.today, surge: surge2030 });
        api.view("yard");
        ctx.r2030 = pm.evaluate({ ...pm.today, surge: surge2030 });
        const per = YEARS.map((year) => pm.evaluate({ ...pm.today, year }).lamDay);
        return {
          count: [today().lamDay, ctx.r2030.lamDay, fmtN], unit: "trucks a day", bad: true,
          line: `Expected trucks a day by 2030 · +${surge2030}%`,
          sub: "Learned growth of food declarations, damped year by year",
          chart: { x: YEARS, series: [{ v: per, color: "#ff8e99", fmt: fmtN }], yFmt: fmtN, axis: "trucks a day" },
        };
      },
    },
    {
      L: "A", chap: "Anticipate · where it breaks", hold: 22,
      enter() {
        api.view("overview");
        const r = ctx.r2030;
        api.pulseBottlenecks(r);
        return { count: [today().median, r.median, (v) => v.toFixed(1)], unit: "hours", bad: true, line: "Median time in port in 2030 with today's resources", sub: "Red: where trucks wait · the main parking fills at peak, the X-ray and inspection queues grow" };
      },
    },
    {
      L: "S", chap: "Simulate · set a goal", hold: 16, wait: true,
      async enter(show) {
        ctx.goal = Math.ceil(today().median * 2) / 2;
        show({ big: `${ctx.goal} h`, line: "Goal: keep 2030 at today's time in port", sub: "Goal seeking runs the learned model in reverse over X-ray lanes, inspection docks and parking…" });
        const g = await api.goalSeek(ctx.goal, true);
        ctx.g = g;
        return { count: [0, g.feasible, fmtN], line: `of ${fmtN(g.searched)} infrastructure plans reach ${ctx.goal} h in 2030`, sub: "Each one is costed from public unit costs · three different plans are kept" };
      },
    },
    {
      L: "L", chap: "Lead · the decision", hold: 18,
      enter() {
        const g = ctx.g;
        const p = g.plans.find((x) => x.id === "resilient") || g.plans[0];
        ctx.p = p;
        /* the camera visits each change the plan makes; the scene lasts until it has seen them all */
        const secs = api.applyPlan(p);
        const after = pm.evaluate(p.s);
        ctx.after = after;
        const t = pm.today;
        const adds = [
          p.s.xray > t.xray ? `${p.s.xray - t.xray} X-ray ${p.s.xray - t.xray === 1 ? "lane" : "lanes"}` : "",
          p.s.docks > t.docks ? `${p.s.docks - t.docks} inspection docks` : "",
          p.s.parking > t.parking ? `${p.s.parking - t.parking} parking bays` : "",
        ].filter(Boolean);
        return { hold: Math.max(18, secs + 8), count: [ctx.r2030.median, after.median, (v) => v.toFixed(1)], unit: "hours", good: true, line: `${p.name} plan · median in 2030`, sub: `Adds ${adds.join(" and ") || "no new resources"} · ${fmtQAR(p.cost)} over 5 years · in service in ${p.lead} months` };
      },
    },
    {
      L: "L", chap: "Lead · time in port to 2030", hold: 22,
      enter() {
        api.view("overview");
        const asIs = pm.projection(pm.today).map((r) => r.median);
        const withPlan = pm.projection({ ...ctx.p.s, surge: 0 }).map((r) => r.median);
        const saved = ctx.r2030.median - ctx.after.median;
        const h = (v) => `${v.toFixed(1)} h`;
        return {
          count: [0, saved, (v) => v.toFixed(1)], unit: "hours saved per truck", good: true,
          line: "Median time in port, as is against the plan",
          sub: `As is: ${h(ctx.r2030.median)} in 2030 · with the plan: ${h(ctx.after.median)} · today: ${h(today().median)}`,
          chart: { x: YEARS, series: [{ v: asIs, color: "#ff8e99", label: "As is", fmt: h }, { v: withPlan, color: "#6fe3c8", label: "With plan", fmt: h }], goal: ctx.goal, yFmt: (v) => `${v} h`, axis: "hours", min: 0 },
        };
      },
    },
    {
      L: "", chap: "WASL", hold: 12,
      enter() {
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
        const f = Math.min(1, (t - t0) / COUNT_MS);
        const e = 1 - (1 - f) ** 3;
        big.innerHTML = `${fmt(a + (b - a) * e)}${unit}`;
        if (f < 1) anim = requestAnimationFrame(step);
      };
      anim = requestAnimationFrame(step);
    } else big.innerHTML = `${c.big}${unit}`;
    const box = q(".dm-chart");
    box.classList.remove("done");
    box.innerHTML = c.chart ? chartSVG(c.chart) : "";
    if (c.chart) {
      for (const path of box.querySelectorAll(".ln")) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = len;
        path.style.strokeDashoffset = len;
        path.getBoundingClientRect();
        path.style.transition = `stroke-dashoffset ${COUNT_MS / 1000}s ease-in-out`;
        path.style.strokeDashoffset = 0;
      }
      clearTimeout(box.t);
      box.t = setTimeout(() => box.classList.add("done"), COUNT_MS);
    }
    q(".dm-line").textContent = c.line || "";
    q(".dm-sub").textContent = c.sub || "";
    const card = q(".dm-card");
    card.classList.remove("dm-in");
    void card.offsetWidth;
    card.classList.add("dm-in");
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
    if (api.clearPulses) api.clearPulses();
    const c = await s.enter(show);
    if (my !== token) return;
    busy = false;
    show(c);
    /* never shorter than the time to read the caption slowly, after the number has counted up */
    const words = `${c.line || ""} ${c.sub || ""}`.split(/\s+/).filter(Boolean).length;
    left = total = Math.max(c.hold || s.hold, COUNT_MS / 1000 + 4 + words / WORDS_PER_SEC);
  }

  let total = 1;
  function tick() {
    if (paused || busy || k < 0) return;
    /* hold the clock while the camera is still flying to the scene */
    if (api.moving && api.moving()) return;
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
