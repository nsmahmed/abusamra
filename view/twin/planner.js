/* Scenario planner: What-if settings and Goal seeking over the learned port model (portmodel.js).

   What-if: every lever moves the calibrated model; the impact block shows today's port against
   the scenario in medians, stage by stage, with a sentence per lever saying why it moved.
   Goal seek: the model is searched in reverse for the cheapest, a resilient and a best-result set
   of lever settings that reach a target time in port, each costed from config.json unit costs.
   Each section's gear opens its limits; limits are kept in this browser. */

import { CATS } from "./portmodel.js";

const STAGE_LABEL = {
  en: { gate: "Wait at entry (parking full)", decl: "Wait for declaration", xq: "Queue for X-ray", iq: "Queue for inspection", insp: "Inspection", exit: "Release and exit" },
  ar: { gate: "انتظار عند المدخل (المواقف ممتلئة)", decl: "انتظار تقديم البيان", xq: "انتظار الأشعة", iq: "انتظار التفتيش", insp: "التفتيش", exit: "الإفراج والخروج" },
};
const PATTERN_LABEL = {
  night: "Night arrivals (22:00–06:00)", afternoon: "Arrivals 13:00–15:00", chem: "Chemical & others", oga: "OGA (restricted, non-food)", health: "Health & food",
  multi: "More than one declaration", shared: "Declaration shared with other trucks", xray: "Sent to X-ray", SA: "Saudi plates", QA: "Qatari plates",
};
export const PLAN_COLORS = { best: "#3987e5", resilient: "#d95926", cheap: "#199e70" };

const T = {
  en: {
    title: "Scenario planner", whatif: "What-if", goal: "Goal seek", today: "Today", scenario: "Scenario", reset: "Reset", share: "Copy link", copied: "Link copied", tuck: "Hide panel",
    impact: "Impact", median: "Median time in port", p90: "Slowest 10% (P90)", over12: "Over 12 hours", capacity: "Sustainable trucks / day", limited: "limited by",
    why: "Why it moved", bottleneck: "Bottleneck", pattern: "Who is stuck there",
    demand: "Truck arrivals", perDay: "trucks / day", baseNote: "median day, last 90 days of data", surge: "Load increase",
    xray: "X-ray lanes", lanes: "lanes", docks: "Inspection docks", split: "Split by category", inferred: "Today (inferred)", smart: "Smart split", byShed: "By shed",
    parking: "Main parking", bays: "bays", process: "Process levers", prefile: "Declarations filed before arrival", green: "Green channel, non-restricted goods", overlap: "Overlap shift handovers",
    limits: "Limits", min: "Min", max: "Max", save: "Save", cancel: "Cancel",
    target: "Target", hours: "h", metric: "Measure", horizon: "Demand in", run: "Find plans", running: "Searching scenarios…", visualize: "Visualize in the twin",
    cost5: "5-year cost", leadT: "In service in", months: "months", saves: "Each lever's part", none: "No change", noPlan: "No setting within the limits reaches the target; showing the closest plans. Raise a limit (gear) or relax the target.",
    proj: "Median time in port to 2030", doNothing: "No change", costVs: "Cost against hours saved",
  },
  ar: {
    title: "مخطط السيناريوهات", whatif: "ماذا لو", goal: "البحث عن الهدف", today: "الحالي", scenario: "السيناريو", reset: "إعادة", share: "نسخ الرابط", copied: "تم النسخ", tuck: "إخفاء",
    impact: "الأثر", median: "وسيط زمن البقاء", p90: "أبطأ 10%", over12: "أكثر من 12 ساعة", capacity: "الطاقة اليومية المستدامة", limited: "محدودة بـ",
    why: "سبب التغيير", bottleneck: "عنق الزجاجة", pattern: "من يتأخر هناك",
    demand: "الشاحنات القادمة", perDay: "شاحنة / يوم", baseNote: "وسيط آخر 90 يومًا", surge: "زيادة الحمل",
    xray: "مسارات الأشعة", lanes: "مسارات", docks: "أرصفة التفتيش", split: "التوزيع حسب الفئة", inferred: "الحالي (مستنتج)", smart: "توزيع ذكي", byShed: "حسب المبنى",
    parking: "المواقف الرئيسية", bays: "موقف", process: "أدوات الإجراءات", prefile: "بيانات مقدمة قبل الوصول", green: "المسار الأخضر للبضائع غير المقيدة", overlap: "تداخل تسليم المناوبات",
    limits: "الحدود", min: "أدنى", max: "أقصى", save: "حفظ", cancel: "إلغاء",
    target: "المستهدف", hours: "س", metric: "المقياس", horizon: "الطلب في", run: "ابحث عن الخطط", running: "جارٍ البحث…", visualize: "اعرض في التوأم",
    cost5: "تكلفة 5 سنوات", leadT: "التشغيل خلال", months: "أشهر", saves: "أثر كل أداة", none: "بلا تغيير", noPlan: "لا يوجد إعداد يحقق المستهدف ضمن الحدود؛ هذه أقرب الخطط.",
    proj: "وسيط زمن البقاء حتى 2030", doNothing: "بلا تغيير", costVs: "التكلفة مقابل الساعات الموفرة",
  },
};
const LEVER_NAME = { xray: "X-ray lanes", docks: "Inspection docks", prefile: "Pre-arrival filing", green: "Green channel", overlap: "Shift overlap", parking: "Parking" };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtH = (h) => (!Number.isFinite(h) ? "∞" : h >= 48 ? `${Math.round(h / 24)} d` : h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);
const fmtMin = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
export const fmtQAR = (v) => (v >= 1e6 ? `QAR ${(v / 1e6).toFixed(v >= 1e8 ? 0 : 1)} M` : `QAR ${Math.round(v / 1e3)} k`);
const LS = "wasl.limits.v1";

