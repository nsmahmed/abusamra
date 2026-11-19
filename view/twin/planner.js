/* Capacity planner: what-if settings for the main parking, the x-ray scanners and the import
   inspection ramps, and a small queueing model of the port that shows what each change does.

   The model is deliberately simple and open: trucks arrive at a steady rate; time in the main
   parking is the document wait plus any queue for x-ray or a ramp (Little's law gives the
   occupancy); x-ray and each inspection category are multi-server queues (Erlang C). Every
   figure it uses lives in config.json. "Today" is the same demand on today's layout. */

const CATS = ["chem", "oga", "health"];

/* Probability an arrival has to wait, for c servers carrying a erlangs (Erlang C). */
function erlangC(c, a) {
  if (c <= 0) return 1;
  if (a >= c) return 1;
  let b = 1;
  for (let k = 1; k <= c; k += 1) b = (a * b) / (k + a * b);
  const rho = a / c;
  return b / (1 - rho + rho * b);
}

/* Mean wait in queue (hours) and utilisation for c servers, arrival rate lam, service rate mu. */
function queue(c, lam, mu) {
  if (lam <= 0) return { rho: 0, wait: 0, stable: true };
  if (c <= 0) return { rho: Infinity, wait: Infinity, stable: false };
  const a = lam / mu;
  const rho = a / c;
  if (rho >= 1) return { rho, wait: Infinity, stable: false };
  return { rho, wait: erlangC(c, a) / (c * mu - lam), stable: true };
}

export function model(cfg, s) {
  const m = cfg.model;
  const lam = s.demand / 24;
  const xray = queue(s.xray, lam, m.scansPerHourPerScanner);
  const inspect = lam * m.inspectRate;
  const cats = {};
  let rampWait = 0;
  let rampCap = Infinity;
  let worst = null;
  for (const c of CATS) {
    const share = s.mix[c];
    const q = queue(s.alloc[c], inspect * share, 1 / m.inspectionHours);
    cats[c] = { ...q, docks: s.alloc[c], share };
    rampWait += share * q.wait;
    if (share > 0) {
      const cap = (s.alloc[c] / m.inspectionHours / (m.inspectRate * share)) * 24;
      if (cap < rampCap) {
        rampCap = cap;
        worst = c;
      }
    }
    if (!Number.isFinite(q.wait)) rampWait = Infinity;
  }
  const yardTime = m.yardHours + xray.wait + m.inspectRate * rampWait;
  const inYard = lam * yardTime;
  const clearance = m.gateHours + yardTime + 1 / m.scansPerHourPerScanner + m.inspectRate * m.inspectionHours;
  const xrayCap = s.xray * m.scansPerHourPerScanner * 24;
  const parkCap = (s.parking / m.yardHours) * 24;
  const caps = [
    ["xray", xrayCap],
    ["ramps", rampCap],
    ["parking", parkCap],
  ].sort((a, b) => a[1] - b[1]);
  const rampDelay = m.inspectRate * rampWait;
  return {
    lam,
    rampDelay,
    delay: xray.wait + rampDelay,
    xray,
    cats,
    worstCat: worst,
    inYard,
    occupancy: inYard / s.parking,
    overflow: Math.max(0, inYard - s.parking),
    clearance,
    capacity: caps[0][1],
    bottleneck: caps[0][0],
  };
}

