/* Demo mode: the WASL story played inside the twin, like a guided video. Each scene drives the
   twin's own features (camera views, ride-along, scenario planner, goal seeking) and pops the
   headline number at the top. Every number comes from the learned model, with the planner's
   default limits, so every viewer sees the same story with the same numbers; only the truck the
   camera rides along with differs. English and Arabic follow the twin's language. */

/* count-up length, and the reading speed used to give long captions enough time */
const COUNT_MS = 3500;
const DOTS_MS = 5200;
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
  if (ch.goal != null) g += `<line class="goal" x1="${L}" x2="${W - R}" y1="${y(ch.goal)}" y2="${y(ch.goal)}"/><text class="goal-t fade" x="${L + 6}" y="${y(ch.goal) - 6}">${ch.goalLabel}</text>`;
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
      <div class="dm-grid"></div>
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

  const ar = () => api.lang() === "ar";
  const T = (en, arText) => (ar() ? arText : en);
  const hrs = (v) => (ar() ? `${v.toFixed(1)} ساعة` : `${v.toFixed(1)} h`);
  const qar = (v) => (ar() ? `${Math.round(v / 1e6)} مليون ريال` : `QAR ${Math.round(v / 1e6)} M`);
  const today = () => pm.baseRun;
  const surge2030 = Math.round((pm.growthFactor(2030) - 1) * 100);
  const ctx = {};

  /* Fixed facts from the learned model, the same for every viewer. */
  const facts = (() => {
    const r = pm.baseRun;
    let over8 = 0;
    for (const v of r.stay) if (v > 480) over8 += 1;
    const oga = (pm.pattern(r, "iq") || []).find((p) => p.key === "oga");
    return { over8: (over8 / r.stay.length) * 100, ogaLift: oga ? oga.lift : null, ogaHours: r.byCat ? r.byCat.oga : null };
  })();

  /* Each scene: chapter letter, enter() sets the twin up and returns the caption, hold seconds. */
  const scenes = [
    {
      L: "", chap: () => T("Abu Samra land port · digital twin", "منفذ أبو سمرة البري · التوأم الرقمي"), hold: 12,
      enter() {
        api.reset();
        api.view("overview");
        return { big: "WASL · وصل", line: T("We connect you to your vision", "نوصلك إلى رؤيتك"), sub: T("Watch · Anticipate · Simulate · Lead", "راقب · توقّع · حاكِ · قُد"), title: true };
      },
    },
    {
      L: "W", chap: () => T("Watch · the port today", "راقب · المنفذ اليوم"), hold: 16,
      enter() {
        api.view("yard");
        return { count: [0, today().lamDay, fmtN], unit: T("trucks a day", "شاحنة يوميًا"), line: T("A median day at Abu Samra", "يوم وسيط في أبو سمرة"), sub: T("Demand, hourly rhythm and goods mix learned from 2026 gate passes", "الطلب والإيقاع الساعي ومزيج البضائع مستفادة من تصاريح بوابات 2026") };
      },
    },
    {
      L: "W", chap: () => T("Watch · time in port", "راقب · زمن البقاء في المنفذ"), hold: 16,
      enter() {
        const r = today();
        return { count: [0, r.median, (v) => v.toFixed(1)], unit: T("hours", "ساعة"), line: T("Median time a truck spends in the port", "الزمن الوسيط لبقاء الشاحنة في المنفذ"), sub: T(`Slowest 10%: ${hrs(r.p90)} · ${Math.round(r.over12)}% of trucks stay over 12 hours`, `أبطأ 10%: ${hrs(r.p90)} · ${Math.round(r.over12)}% من الشاحنات تبقى أكثر من 12 ساعة`) };
      },
    },
    {
      L: "W", chap: () => T("Watch · bottleneck analysis", "راقب · تحليل الاختناقات"), hold: 20,
      enter() {
        const lift = facts.ogaLift;
        api.focusShed("oga", T("OGA inspection", "تفتيش الجهات الحكومية"), lift ? T(`${lift.toFixed(1)}× among the slowest`, `${lift.toFixed(1)}× بين الأبطأ`) : "");
        return lift
          ? { count: [1, lift, (v) => `${v.toFixed(1)}×`], line: T("OGA trucks (restricted goods) are over-represented among the slowest to get inspected", "شاحنات الجهات الحكومية الأخرى (بضائع مقيدة) هي الأكثر حضورًا بين الأبطأ في التفتيش"), sub: T("Bottleneck analysis: WASL reads every truck's journey in the data to find where time is lost", "تحليل الاختناقات: يقرأ وصل رحلة كل شاحنة في البيانات ليجد أين يضيع الوقت") }
          : { big: T("Analysis", "تحليل"), line: T("WASL reads every truck's journey to find where time is lost", "يقرأ وصل رحلة كل شاحنة ليجد أين يضيع الوقت") };
      },
    },
    {
      L: "W", chap: () => T("Watch · every truck is learned", "راقب · كل شاحنة متعلَّمة"), hold: 22,
      enter() {
        api.followTruck();
        return { count: [0, facts.over8, (x) => `${Math.round(x)}%`], line: T("of trucks stay in the port over 8 hours", "من الشاحنات تبقى في المنفذ أكثر من 8 ساعات"), sub: T("Each truck on screen is drawn from 198,665 real ones and carries its own learned delay risk · its time at each stage floats above it", "كل شاحنة على الشاشة مأخوذة من 198,665 شاحنة حقيقية ولها احتمال تأخير متعلَّم · زمنها في كل مرحلة فوقها") };
      },
    },
    {
      L: "A", chap: () => T("Anticipate · traffic to 2030", "توقّع · الحركة حتى 2030"), hold: 20,
      enter() {
        api.stopFollow();
        api.setScenario({ ...pm.today, surge: surge2030 });
        api.view("yard");
        ctx.r2030 = pm.evaluate({ ...pm.today, surge: surge2030 });
        const per = YEARS.map((year) => pm.evaluate({ ...pm.today, year }).lamDay);
        return {
          count: [today().lamDay, ctx.r2030.lamDay, fmtN], unit: T("trucks a day", "شاحنة يوميًا"), bad: true,
          line: T(`Expected trucks a day by 2030 · +${surge2030}%`, `الشاحنات المتوقعة يوميًا بحلول 2030 · +${surge2030}%`),
          sub: T("Learned growth of food declarations, damped year by year", "نمو متعلَّم من بيانات الأغذية، مخفّف عامًا بعد عام"),
          chart: { x: YEARS, series: [{ v: per, color: "#ff8e99", fmt: fmtN }], yFmt: fmtN, axis: T("trucks a day", "شاحنة يوميًا") },
        };
      },
    },
    {
      L: "A", chap: () => T("Anticipate · where it breaks", "توقّع · أين يحدث الانهيار"), hold: 22,
      enter() {
        api.view("overview");
        const r = ctx.r2030;
        api.pulseBottlenecks(r);
        return { count: [today().median, r.median, (v) => v.toFixed(1)], unit: T("hours", "ساعة"), bad: true, line: T("Median time in port in 2030 with today's resources", "الزمن الوسيط في المنفذ عام 2030 بموارد اليوم"), sub: T("Red: where trucks wait · the main parking fills at peak, the X-ray and inspection queues grow", "بالأحمر: أين تنتظر الشاحنات · المواقف تمتلئ وقت الذروة وطوابير الأشعة والتفتيش تطول") };
      },
    },
    {
      L: "S", chap: () => T("Simulate · searching for plans", "حاكِ · البحث عن الخطط"), hold: 18, wait: true,
      async enter(show) {
        ctx.goal = Math.ceil(today().median * 2) / 2;
        show({ big: `${ctx.goal} ${T("h", "ساعة")}`, line: T("Goal: keep 2030 at today's time in port", "الهدف: إبقاء زمن 2030 عند مستوى اليوم"), sub: T("Goal seeking runs the learned model in reverse over X-ray lanes, inspection docks and parking…", "البحث عن الهدف يشغّل النموذج عكسيًا على مسارات الأشعة وأرصفة التفتيش والمواقف…") });
        const g = await api.goalSeek(ctx.goal, true);
        ctx.g = g;
        return {
          count: [0, g.searched, fmtN], countMs: DOTS_MS, unit: T("tries", "محاولة"),
          line: T(`${fmtN(g.feasible)} reach the goal of ${ctx.goal} h`, `${fmtN(g.feasible)} تحقق هدف ${ctx.goal} ساعة`),
          sub: T("Each try is one plan run through the learned model and costed · three different plans are kept", "كل محاولة خطة تمر عبر النموذج وتُحسب تكلفتها · نحتفظ بثلاث خطط مختلفة"),
          grid: { trials: g.trials, picks: g.plans.map((p) => p.idx) },
        };
      },
    },
    {
      L: "L", chap: () => T("Lead · the decision", "قُد · القرار"), hold: 18,
      enter() {
        const g = ctx.g;
        const p = g.plans.find((x) => x.id === "resilient") || g.plans[0];
        ctx.p = p;
        /* the camera visits each change the plan makes; the scene lasts until it has seen them all */
        const secs = api.applyPlan(p);
        const after = pm.evaluate(p.s);
        ctx.after = after;
        const t = pm.today;
        const dx = p.s.xray - t.xray;
        const dd = p.s.docks - t.docks;
        const dp = p.s.parking - t.parking;
        const adds = ar()
          ? [dx > 0 ? `${dx} مسار أشعة` : "", dd > 0 ? `${dd} رصيف تفتيش` : "", dp > 0 ? `${dp} موقف` : ""].filter(Boolean).join(" و")
          : [dx > 0 ? `${dx} X-ray ${dx === 1 ? "lane" : "lanes"}` : "", dd > 0 ? `${dd} inspection docks` : "", dp > 0 ? `${dp} parking bays` : ""].filter(Boolean).join(" and ");
        const name = ar() ? { cheap: "الأوفر", resilient: "المرنة", best: "الأفضل نتيجة" }[p.id] || p.name : p.name;
        return {
          hold: Math.max(18, secs + 8), count: [ctx.r2030.median, after.median, (v) => v.toFixed(1)], unit: T("hours", "ساعة"), good: true,
          line: T(`${name} plan · median in 2030`, `الخطة ${name} · الزمن الوسيط عام 2030`),
          sub: T(`Adds ${adds} · ${qar(p.cost)} over 5 years · in service in ${p.lead} months`, `تضيف ${adds} · ${qar(p.cost)} على 5 سنوات · تعمل خلال ${p.lead} شهرًا`),
        };
      },
    },
    {
      L: "L", chap: () => T("Lead · time in port to 2030", "قُد · زمن البقاء حتى 2030"), hold: 22,
      enter() {
        api.view("overview");
        const asIs = pm.projection(pm.today).map((r) => r.median);
        const withPlan = pm.projection({ ...ctx.p.s, surge: 0 }).map((r) => r.median);
        const saved = ctx.r2030.median - ctx.after.median;
        return {
          count: [0, saved, (v) => v.toFixed(1)], unit: T("hours saved per truck", "ساعة توفير لكل شاحنة"), good: true,
          line: T("Median time in port, as is against the plan", "الزمن الوسيط في المنفذ: الوضع الحالي مقابل الخطة"),
          sub: T(`As is: ${hrs(ctx.r2030.median)} in 2030 · with the plan: ${hrs(ctx.after.median)} · today: ${hrs(today().median)}`, `الوضع الحالي: ${hrs(ctx.r2030.median)} عام 2030 · مع الخطة: ${hrs(ctx.after.median)} · اليوم: ${hrs(today().median)}`),
          chart: {
            x: YEARS, goal: ctx.goal, goalLabel: T(`Goal ${ctx.goal} h`, `الهدف ${ctx.goal} ساعة`), yFmt: (v) => `${v} ${T("h", "س")}`, axis: T("hours", "ساعات"), min: 0,
            series: [{ v: asIs, color: "#ff8e99", label: T("As is", "الوضع الحالي"), fmt: hrs }, { v: withPlan, color: "#6fe3c8", label: T("With plan", "مع الخطة"), fmt: hrs }],
          },
        };
      },
    },
    {
      L: "", chap: () => "WASL", hold: 12,
      enter() {
        api.view("overview");
        return { big: "WASL · وصل", line: T("We connect you to your vision", "نوصلك إلى رؤيتك"), sub: T("Watch · Anticipate · Simulate · Lead", "راقب · توقّع · حاكِ · قُد"), title: true };
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
  let gridTimers = [];

  /* The search as a grid of dots: each try lights up in turn, green if it reaches the goal,
     then the plans kept get a gold ring. */
  function playGrid(box, g, ms) {
    gridTimers.forEach(clearTimeout);
    gridTimers = [];
    const n = g.trials.length;
    const cols = Math.min(16, Math.ceil(Math.sqrt(n * 2.4)));
    box.style.setProperty("--cols", cols);
    box.innerHTML = `<div class="dg">${g.trials.map(() => "<i></i>").join("")}</div><div class="dg-cap"></div>`;
    const cells = [...box.querySelectorAll(".dg i")];
    const each = (ms * 0.85) / n;
    g.trials.forEach((t, i) => {
      gridTimers.push(setTimeout(() => {
        cells[i].className = "chk";
        gridTimers.push(setTimeout(() => (cells[i].className = t.ok ? "ok" : "no"), 260));
      }, i * each));
    });
    gridTimers.push(setTimeout(() => {
      for (const i of g.picks) if (cells[i]) cells[i].classList.add("pick");
      box.querySelector(".dg-cap").textContent = T("3 plans kept: cheapest, most resilient, best result", "3 خطط محفوظة: الأوفر، الأكثر مرونة، الأفضل نتيجة");
    }, ms));
  }

  function show(c) {
    cancelAnimationFrame(anim);
    const big = q(".dm-big");
    root.classList.toggle("title", !!c.title);
    root.dir = ar() ? "rtl" : "ltr";
    big.className = `dm-big ${c.bad ? "bad" : c.good ? "good" : ""}`;
    const unit = c.unit ? `<small>${c.unit}</small>` : "";
    const ms = c.countMs || COUNT_MS;
    if (c.count) {
      const [a, b, fmt] = c.count;
      const t0 = performance.now();
      const step = (t) => {
        const f = Math.min(1, (t - t0) / ms);
        const e = c.countMs ? f : 1 - (1 - f) ** 3;
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
    const grid = q(".dm-grid");
    gridTimers.forEach(clearTimeout);
    gridTimers = [];
    grid.innerHTML = "";
    if (c.grid) playGrid(grid, c.grid, ms);
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
    q(".dm-chap").textContent = s.chap();
    dots.forEach((d, j) => d.classList.toggle("on", j <= k));
    busy = true;
    if (api.clearPulses) api.clearPulses();
    const c = await s.enter(show);
    if (my !== token) return;
    busy = false;
    show(c);
    /* never shorter than the time to read the caption slowly, after the number has counted up */
    const words = `${c.line || ""} ${c.sub || ""}`.split(/\s+/).filter(Boolean).length;
    left = total = Math.max(c.hold || s.hold, (c.countMs || COUNT_MS) / 1000 + 4 + words / WORDS_PER_SEC);
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
    gridTimers.forEach(clearTimeout);
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