export class Planner {
  constructor(model, { lang, onChange, onVisualize }) {
    this.m = model;
    this.cfg = model.cfg;
    this.lang = lang;
    this.onChange = onChange;
    this.onVisualize = onVisualize || (() => {});
    this.loadLimits();
    this.state = this.initial();
    this.tab = "whatif";
    this.goal = { target: 3.5, metric: "median", year: 2026, result: null, busy: false };
    this.open = false;
  }

  t(k) {
    return T[this.lang()][k] ?? T.en[k] ?? k;
  }

  /* ---------- limits (config defaults, overridable per browser) ---------- */
  loadLimits() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS) || "{}");
    } catch {}
    const c = this.cfg;
    for (const k of ["parking", "xray", "docks", "surge"]) if (saved[k]) Object.assign(c[k], saved[k]);
    this.m.cfg = c;
  }

  saveLimit(key, min, max) {
    const c = this.cfg[key];
    if (Number.isFinite(min) && "min" in c) c.min = Math.min(min, c.default ?? min);
    if (Number.isFinite(max)) c.max = Math.max(max, c.default ?? 0, c.min ?? 0);
    try {
      const saved = JSON.parse(localStorage.getItem(LS) || "{}");
      saved[key] = { ...(saved[key] || {}), max: c.max, ...("min" in c ? { min: c.min } : {}) };
      localStorage.setItem(LS, JSON.stringify(saved));
    } catch {}
  }

  initial() {
    return { ...this.m.today, alloc: { ...this.m.today.alloc } };
  }

  changed() {
    const a = this.state;
    const b = this.m.today;
    return ["surge", "parking", "xray", "docks", "prefile", "green", "overlap"].some((k) => a[k] !== b[k]) || CATS.some((c) => a.alloc[c] !== b.alloc[c]);
  }

  load(s) {
    const st = this.initial();
    const lim = this.m.limits();
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
    for (const k of ["surge", "parking", "xray", "docks"]) if (Number.isFinite(s[k])) st[k] = clamp(s[k], lim[k]);
    if (Number.isFinite(s.overlap)) st.overlap = s.overlap ? 1 : 0;
    if (s.alloc && CATS.every((c) => Number.isFinite(s.alloc[c])) && CATS.reduce((n, c) => n + s.alloc[c], 0) === st.docks) st.alloc = { ...s.alloc };
    else if (st.docks !== this.m.today.docks) st.alloc = this.m.smartAlloc(st.docks, st);
    this.state = st;
    if (this.root) this.build();
  }

  mount(root) {
    this.root = root;
    this.build();
  }

  /* ---------- layout ---------- */
  build() {
    const t = (k) => this.t(k);
    const lim = this.m.limits();
    const s = this.state;
    const L = this.m.L;
    const gear = (key) => `<button type="button" class="pl-gear" data-gear="${key}" title="${t("limits")}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button><div class="pl-limits" data-lim="${key}"></div>`;
    const range = (id, key, step = 1) => `<input type="range" class="pl-range" id="pl-${id}" min="${lim[key][0]}" max="${lim[key][1]}" step="${step}" value="${s[key]}">`;
    const presets = this.m.presets();
    const span = lim.surge[1] || 1;
    this.root.innerHTML = `
      <button type="button" class="tuck-btn" id="pl-tuck" title="${t("tuck")}"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="pl-head">
        <div><span class="pl-kicker">WASL · ${t("title")}</span><div class="seg small pl-tabs"><button type="button" data-tab="whatif">${t("whatif")}</button><button type="button" data-tab="goal">${t("goal")}</button></div></div>
        <div class="pl-acts"><span class="pl-tag" id="pl-tag">${t("scenario")}</span><button type="button" class="pl-reset pl-icon" id="pl-share" title="${t("share")}"><svg viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg></button><button type="button" class="pl-reset" id="pl-reset">${t("reset")}</button></div>
      </div>

      <div class="pl-pane" data-pane="whatif">
        <section class="pl-sec pl-impact">
          <div class="pl-row"><span class="pl-label">${t("impact")}</span><span class="pl-legend"><i class="today"></i>${t("today")} <i class="prop"></i>${t("scenario")}</span></div>
          <div class="pl-hero" id="pl-hero"></div>
          <div class="pl-stages" id="pl-stages"></div>
          <div class="pl-why" id="pl-why"></div>
          <div class="pl-bn" id="pl-bn"></div>
        </section>

        <section class="pl-sec">
          <div class="pl-row"><span class="pl-label">${t("demand")} ${gear("surge")}</span><span class="pl-val"><b id="pl-demand-v"></b> <em>${t("perDay")}</em></span></div>
          <div class="pl-note">${L.demand.currentPerDay} ${t("perDay")} · ${t("baseNote")}</div>
          <div class="pl-row sub"><span class="pl-label">${t("surge")}</span><span class="pl-val"><b id="pl-surge-v"></b></span></div>
          <div class="pl-range-wrap">${range("surge", "surge")}<div class="pl-ticks">${presets.map((p) => `<button type="button" class="pl-tick" style="left:${(p.pct / span) * 100}%" data-pct="${p.pct}" title="${esc(p.label)} · ${esc(p.sub)}">+${p.pct}%</button>`).join("")}</div></div>
          <div class="pl-chips">${presets.map((p) => `<button type="button" class="pl-chip" data-pct="${p.pct}"><b>+${p.pct}%</b> ${esc(p.label)}<em>${esc(p.sub)}</em></button>`).join("")}</div>
        </section>

        <section class="pl-sec">
          <div class="pl-row"><span class="pl-label">${t("xray")} ${gear("xray")}</span><span class="pl-val"><span class="pl-delta" id="pl-xray-d"></span></span></div>
          <div class="seg pl-seg" id="pl-xray">${Array.from({ length: lim.xray[1] - lim.xray[0] + 1 }, (_, i) => {
            const n = lim.xray[0] + i;
            return `<button type="button" data-n="${n}">${n}${n === this.cfg.xray.default ? "<i></i>" : ""}</button>`;
          }).join("")}</div>
        </section>

        <section class="pl-sec">
          <div class="pl-row"><span class="pl-label">${t("docks")} ${gear("docks")}</span><span class="pl-val"><b id="pl-docks-v"></b> <span class="pl-delta" id="pl-docks-d"></span></span></div>
          ${range("docks", "docks", this.cfg.docks.step || 5)}
          <div class="pl-row sub"><span class="pl-label">${t("split")}</span></div>
          <div class="pl-split" id="pl-alloc"></div>
          <div class="pl-btns"><button type="button" id="pl-inferred">${t("inferred")}</button><button type="button" id="pl-smart">${t("smart")}</button><button type="button" id="pl-shed">${t("byShed")}</button></div>
          <div class="pl-cats" id="pl-cats"></div>
        </section>

        <section class="pl-sec">
          <div class="pl-row"><span class="pl-label">${t("parking")} ${gear("parking")}</span><span class="pl-val"><b id="pl-park-v"></b> <em>${t("bays")}</em> <span class="pl-delta" id="pl-park-d"></span></span></div>
          ${range("park", "parking", this.cfg.parking.step)}
          <div class="pl-note" id="pl-park-n"></div>
        </section>

        <section class="pl-sec">
          <label class="sw pl-sw"><input type="checkbox" id="pl-ov"><span>${t("overlap")}</span><i></i></label>
        </section>
      </div>

      <div class="pl-pane" data-pane="goal">
        <section class="pl-sec">
          <p class="pl-note">Goal seeking runs the learned port model in reverse: it tries every combination of the levers within their limits, keeps those that reach the target, and prices each from the unit costs.</p>
          <div class="gs-form">
            <label>${t("target")}<span><input type="number" id="gs-target" min="1" max="24" step="0.5" value="${this.goal.target}"> ${t("hours")}</span></label>
            <label>${t("metric")}<span class="seg small" id="gs-metric"><button type="button" data-v="median">Median</button><button type="button" data-v="p90">P90</button></span></label>
            <label>${t("horizon")}<span class="seg small" id="gs-year"><button type="button" data-v="2026">2026</button><button type="button" data-v="2030">2030</button></span></label>
          </div>
          <div class="gs-now" id="gs-now"></div>
          <button type="button" class="gs-run" id="gs-run">${t("run")}</button>
          <div class="gs-prog" id="gs-prog"><i></i></div>
        </section>
        <div id="gs-out"></div>
      </div>`;
    this.bind();
    this.setTab(this.tab);
    this.update(true);
    this.renderGoal();
  }

  bind() {
    const $ = (id) => this.root.querySelector(`#${id}`);
    const num = (el, key, push = true) =>
      el.addEventListener("input", () => {
        this.state[key] = Number(el.value);
        if (key === "docks") this.state.alloc = this.m.smartAlloc(this.state.docks, this.state);
        this.update(push);
      });
    this.el = { tag: $("pl-tag"), hero: $("pl-hero"), stages: $("pl-stages"), why: $("pl-why"), bn: $("pl-bn"), cats: $("pl-cats") };
    num($("pl-surge"), "surge");
    num($("pl-docks"), "docks");
    num($("pl-park"), "parking");
    $("pl-ov").checked = !!this.state.overlap;
    $("pl-ov").addEventListener("change", (e) => {
      this.state.overlap = e.target.checked ? 1 : 0;
      this.update(true);
    });
    this.root.querySelectorAll("[data-pct]").forEach((b) =>
      b.addEventListener("click", () => {
        this.state.surge = this.state.surge === Number(b.dataset.pct) ? 0 : Number(b.dataset.pct);
        $("pl-surge").value = this.state.surge;
        this.update(true);
      })
    );
    this.root.querySelectorAll("#pl-xray button").forEach((b) =>
      b.addEventListener("click", () => {
        this.state.xray = Number(b.dataset.n);
        this.update(true);
      })
    );
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => this.setTab(b.dataset.tab)));
    $("pl-tuck").addEventListener("click", () => this.root.classList.toggle("tucked"));
    $("pl-share").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(location.href);
        btn.classList.add("ok");
      } catch {}
      setTimeout(() => btn.classList.remove("ok"), 1600);
    });
    $("pl-reset").addEventListener("click", () => {
      this.state = this.initial();
      this.build();
      this.onChange(this.state);
    });
    $("pl-inferred").addEventListener("click", () => this.setAlloc(this.state.docks === this.m.today.docks ? { ...this.m.today.alloc } : this.m.smartAlloc(this.state.docks, this.state)));
    $("pl-smart").addEventListener("click", () => this.setAlloc(this.m.smartAlloc(this.state.docks, this.state)));
    $("pl-shed").addEventListener("click", () => {
      const shed = Object.fromEntries((this.m.shed || []).map((c) => [c.id, c.bays]));
      const tot = CATS.reduce((n, c) => n + (shed[c] || 0), 0) || 1;
      const out = Object.fromEntries(CATS.map((c) => [c, Math.max(2, Math.round(((shed[c] || 0) / tot) * this.state.docks))]));
      out.oga += this.state.docks - CATS.reduce((n, c) => n + out[c], 0);
      this.setAlloc(out);
    });
    this.allocBar = splitBar($("pl-alloc"), {
      total: () => this.state.docks,
      min: 2,
      values: { ...this.state.alloc },
      color: (c) => this.cat(c).color,
      label: (c, v) => `${this.catTag(c)} ${v} · ${Math.round((v / this.state.docks) * 100)}%`,
      onInput: (v) => {
        this.state.alloc = { ...v };
        this.update(true);
      },
    });
    this.root.querySelectorAll("[data-gear]").forEach((b) => b.addEventListener("click", () => this.openLimits(b.dataset.gear)));
    /* goal seek */
    $("gs-target").addEventListener("input", (e) => {
      this.goal.target = Number(e.target.value) || this.goal.target;
      this.renderGoalNow();
    });
    const segPick = (id, key, cast) =>
      this.root.querySelectorAll(`#${id} button`).forEach((b) => {
        b.classList.toggle("on", String(this.goal[key]) === b.dataset.v);
        b.addEventListener("click", () => {
          this.goal[key] = cast(b.dataset.v);
          this.root.querySelectorAll(`#${id} button`).forEach((o) => o.classList.toggle("on", o === b));
          this.renderGoalNow();
        });
      });
    segPick("gs-metric", "metric", String);
    segPick("gs-year", "year", Number);
    $("gs-run").addEventListener("click", () => this.runGoal());
  }

  setTab(tab) {
    this.tab = tab;
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    this.root.querySelectorAll("[data-pane]").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
    this.root.classList.toggle("wide", tab === "goal");
    if (tab === "goal") this.renderGoalNow();
  }

  setAlloc(a) {
    this.state.alloc = a;
    this.allocBar.set(a);
    this.update(true);
  }

  openLimits(key) {
    const t = (k) => this.t(k);
    const box = this.root.querySelector(`[data-lim="${key}"]`);
    if (box.classList.contains("open")) return box.classList.remove("open");
    this.root.querySelectorAll(".pl-limits.open").forEach((b) => b.classList.remove("open"));
    const c = this.cfg[key];
    box.innerHTML = `<div class="pl-lim-h">${t("limits")} <em>default ${c.default ?? 0}</em></div>
      ${"min" in c ? `<label>${t("min")}<input type="number" data-k="min" value="${c.min}"></label>` : ""}
      <label>${t("max")}<input type="number" data-k="max" value="${c.max}"></label>
      <div class="pl-lim-b"><button type="button" data-a="cancel">${t("cancel")}</button><button type="button" data-a="save" class="on">${t("save")}</button></div>`;
    box.classList.add("open");
    box.querySelector('[data-a="cancel"]').onclick = () => box.classList.remove("open");
    box.querySelector('[data-a="save"]').onclick = () => {
      const v = (k) => {
        const el = box.querySelector(`[data-k="${k}"]`);
        return el ? Number(el.value) : NaN;
      };
      this.saveLimit(key, v("min"), v("max"));
      this.load(this.state);
      this.onChange(this.state);
    };
  }

  cat(id) {
    return this.cfg.ramps.categories.find((c) => c.id === id);
  }

  catTag(id) {
    const c = this.cat(id);
    return this.lang() === "ar" ? c.ar : c.tag || c.short || c.en;
  }

  /* ---------- what-if ---------- */
  update(push = false) {
    const s = this.state;
    const t = (k) => this.t(k);
    const $ = (id) => this.root.querySelector(`#${id}`);
    const today = this.m.today;
    const r = this.m.evaluate(s);
    const b = this.m.baseRun;
    this.result = r;
    this.el.tag.classList.toggle("on", this.changed());
    $("pl-demand-v").textContent = Math.round(r.lamDay).toLocaleString();
    $("pl-surge-v").textContent = s.surge ? `+${s.surge}%` : "—";
    this.root.querySelectorAll("[data-pct]").forEach((el) => el.classList.toggle("on", Number(el.dataset.pct) === s.surge));
    $("pl-docks-v").textContent = s.docks;
    const delta = (el, d, up, down) => {
      el.textContent = d > 0 ? `+${d} ${up}` : d < 0 ? `${d} ${down}` : "";
      el.className = `pl-delta ${d > 0 ? "up" : d < 0 ? "down" : ""}`;
    };
    delta($("pl-docks-d"), s.docks - today.docks, "proposed", "closed");
    $("pl-park-v").textContent = s.parking.toLocaleString();
    delta($("pl-park-d"), s.parking - today.parking, "proposed", "closed");
    delta($("pl-xray-d"), s.xray - today.xray, "proposed", "out of service");
    this.root.querySelectorAll("#pl-xray button").forEach((el) => el.classList.toggle("on", Number(el.dataset.n) === s.xray));
    $("pl-park-n").innerHTML = r.overflow > 0 ? `<span class="warn">Full at peak: ${Math.round(r.peakYard)} trucks for ${s.parking} bays</span>` : `Peak use ${Math.round(r.peakYard)} of ${s.parking} bays (${Math.round(r.occupancy * 100)}%)`;
    this.allocBar.set(s.alloc);

    /* hero: today against the scenario */
    const cmp = (label, a, v, fmt, lowerIsBetter = true) => {
      const fa = fmt(a);
      const fv = fmt(v);
      const diff = fa !== fv;
      const good = diff && (lowerIsBetter ? v < a : v > a);
      return `<div class="pl-tile"><span class="lb">${label}</span><div class="vv">${diff ? `<span class="was">${fa}</span><em>→</em>` : ""}<b class="${diff ? (good ? "good" : "bad") : ""}">${fv}</b></div></div>`;
    };
    this.el.hero.innerHTML = [
      cmp(t("median"), b.median, r.median, fmtH),
      cmp(t("p90"), b.p90, r.p90, fmtH),
      cmp(t("over12"), b.over12, r.over12, (v) => `${Math.round(v)}%`),
      cmp(t("capacity"), b.capacity, r.capacity, (v) => Math.round(v).toLocaleString(), false),
    ].join("");

    /* stage bars, today and scenario on one scale */
    const keys = ["gate", "decl", "xq", "iq", "insp", "exit"].filter((k) => k !== "gate" || r.stages.gate.median > 0);
    const top = Math.max(...keys.map((k) => Math.max(b.stages[k].median, r.stages[k].median)), 1);
    const SL = STAGE_LABEL[this.lang()] || STAGE_LABEL.en;
    const bn = r.bottleneck.stage;
    this.el.stages.innerHTML = keys
      .map((k) => {
        const a = b.stages[k].median;
        const v = r.stages[k].median;
        return `<div class="pl-stage${k === bn ? " bn" : ""}" title="${esc(SL[k])}: ${Math.round(r.stages[k].share)}% of truck-hours">
          <span class="nm">${esc(SL[k])}</span>
          <span class="bars"><i class="a" style="width:${(a / top) * 100}%"></i><i class="b ${v < a - 0.5 ? "good" : v > a + 0.5 ? "bad" : ""}" style="width:${(v / top) * 100}%"></i></span>
          <span class="num">${fmtMin(v)}</span></div>`;
      })
      .join("");
    const why = this.m.explain(r);
    this.el.why.innerHTML = why.length ? `<div class="pl-label">${t("why")}</div><ul>${why.map((w) => `<li class="${w.warn ? "warn" : ""}">${esc(w.text)}</li>`).join("")}</ul>` : "";
    this.el.bn.innerHTML = bottleneckHTML(r, this.lang());

    /* per-category rows */
    this.el.cats.innerHTML = CATS.map((c) => {
      const q = r.cats[c];
      const w = Math.min(100, q.rho * 100);
      const lv = q.rho >= 0.9 ? "l2" : q.rho >= 0.78 ? "l1" : "l0";
      return `<div class="pl-cat"><i style="background:${this.cat(c).color}"></i><span class="nm">${this.catTag(c)}</span>
        <span class="num">${q.docks} · ${Math.round(q.share * 100)}% of trucks</span>
        <span class="bar"><u class="${lv}" style="width:${w}%"></u></span><span class="num r">${Math.round(q.rho * 100)}% busy</span></div>`;
    }).join("");
    if (push) this.onChange(this.state);
  }

  live() {}

  /* ---------- goal seek ---------- */
  renderGoalNow() {
    const el = this.root.querySelector("#gs-now");
    if (!el) return;
    const g = this.goal;
    const now = this.m.evaluate({ ...this.m.today, year: g.year, surge: this.state.surge });
    const v = g.metric === "p90" ? now.p90 : now.median;
    el.innerHTML = `${g.year === 2030 ? "2030, no change" : "Today"}: <b>${fmtH(v)}</b> ${g.metric === "p90" ? "P90" : "median"} at ${Math.round(now.lamDay)} trucks/day → target <b>${fmtH(g.target)}</b>`;
  }

  async runGoal() {
    if (this.goal.busy) return;
    const g = this.goal;
    const btn = this.root.querySelector("#gs-run");
    const prog = this.root.querySelector("#gs-prog");
    g.busy = true;
    btn.textContent = this.t("running");
    btn.disabled = true;
    prog.classList.add("on");
    g.result = await this.m.goalSeek({ target: g.target, metric: g.metric, year: g.year, surge: this.state.surge, physical: !!g.physical, onProgress: (f) => (prog.firstElementChild.style.width = `${Math.round(f * 100)}%`) });
    g.busy = false;
    btn.textContent = this.t("run");
    btn.disabled = false;
    prog.classList.remove("on");
    this.renderGoal();
  }

  renderGoal() {
    const out = this.root.querySelector("#gs-out");
    if (!out) return;
    const g = this.goal.result;
    if (!g) {
      out.innerHTML = "";
      return;
    }
    const t = (k) => this.t(k);
    const base = this.m.evaluate({ ...this.m.today, year: g.year, surge: this.state.surge });
    const bv = g.metric === "p90" ? base.p90 : base.median;
    const card = (p) => {
      const lever = p.contrib.filter((c) => c.hours > 0.02);
      const maxC = Math.max(0.1, ...lever.map((c) => c.hours));
      return `<article class="gs-card" style="--pc:${PLAN_COLORS[p.id]}">
        <header><b>${p.name}</b><span class="gs-res">${fmtH(p.value)}</span></header>
        <div class="gs-meta"><span><em>${t("cost5")}</em>${fmtQAR(p.cost)}</span><span><em>${t("leadT")}</em>${p.lead} ${t("months")}</span><span><em>saves</em>${fmtH(bv - p.value)}</span><span title="Same plan in a week like the busiest of 2026 (+${Math.round(this.m.L.demand.busiestWeek.vsCurrent)}% trucks)"><em>busy week</em><b class="${p.stress <= g.target ? "good" : "bad"}">${fmtH(p.stress)}</b></span></div>
        <ul class="gs-items">${p.items.map((i) => `<li><span>${esc(i.label)}</span><em>${fmtQAR(i.capex + i.opex * this.m.cost(p.s).years)}</em></li>`).join("") || `<li>${t("none")}</li>`}</ul>
        ${lever.length ? `<div class="gs-contrib"><div class="pl-label">${t("saves")}</div>${lever.map((c) => `<div class="gs-c"><span>${LEVER_NAME[c.lever] || c.lever}</span><i style="width:${(c.hours / maxC) * 100}%"></i><b>−${fmtH(c.hours)}</b></div>`).join("")}</div>` : ""}
        <button type="button" class="gs-vis" data-plan="${p.id}">${t("visualize")}</button>
      </article>`;
    };
    out.innerHTML = `${g.reached ? "" : `<p class="pl-note warn">${t("noPlan")}</p>`}
      <p class="pl-note">${g.searched.toLocaleString()} scenarios evaluated · ${g.feasible.toLocaleString()} reach ${fmtH(g.target)}.</p>
      ${g.plans.map(card).join("")}
      <section class="pl-sec"><div class="pl-label">${t("proj")}</div><div class="gs-chart" id="gs-proj"></div></section>
      <section class="pl-sec"><div class="pl-label">${t("costVs")}</div><div class="gs-chart" id="gs-cost"></div></section>`;
    out.querySelectorAll("[data-plan]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = g.plans.find((x) => x.id === b.dataset.plan);
        this.load({ ...p.s, surge: this.state.surge });
        this.setTab("whatif");
        this.onChange(this.state);
        this.onVisualize(p);
      })
    );
    drawProjection(out.querySelector("#gs-proj"), this.m, g, this.state.surge, t("doNothing"));
    drawCost(out.querySelector("#gs-cost"), g, bv);
  }
}