const T = {
  en: {
    title: "Capacity planner", proposal: "Proposal", today: "Today", reset: "Reset", share: "Copy link", copied: "Link copied", copyFail: "Copy the address bar",
    note: "What-if settings. The scene follows the scenario: arrivals, scanners and dock allocation run in the simulation, and how full each area looks comes from the planning model behind these figures (assumptions in config.json).",
    demand: "Truck arrivals", perDay: "/ day", mix: "Inspection volume mix",
    parking: "Main parking", bays: "bays", proposed: "proposed", closed: "closed",
    xray: "X-ray scanners", scanners: "scanners", outOfService: "out of service",
    ramps: "Import inspection ramps", rampsShort: "ramps", docks: "docks", match: "Match docks to volume", byShed: "By shed",
    impact: "Impact", delay: "Queue delay per truck", peak: "Parking occupancy", xrayLoad: "X-ray load", capacity: "Daily capacity",
    wait: "wait", util: "load", overflow: "overflow", trucks: "trucks", unbounded: "grows without limit", bottleneck: "limited by",
    bn: { xray: "x-ray", ramps: "inspection ramps", parking: "parking" }, live: "Live", inspected: "inspected", waved: "waved through",
  },
  ar: {
    title: "مخطط الطاقة الاستيعابية", proposal: "مقترح", today: "الحالي", reset: "إعادة", share: "نسخ الرابط", copied: "تم النسخ", copyFail: "انسخ شريط العنوان",
    note: "إعدادات افتراضية. يتبع المشهد السيناريو: الشاحنات القادمة وأجهزة الأشعة وتوزيع الأرصفة تعمل في المحاكاة، ومستوى الإشغال من نموذج التخطيط وفق افتراضات config.json.",
    demand: "الشاحنات القادمة", perDay: "/ يوم", mix: "توزيع حجم التفتيش",
    parking: "المواقف الرئيسية", bays: "موقف", proposed: "مقترح", closed: "مغلق",
    xray: "أجهزة الأشعة", scanners: "أجهزة", outOfService: "خارج الخدمة",
    ramps: "رمبات تفتيش الوارد", rampsShort: "الرمبات", docks: "رصيف", match: "مطابقة الأرصفة للحجم", byShed: "حسب المبنى",
    impact: "الأثر", delay: "تأخير الانتظار لكل شاحنة", peak: "إشغال المواقف", xrayLoad: "حمل الأشعة", capacity: "الطاقة اليومية",
    wait: "انتظار", util: "حمل", overflow: "فائض", trucks: "شاحنة", unbounded: "يتزايد بلا حد", bottleneck: "محدودة بـ",
    bn: { xray: "الأشعة", ramps: "رمبات التفتيش", parking: "المواقف" }, live: "مباشر", inspected: "تم تفتيشها", waved: "عبرت دون تفتيش",
  },
};