/* The bottleneck stage, the hottest resource and the attributes over-represented there. */
export function bottleneckHTML(r, lang = "en") {
  const SL = STAGE_LABEL[lang] || STAGE_LABEL.en;
  const b = r.bottleneck;
  const res = { xray: "X-ray lanes", chem: "Chemical & others docks", oga: "OGA docks", health: "Health & food docks", parking: "Main parking" }[b.resource];
  const pat = b.pattern.length
    ? `<ul class="bn-pat">${b.pattern.map((p) => `<li><span>${esc(PATTERN_LABEL[p.key] || p.key)}</span><b>${p.lift.toFixed(1)}×</b><em>${Math.round(p.inSlow)}% of the slowest quarter vs ${Math.round(p.overall)}% of all trucks</em></li>`).join("")}</ul>`
    : "";
  return `<div class="bn-box"><div class="bn-h"><i></i>Bottleneck · <b>${esc(SL[b.stage])}</b></div>
    <div class="bn-s">${Math.round(b.share)}% of all truck-hours · median ${fmtMin(b.median)} · busiest resource: ${res} at ${Math.round(b.util * 100)}%</div>${pat}</div>`;
}

/* Median time in port each year to 2030: no change against each plan, same demand path. */
export function drawProjection(el, m, g, surge = 0, dn = "No change") {
  if (!el) return;
  const W = el.clientWidth || 340;
  const Hh = 170;
  const years = [2026, 2027, 2028, 2029, 2030];
  const key = g.metric === "p90" ? "p90" : "median";
  const series = [{ id: "none", name: dn, color: "var(--muted)", pts: m.projection({ ...m.today, surge }, years) }, ...g.plans.map((p) => ({ id: p.id, name: p.name, color: PLAN_COLORS[p.id], pts: m.projection({ ...p.s, surge }, years) }))];
  const top = Math.min(48, Math.max(g.target * 1.6, ...series.flatMap((s) => s.pts.map((p) => p[key]))));
  const step = top > 24 ? 12 : top > 12 ? 4 : top > 6 ? 2 : 1;
  const yMax = Math.ceil(top / step) * step;
  const L = 30, R = 72, T = 10, B = 20;
  const X = (i) => L + (i / (years.length - 1)) * (W - L - R);
  const Y = (v) => T + (1 - Math.min(v, yMax) / yMax) * (Hh - T - B);
  let svg = `<svg width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}">`;
  for (let v = 0; v <= yMax; v += step) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v}h</text>`;
  years.forEach((y, i) => (svg += `<text class="ax" x="${X(i)}" y="${Hh - 5}" text-anchor="middle">${y}</text>`));
  svg += `<line class="goal" x1="${L}" x2="${W - R}" y1="${Y(g.target)}" y2="${Y(g.target)}"/><text class="ax goal-t" x="${L + 4}" y="${Y(g.target) - 4}">goal ${g.target} h</text>`;
  const ends = [];
  for (const s of series) {
    const d = s.pts.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(p[key]).toFixed(1)}`).join("");
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.id === "none" ? 2 : 2.2}" ${s.id === "none" ? 'stroke-dasharray="4 4"' : ""}/>`;
    s.pts.forEach((p, i) => (svg += `<circle cx="${X(i)}" cy="${Y(p[key])}" r="2.6" fill="${s.color}"><title>${s.name} ${p.year}: ${fmtH(p[key])} · ${Math.round(p.perDay)} trucks/day</title></circle>`));
    ends.push({ y: Y(s.pts[s.pts.length - 1][key]), s, v: s.pts[s.pts.length - 1][key] });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i += 1) if (ends[i].y - ends[i - 1].y < 11) ends[i].y = ends[i - 1].y + 11;
  for (const e of ends) svg += `<text class="ax lbl" x="${W - R + 4}" y="${e.y + 3.5}" fill="${e.s.color}">${e.s.name.split(" ")[0]} ${fmtH(e.v)}</text>`;
  el.innerHTML = `${svg}</svg>`;
}