const fmtHours = (h, t) => {
  if (!Number.isFinite(h)) return "∞";
  if (h < 1 / 60) return "< 1 min";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${h.toFixed(h < 10 ? 1 : 0)} h`;
};
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "∞");
const level = (rho) => (!Number.isFinite(rho) || rho >= 0.9 ? "l2" : rho >= 0.75 ? "l1" : "l0");

export class Planner {
  /* base: { shedDocks: {chem,oga,health}, proposedMax } */
  constructor(cfg, base, { lang, onChange }) {
    this.cfg = cfg;
    this.base = base;
    this.lang = lang;
    this.onChange = onChange;
    const totalDocks = CATS.reduce((n, c) => n + base.shedDocks[c], 0);
    this.totalDocks = totalDocks;
    this.limits = {
      parking: [cfg.parking.min, Math.min(cfg.parking.max, cfg.parking.default + base.proposedMax)],
      xray: [cfg.xray.min, cfg.xray.max],
      demand: [cfg.model.demandMin, cfg.model.demandMax],
    };
    this.today = this.initial();
    this.state = this.initial();
    this.open = false;
  }

  initial() {
    return {
      demand: this.cfg.model.demandPerDay,
      parking: this.cfg.parking.default,
      xray: this.cfg.xray.default,
      mix: { ...this.cfg.ramps.volumeMix },
      alloc: { ...this.base.shedDocks },
    };
  }

  /* Today's layout under the scenario's demand. */
  baseline() {
    return { ...this.today, demand: this.state.demand, mix: this.state.mix };
  }

  changed() {
    const a = this.state;
    const b = this.today;
    return a.parking !== b.parking || a.xray !== b.xray || CATS.some((c) => a.alloc[c] !== b.alloc[c]);
  }

  t(key) {
    return T[this.lang()][key] ?? T.en[key] ?? key;
  }

  cat(id) {
    return this.cfg.ramps.categories.find((c) => c.id === id);
  }

  catName(id) {
    const c = this.cat(id);
    return this.lang() === "ar" ? c.ar : c.short || c.en;
  }

  catTag(id) {
    const c = this.cat(id);
    return this.lang() === "ar" ? c.ar : c.tag || c.short || c.en;
  }

  /* Apply a saved or shared scenario, within the configured limits. */
  load(s) {
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
    const st = this.initial();
    if (Number.isFinite(s.demand)) st.demand = clamp(s.demand, this.limits.demand);
    if (Number.isFinite(s.parking)) st.parking = clamp(s.parking, this.limits.parking);
    if (Number.isFinite(s.xray)) st.xray = clamp(s.xray, this.limits.xray);
    if (s.mix && CATS.every((c) => Number.isFinite(s.mix[c]))) {
      const sum = CATS.reduce((n, c) => n + s.mix[c], 0) || 1;
      st.mix = Object.fromEntries(CATS.map((c) => [c, s.mix[c] / sum]));
    }
    if (s.alloc && CATS.every((c) => Number.isFinite(s.alloc[c])) && CATS.reduce((n, c) => n + s.alloc[c], 0) === this.totalDocks) st.alloc = { ...s.alloc };
    this.state = st;
    if (this.root) this.build();
  }

  mount(root) {
    this.root = root;
    this.build();
  }

  build() {
    const t = (k) => this.t(k);
    const [p0, p1] = this.limits.parking;
    const [d0, d1] = this.limits.demand;
    const todayAt = ((this.cfg.parking.default - p0) / (p1 - p0)) * 100;
    this.root.innerHTML = `
      <div class="pl-head">
        <div><h2>${t("title")}</h2><span class="pl-tag" id="pl-tag">${t("proposal")}</span></div>
        <div class="pl-acts"><button type="button" class="pl-reset pl-icon" id="pl-share" title="${t("share")}"><svg viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg></button><button type="button" class="pl-reset" id="pl-reset">${t("reset")}</button></div>
      </div>
      <p class="pl-note">${t("note")}</p>
      <section class="pl-sec pl-impact">
        <div class="pl-row"><span class="pl-label">${t("impact")}</span><span class="pl-legend"><i class="today"></i>${t("today")} <i class="prop"></i>${t("proposal")}</span></div>
        <div class="pl-tiles" id="pl-tiles"></div>
      </section>

      <section class="pl-sec">
        <div class="pl-row"><span class="pl-label">${t("demand")}</span><span class="pl-val"><b id="pl-demand-v"></b> <em>${t("perDay")}</em></span></div>
        <input type="range" class="pl-range" id="pl-demand" min="${d0}" max="${d1}" step="10">
        <div class="pl-row sub"><span class="pl-label">${t("mix")}</span></div>
        <div class="pl-split" id="pl-mix"></div>
      </section>

      <section class="pl-sec">
        <div class="pl-row"><span class="pl-label">${t("parking")}</span><span class="pl-val"><b id="pl-park-v"></b> <em>${t("bays")}</em> <span class="pl-delta" id="pl-park-d"></span></span></div>
        <div class="pl-range-wrap"><input type="range" class="pl-range" id="pl-park" min="${p0}" max="${p1}" step="${this.cfg.parking.step}"><i class="pl-today" style="left:${todayAt}%" title="${t("today")}"></i></div>
        <div class="pl-ends"><span>${p0}</span><span>${t("today")} ${this.cfg.parking.default}</span><span>${p1}</span></div>
      </section>

      <section class="pl-sec">
        <div class="pl-row"><span class="pl-label">${t("xray")}</span><span class="pl-val"><span class="pl-delta" id="pl-xray-d"></span></span></div>
        <div class="seg pl-seg" id="pl-xray">${Array.from({ length: this.limits.xray[1] - this.limits.xray[0] + 1 }, (_, i) => {
          const n = this.limits.xray[0] + i;
          return `<button type="button" data-n="${n}">${n}${n === this.cfg.xray.default ? "<i></i>" : ""}</button>`;
        }).join("")}</div>
      </section>

      <section class="pl-sec">
        <div class="pl-row"><span class="pl-label">${t("ramps")}</span><span class="pl-val"><b>${this.totalDocks}</b> <em>${t("docks")}</em></span></div>
        <div class="pl-split" id="pl-alloc"></div>
        <div class="pl-btns"><button type="button" id="pl-match">${t("match")}</button><button type="button" id="pl-shed">${t("byShed")}</button></div>
        <div class="pl-cats" id="pl-cats"></div>
      </section>
`;
    const $ = (id) => this.root.querySelector(`#${id}`);
    this.el = { tag: $("pl-tag"), demandV: $("pl-demand-v"), parkV: $("pl-park-v"), parkD: $("pl-park-d"), xrayD: $("pl-xray-d"), cats: $("pl-cats"), tiles: $("pl-tiles") };
    const demand = $("pl-demand");
    demand.value = this.state.demand;
    demand.addEventListener("input", () => {
      this.state.demand = Number(demand.value);
      this.update();
    });
    const park = $("pl-park");
    park.value = this.state.parking;
    park.addEventListener("input", () => {
      this.state.parking = Number(park.value);
      this.update(true);
    });
    this.root.querySelectorAll("#pl-xray button").forEach((b) =>
      b.addEventListener("click", () => {
        this.state.xray = Number(b.dataset.n);
        this.update(true);
      })
    );
    $("pl-share").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(location.href);
        btn.title = t("copied");
        btn.classList.add("ok");
      } catch {
        btn.title = t("copyFail");
      }
      setTimeout(() => {
        btn.title = t("share");
        btn.classList.remove("ok");
      }, 1600);
    });
    $("pl-reset").addEventListener("click", () => {
      this.state = this.initial();
      demand.value = this.state.demand;
      park.value = this.state.parking;
      this.mixBar.set(this.state.mix);
      this.allocBar.set(this.state.alloc);
      this.update(true);
    });
    $("pl-match").addEventListener("click", () => {
      this.state.alloc = this.matched();
      this.allocBar.set(this.state.alloc);
      this.update(true);
    });
    $("pl-shed").addEventListener("click", () => {
      this.state.alloc = { ...this.base.shedDocks };
      this.allocBar.set(this.state.alloc);
      this.update(true);
    });
    this.mixBar = splitBar($("pl-mix"), {
      total: 100,
      min: 2,
      values: Object.fromEntries(CATS.map((c) => [c, Math.round(this.state.mix[c] * 100)])),
      color: (c) => this.cat(c).color,
      label: (c, v) => `${this.catTag(c)} ${v}%`,
      onInput: (v) => {
        for (const c of CATS) this.state.mix[c] = v[c] / 100;
        this.update(true);
      },
    });
    this.mixBar.set = ((set) => (mix) => set(Object.fromEntries(CATS.map((c) => [c, Math.round(mix[c] * 100)]))))(this.mixBar.set);
    this.allocBar = splitBar($("pl-alloc"), {
      total: this.totalDocks,
      min: 2,
      values: { ...this.state.alloc },
      color: (c) => this.cat(c).color,
      label: (c, v) => `${this.catTag(c)} ${v}`,
      onInput: (v) => {
        this.state.alloc = { ...v };
        this.update(true);
      },
    });
    this.update(true);
  }

  /* Docks shared out in proportion to inspection volume, rounded to whole docks. */
  matched() {
    const n = this.totalDocks;
    const raw = CATS.map((c) => [c, this.state.mix[c] * n]);
    const out = Object.fromEntries(raw.map(([c, v]) => [c, Math.max(2, Math.floor(v))]));
    let left = n - CATS.reduce((s, c) => s + out[c], 0);
    raw.sort((a, b) => (b[1] % 1) - (a[1] % 1));
    for (let i = 0; left > 0; i = (i + 1) % 3, left -= 1) out[raw[i][0]] += 1;
    for (let i = 0; left < 0; i = (i + 1) % 3) if (out[raw[i][0]] > 2) (out[raw[i][0]] -= 1), (left += 1);
    return out;
  }

  update(push = false) {
    const s = this.state;
    const t = (k) => this.t(k);
    this.el.tag.classList.toggle("on", this.changed());
    this.el.demandV.textContent = s.demand.toLocaleString();
    this.el.parkV.textContent = s.parking.toLocaleString();
    const dp = s.parking - this.cfg.parking.default;
    this.el.parkD.textContent = dp > 0 ? `+${dp} ${t("proposed")}` : dp < 0 ? `${dp} ${t("closed")}` : "";
    this.el.parkD.className = `pl-delta ${dp > 0 ? "up" : dp < 0 ? "down" : ""}`;
    const dx = s.xray - this.cfg.xray.default;
    this.el.xrayD.textContent = dx > 0 ? `+${dx} ${t("proposed")}` : dx < 0 ? `${-dx} ${t("outOfService")}` : "";
    this.el.xrayD.className = `pl-delta ${dx > 0 ? "up" : dx < 0 ? "down" : ""}`;
    this.root.querySelectorAll("#pl-xray button").forEach((b) => b.classList.toggle("on", Number(b.dataset.n) === s.xray));

    const now = model(this.cfg, s);
    const was = model(this.cfg, this.baseline());
    this.result = now;

    /* per-category rows */
    this.el.cats.innerHTML = CATS.map((c) => {
      const q = now.cats[c];
      const w = Math.min(100, (Number.isFinite(q.rho) ? q.rho : 1.2) * 100);
      return `<div class="pl-cat">
        <i style="background:${this.cat(c).color}"></i>
        <span class="nm">${this.catName(c)}</span>
        <span class="num">${q.docks} ${t("docks")} · ${Math.round(q.share * 100)}%</span>
        <span class="bar"><u class="${level(q.rho)}" style="width:${w}%"></u></span>
        <span class="num r">${pct(q.rho)} · ${fmtHours(q.wait)}</span>
        <span class="live" data-live="${c}"></span>
      </div>`;
    }).join("");

    /* impact tiles: today vs proposal */
    const tile = (label, a, b, fmt, better, sub = "") => {
      const fa = fmt(a);
      const fb = fmt(b);
      const diff = fa !== fb;
      const good = diff && better(a, b);
      return `<div class="pl-tile"><span class="lb">${label}</span>
        <div class="vv"><span class="was">${diff ? fa : ""}</span>${diff ? "<em>→</em>" : ""}<b class="${diff ? (good ? "good" : "bad") : ""}">${fb}</b></div>
        <span class="sb">${sub}</span></div>`;
    };
    const lower = (a, b) => b < a;
    const higher = (a, b) => b > a;
    this.el.tiles.innerHTML = [
      tile(t("delay"), was.delay, now.delay, (h) => fmtHours(h), lower, `X-ray ${fmtHours(now.xray.wait)} · ${t("rampsShort")} ${fmtHours(now.rampDelay)}`),
      tile(t("peak"), was.occupancy, now.occupancy, pct, lower, now.overflow > 0 ? `<span class="warn">${Number.isFinite(now.overflow) ? `${Math.round(now.overflow)} ${t("trucks")} ${t("overflow")}` : t("unbounded")}</span>` : `${Math.round(now.inYard)} / ${s.parking} ${t("bays")}`),
      tile(t("xrayLoad"), was.xray.rho, now.xray.rho, pct, lower, now.xray.stable ? `${s.xray} ${t("scanners")}` : `<span class="warn">${t("unbounded")}</span>`),
      tile(t("capacity"), was.capacity, now.capacity, (v) => Math.round(v).toLocaleString(), higher, `${t("bottleneck")} ${t("bn")[now.bottleneck]}`),
    ].join("");
    if (push) this.onChange(this.state);
  }

  /* Live counts from the simulation, refreshed while the panel is open. */
  live(stats) {
    if (!this.root) return;
    this.root.querySelectorAll("[data-live]").forEach((el) => {
      const c = el.dataset.live;
      el.textContent = `${this.t("live")}: ${stats.inspected[c]} ${this.t("inspected")} · ${stats.waved[c]} ${this.t("waved")}`;
    });
  }
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
    CATS.forEach((c, i) => {
      segs[i].style.flex = `${v[c]} 0 0`;
      segs[i].querySelector("span").textContent = label(c, v[c]);
      segs[i].title = label(c, v[c]);
      acc += v[c];
      if (i < 2) handles[i].style.left = `${(acc / total) * 100}%`;
    });
  };
  handles.forEach((h, i) => {
    h.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = track.getBoundingClientRect();
        let at = Math.round(((ev.clientX - r.left) / r.width) * total);
        if (getComputedStyle(track).direction === "rtl") at = total - at;
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