/* Each plan as a point: 5-year cost against hours saved. */
export function drawCost(el, g, base) {
  if (!el) return;
  const W = el.clientWidth || 340;
  const Hh = 150;
  const L = 44, R = 14, T = 12, B = 24;
  const pts = g.plans.map((p) => ({ p, x: Math.max(0, base - p.value), y: p.cost }));
  const xMax = Math.max(0.5, ...pts.map((q) => q.x)) * 1.2;
  const yMax = Math.max(1e6, ...pts.map((q) => q.y)) * 1.2;
  const X = (v) => L + (v / xMax) * (W - L - R);
  const Y = (v) => T + (1 - v / yMax) * (Hh - T - B);
  let svg = `<svg width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}">`;
  for (let k = 0; k <= 3; k += 1) {
    const v = (yMax / 3) * k;
    svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${L - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v >= 1e6 ? Math.round(v / 1e6) + "M" : Math.round(v / 1e3) + "k"}</text>`;
  }
  svg += `<text class="ax" x="${(L + W - R) / 2}" y="${Hh - 4}" text-anchor="middle">hours saved per truck (median) →</text>`;
  const placed = [];
  for (const q of pts) {
    const cx = X(q.x);
    const cy = Y(q.y);
    let ly = cy - 9;
    while (placed.some((p) => Math.abs(p - ly) < 12)) ly -= 12;
    placed.push(ly);
    svg += `<circle cx="${cx}" cy="${cy}" r="6" fill="${PLAN_COLORS[q.p.id]}"><title>${q.p.name}: ${fmtQAR(q.y)}, saves ${fmtH(q.x)}</title></circle><text class="ax lbl" x="${Math.min(cx, W - 80)}" y="${ly}" fill="${PLAN_COLORS[q.p.id]}">${q.p.name}</text>`;
  }
  el.innerHTML = `${svg}</svg>`;
}

/* A bar split into three coloured parts with two draggable dividers. */
function splitBar(host, { total, min, values, color, label, onInput }) {
  host.innerHTML = `<div class="sb-track">${CATS.map((c) => `<div class="sb-seg" data-c="${c}" style="background:${color(c)}"><span></span></div>`).join("")}<b class="sb-h" data-i="0"></b><b class="sb-h" data-i="1"></b></div>`;
  const track = host.querySelector(".sb-track");
  const segs = CATS.map((c) => host.querySelector(`[data-c="${c}"]`));
  const handles = [...host.querySelectorAll(".sb-h")];
  let v = { ...values };
  const paint = () => {
    let acc = 0;
    const tot = total();
    CATS.forEach((c, i) => {
      segs[i].style.flex = `${v[c]} 0 0`;
      segs[i].querySelector("span").textContent = label(c, v[c]);
      segs[i].title = label(c, v[c]);
      acc += v[c];
      if (i < 2) handles[i].style.left = `${(acc / tot) * 100}%`;
    });
  };
  handles.forEach((h, i) => {
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = track.getBoundingClientRect();
        const tot = total();
        let at = Math.round(((ev.clientX - r.left) / r.width) * tot);
        if (getComputedStyle(track).direction === "rtl") at = tot - at;
        const a = CATS[i];
        const b = CATS[i + 1];
        const before = i === 0 ? 0 : v[CATS[0]];
        const pair = v[a] + v[b];
        const na = Math.max(min, Math.min(pair - min, at - before));
        if (na === v[a]) return;
        v[a] = na;
        v[b] = pair - na;
        paint();
        onInput({ ...v });
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    });
  });
  paint();
  return {
    set(nv) {
      v = { ...nv };
      paint();
    },
  };
}
