/* Executive overview: a full-screen board over the twin.

   Two kinds of figure, kept apart and labelled:
   - Port KPIs (time in port, stage waits, truck-hours by stage, bottleneck, hourly pattern,
     category and plate mix) come from the learned port model: medians over 4,000 synthetic
     trucks drawn from the 2026 gate-pass patterns, under the planner's current scenario.
   - Live figures (trucks on site, process health, the trend, the activity feed) come from the
     3D simulation running behind the board. */

import { CATS } from "./portmodel.js";
import { bottleneckHTML, fmtH } from "./planner.js";
import { COUNTRY } from "./plates.js";

export const SAMPLE_STEP = 120;
const PER_HOUR = 3600 / SAMPLE_STEP;
const STAY_BINS = [2, 4, 6, 8, 12, 24];
const STAY_LABELS = ["<2 h", "2–4", "4–6", "6–8", "8–12", "12–24", "24 h+"];
const STAGE_NAME = { gate: "Wait at entry (parking full)", decl: "Wait for declaration", xq: "Queue for X-ray", iq: "Queue for inspection", insp: "Inspection", exit: "Release and gate exit" };
const STAGE_COLOR = { gate: "#c8455f", decl: "#d6b47a", xq: "#4ccfd0", iq: "#e0527a", insp: "#3fbf8a", exit: "#8a93a6" };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const int = (v) => Math.round(v).toLocaleString();
const mins = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
const put = (el, html) => {
  if (!el || el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
};

function nice(lo, hi, zero) {
  if (zero) lo = 0;
  const raw = (hi - lo || 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw));
  let a = Math.floor(lo / step) * step;
  let b = Math.ceil(hi / step) * step;
  if (b - a < 2 * step) {
    b += step;
    a = Math.max(zero ? 0 : -Infinity, a - step);
  }
  return [a, b, step];
}

function sparkPaths(values) {
  if (values.length < 2) return ["", ""];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const line = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 120).toFixed(1)},${(26 - ((v - lo) / span) * 22).toFixed(1)}`).join("");
  return [line, `${line}L120,30L0,30Z`];
}

export class Executive {
  constructor() {
    this.samples = [];
    this.events = [];
    this.lastT = -Infinity;
    this.open = false;
    this.metric = "trucks";
    this.hoverX = null;
    this.ctx = null;
    this.r = null;
    this.base = null;
  }

  sample(t, k) {
    this.samples.push({ t, trucks: k.trucksIn, park: (k.yard / Math.max(1, k.yardCapacity)) * 100, released: k.released, scans: k.scansPerHour });
    if (this.samples.length > 160) this.samples.shift();
    this.lastT = t;
  }

  release() {}

  event(item) {
    this.events.unshift(item);
    if (this.events.length > 6) this.events.pop();
  }

  /* The model run the board shows (the planner's scenario) and today's run to compare with. */
  setScenario(r, base, goal) {
    this.r = r;
    this.base = base;
    this.goal = goal;
  }

  rateAt(i, key) {
    const s = this.samples;
    const j = Math.max(0, i - PER_HOUR);
    const span = s[i].t - s[j].t;
    return span < 900 ? null : ((s[i][key] - s[j][key]) * 3600) / span;
  }

  series(metric) {
    const s = this.samples;
    const out = [];
    for (let i = Math.max(0, s.length - 61); i < s.length; i += 1) {
      const v = metric === "rate" ? this.rateAt(i, "released") : s[i][metric];
      if (v !== null) out.push({ t: s[i].t, v });
    }
    return out;
  }

  mount(ctx) {
    this.ctx = ctx;
    const $ = (id) => document.getElementById(id);
    this.root = $("exec");
    this.el = {
      sub: $("ex-sub"), health: $("ex-health"), tiles: $("ex-kpis"), trend: $("ex-trend"), trendNow: $("ex-trend-now"),
      stations: $("ex-stations"), legend: $("ex-legend"), stayStat: $("ex-stay-stat"), hist: $("ex-hist"),
      where: $("ex-where"), bn: $("ex-bn"), day: $("ex-day"), mix: $("ex-mix"), feed: $("ex-feed"), tip: $("ex-tip"), scen: $("ex-scen"),
    };
    this.root.querySelectorAll("[data-metric]").forEach((b) =>
      b.addEventListener("click", () => {
        this.metric = b.dataset.metric;
        this.root.querySelectorAll("[data-metric]").forEach((o) => o.classList.toggle("on", o === b));
        this.renderTrend();
      })
    );
    this.el.trend.addEventListener("pointermove", (e) => {
      this.hoverX = e.clientX - this.el.trend.getBoundingClientRect().left;
      this.renderTrend();
    });
    this.el.trend.addEventListener("pointerleave", () => {
      this.hoverX = null;
      this.renderTrend();
    });
    this.root.addEventListener("pointermove", (e) => {
      const mark = e.target.closest ? e.target.closest("[data-tip]") : null;
      const tip = this.el.tip;
      if (!mark) return tip.classList.remove("show");
      const [label, value] = mark.dataset.tip.split("|");
      put(tip, `<span>${esc(label)}</span>${value ? `<b>${esc(value)}</b>` : ""}`);
      tip.classList.add("show");
      const flip = e.clientX > window.innerWidth - 260;
      tip.style.left = `${e.clientX + (flip ? -14 : 14)}px`;
      tip.style.top = `${e.clientY + 14}px`;
      tip.style.transform = flip ? "translateX(-100%)" : "none";
    });
    this.root.addEventListener("pointerleave", () => this.el.tip.classList.remove("show"));
    this.el.stations.addEventListener("click", (e) => {
      const row = e.target.closest("[data-station]");
      if (row) ctx.onStation(Number(row.dataset.station));
    });
    this.el.feed.addEventListener("click", (e) => {
      const row = e.target.closest("[data-ev]");
      if (row && this.events[Number(row.dataset.ev)]) ctx.onVehicle(this.events[Number(row.dataset.ev)].v);
    });
  }

  setOpen(on) {
    this.open = on;
    this.root.classList.toggle("open", on);
    this.root.setAttribute("aria-hidden", on ? "false" : "true");
    document.getElementById("exec-back").classList.toggle("open", on);
    if (!on) this.el.tip.classList.remove("show");
  }

  build() {
    const { tr } = this.ctx;
    const spark = `<svg class="tspark" viewBox="0 0 120 30" preserveAspectRatio="none"><path class="area"/><path class="line"/></svg>`;
    const meter = `<div class="tmeter"><i></i><u></u></div>`;
    const tile = (id, label, extra = "", src = "model") => `<div class="tile src-${src}" id="xt-${id}"><span class="tl">${esc(label)}<em>${src === "live" ? "live" : "model"}</em></span><div class="tv"><b>–</b><small></small></div><div class="ts"></div>${extra}</div>`;
    this.el.tiles.__html = null;
    this.el.tiles.innerHTML =
      tile("stay", "Median time in port", meter) + tile("p90", "Slowest 10% (P90)") + tile("perday", "Trucks per day") +
      tile("decl", "Wait for declaration") + tile("iq", "Queue for inspection") + tile("trucks", "Trucks on site", spark, "live");
    put(this.el.legend, `<span><i class="sd"></i>${tr("sNormal")}</span><span><i class="sd l1"></i>${tr("sBusy")}</span><span><i class="sd l2"></i>${tr("sCongested")}</span>`);
  }

  tile(id, value, unit, sub, values) {
    const el = document.getElementById(`xt-${id}`);
    if (!el) return null;
    el.querySelector(".tv b").textContent = value;
    el.querySelector(".tv small").textContent = unit;
    put(el.querySelector(".ts"), sub);
    if (values) {
      const [line, area] = sparkPaths(values);
      el.querySelector(".line").setAttribute("d", line);
      el.querySelector(".area").setAttribute("d", area);
    }
    return el;
  }

  render(k, live) {
    if (!this.ctx || !this.r) return;
    const { tr, hhmm, clockOf } = this.ctx;
    const r = this.r;
    const b = this.base;
    const changed = this.ctx.scenarioChanged();
    const s = this.samples;
    const last = s.length - 1;
    const hourAgo = last >= PER_HOUR ? s[last - PER_HOUR] : null;
    put(this.el.sub, `Abu Samra Land Port · import trucks · model from ${this.ctx.learned.source.commercial.toLocaleString()} commercial trucks (${this.ctx.learned.source.from} – ${this.ctx.learned.source.to}) · live view since ${s.length ? hhmm(clockOf(s[0].t)) : "–"}`);
    put(this.el.scen, changed ? `<span class="ex-scen-on">Scenario applied</span> ${esc(this.ctx.scenarioLabel())}` : `<span>Today's port</span>`);
    const vs = (now, then, fmt) => (changed && fmt(now) !== fmt(then) ? `<span class="dl ${now < then ? "good" : "bad"}">${fmt(then)} → ${fmt(now)}</span>` : "");
    const goal = this.goal;
    const stay = this.tile("stay", r.median.toFixed(1), "h", `${vs(r.median, b.median, fmtH)} ${goal ? `goal ${fmtH(goal)}` : `report 2026: ${this.ctx.learned.year.kpis.medianStayH.toFixed(1)} h`}`);
    if (stay) {
      const ref = goal || b.median;
      stay.querySelector(".tmeter i").style.width = `${Math.min(100, (r.median / (ref * 2)) * 100)}%`;
      stay.querySelector(".tmeter i").className = r.median > ref * 1.05 ? "l2" : r.median > ref * 0.95 ? "l1" : "";
      stay.querySelector(".tmeter u").style.left = "50%";
    }
    this.tile("p90", fmtH(r.p90).replace(/ [hd]$/, ""), fmtH(r.p90).endsWith("d") ? "d" : "h", `${vs(r.p90, b.p90, fmtH)} ${Math.round(r.over12)}% stay over 12 h`);
    this.tile("perday", int(r.lamDay), "", `${changed && Math.round(r.lamDay) !== Math.round(b.lamDay) ? `<span class="dl">${int(b.lamDay)} → ${int(r.lamDay)}</span> ` : ""}sustainable ${int(r.capacity)} · ${esc(this.limitName(r.limit))}`);
    this.tile("decl", mins(r.stages.decl.median).replace(/ (min|h)$/, ""), mins(r.stages.decl.median).endsWith("h") ? "h" : "min", `${vs(r.stages.decl.median, b.stages.decl.median, mins)} ${Math.round(r.stages.decl.share)}% of truck-hours`);
    this.tile("iq", mins(r.stages.iq.median).replace(/ (min|h)$/, ""), mins(r.stages.iq.median).endsWith("h") ? "h" : "min", `${vs(r.stages.iq.median, b.stages.iq.median, mins)} ${Math.round(r.stages.iq.share)}% of truck-hours`);
    const tail = s.slice(-PER_HOUR - 1).map((p) => p.trucks);
    const d = hourAgo ? Math.round(k.trucksIn - hourAgo.trucks) : null;
    this.tile("trucks", int(k.trucksIn), "", d === null ? "3D simulation" : `<span class="dl">${d === 0 ? "steady" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}`}</span> vs 1 h ago`, tail);

    this.renderTrend();
    this.renderStations(k, live);
    this.renderStay();
    this.renderWhere();
    this.renderDay();
    this.renderMix();
    this.renderFeed();
  }

  limitName(key) {
    return { xray: "X-ray lanes", chem: "Chemical docks", oga: "OGA docks", health: "Health docks", parking: "parking" }[key] || key;
  }

  renderTrend() {
    if (!this.ctx) return;
    const { tr, hhmm, clockOf } = this.ctx;
    const el = this.el.trend;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w < 80 || h < 60) return;
    const def = { trucks: ["uTrucks", false], rate: ["uTrucksHr", true], park: ["uPct", false] }[this.metric] || ["uTrucks", false];
    const pts = this.series(this.metric);
    put(this.el.trendNow, pts.length ? `<b>${int(pts[pts.length - 1].v)}</b> ${tr(def[0])} · ${tr("xNow")}` : "");
    if (pts.length < 2) return put(el, `<div class="empty">${tr("xCollecting")}</div>`);
    const L = 40, R = 16, T = 12, B = 24;
    const PW = w - L - R;
    const PH = h - T - B;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const [y0, y1, step] = nice(Math.min(...pts.map((p) => p.v)), Math.max(...pts.map((p) => p.v)), def[1]);
    const X = (t) => L + ((t - t0) / (t1 - t0)) * PW;
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * PH;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="xg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d6b47a" stop-opacity="0.26"/><stop offset="1" stop-color="#d6b47a" stop-opacity="0"/></linearGradient></defs>`;
    for (let v = y0; v <= y1 + 1e-6; v += step) svg += `<line class="grid" x1="${L}" x2="${w - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${L - 9}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${int(v)}</text>`;
    const c0 = clockOf(t0);
    const every = t1 - t0 > 5400 ? 1800 : 900;
    for (let c = Math.ceil(c0 / every) * every; c <= clockOf(t1); c += every) {
      const x = X(t0 + c - c0);
      if (x < L + 14 || x > w - R - 14) continue;
      svg += `<text class="ax" x="${x.toFixed(1)}" y="${h - 6}" text-anchor="middle">${hhmm(c)}</text>`;
    }
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
    svg += `<path d="${line}L${X(t1).toFixed(1)},${T + PH}L${L},${T + PH}Z" fill="url(#xg)"/><path class="tline" d="${line}"/>`;
    let tip = "";
    let mark = pts[pts.length - 1];
    if (this.hoverX !== null) {
      mark = pts.reduce((a, p) => (Math.abs(X(p.t) - this.hoverX) < Math.abs(X(a.t) - this.hoverX) ? p : a), pts[0]);
      const x = X(mark.t);
      svg += `<line class="cross" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${T}" y2="${T + PH}"/>`;
      const flip = x > w - 150;
      tip = `<div class="ctip" style="left:${(x + (flip ? -12 : 12)).toFixed(0)}px;top:${Math.max(4, Y(mark.v) - 46).toFixed(0)}px;${flip ? "transform:translateX(-100%)" : ""}"><span>${hhmm(clockOf(mark.t))}</span><b>${int(mark.v)}</b> <em>${tr(def[0])}</em></div>`;
    }
    svg += `<circle class="tdot" cx="${X(mark.t).toFixed(1)}" cy="${Y(mark.v).toFixed(1)}" r="4.5"/></svg>`;
    put(el, svg + tip);
  }

  renderStations(k, live) {
    const { tr } = this.ctx;
    const list = this.ctx.stations(k, live);
    const flagged = list.filter((s) => s.value && s.value[2] > 0);
    const worst = flagged.reduce((m, s) => Math.max(m, s.value[2]), 0);
    put(this.el.health, flagged.length ? `<i class="sd l${worst}"></i>${flagged.length} ${tr(flagged.length === 1 ? "xAttention1" : "xAttentionN")} · ${flagged.map((s) => esc(s.name)).join(", ")}` : `<i class="sd"></i>${tr("xAllGood")}`);
    this.el.health.className = `ex-health l${worst}`;
    const status = ["sNormal", "sBusy", "sCongested"];
    let html = "";
    for (const flow of ["inbound", "outbound", "passenger"]) {
      html += `<div class="scol"><h4>${esc(this.ctx.flowName(flow))}</h4>`;
      for (const s of list) {
        if (s.flow !== flow) continue;
        const v = s.value;
        const body = v ? `<span class="sv"><b>${esc(v[0])}</b><em>${tr(v[1])}</em></span><i class="sd l${v[2]}"></i>` : `<span class="sv"><em>${s.n === "+" ? tr("xProposed") : "–"}</em></span>`;
        html += `<button type="button" class="srow tone-${s.tone}" data-station="${s.index}" data-tip="${esc(s.title)}|${v ? tr(status[v[2]]) : ""}"><span class="dotn">${s.n}</span><span class="nm">${esc(s.name)}</span>${body}</button>`;
      }
      html += "</div>";
    }
    put(this.el.stations, html);
  }

  /* Time in port of the synthetic trucks, today against the scenario. */
  renderStay() {
    const el = this.el.hist;
    const r = this.r;
    const b = this.base;
    const changed = this.ctx.scenarioChanged();
    const bin = (stay) => {
      const c = STAY_LABELS.map(() => 0);
      for (const m of stay) c[STAY_BINS.filter((e) => m / 60 >= e).length] += 1;
      return c.map((n) => (n / stay.length) * 100);
    };
    const now = bin(r.stay);
    const was = bin(b.stay);
    put(this.el.stayStat, `median <b>${fmtH(r.median)}</b> · P90 <b>${fmtH(r.p90)}</b> · <b>${Math.round(r.over12)}%</b> over 12 h${this.goal ? ` · goal ${fmtH(this.goal)}` : ""}`);
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w < 80 || h < 60) return;
    const L = 8, R = 8, T = 22, B = 22;
    const band = (w - L - R) / now.length;
    const top = Math.max(...now, ...(changed ? was : []));
    const PH = h - T - B;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    now.forEach((v, i) => {
      const x0 = L + band * i;
      const bw = Math.min(band - 6, changed ? 20 : 40);
      const bar = (val, x, cls) => {
        const bh = val ? Math.max(2, (val / top) * PH) : 0;
        return `<rect class="${cls}" x="${x.toFixed(1)}" y="${(T + PH - bh).toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" rx="3"/>`;
      };
      const over = i >= 5;
      svg += `<g data-tip="${STAY_LABELS[i]} in port|${changed ? `today ${Math.round(was[i])}% → ${Math.round(v)}%` : `${Math.round(v)}% of trucks`}"><rect x="${x0}" y="${T - 10}" width="${band}" height="${PH + B + 10}" fill="transparent"/>`;
      if (changed) svg += bar(was[i], x0 + band / 2 - bw - 1, "bar was");
      svg += bar(v, changed ? x0 + band / 2 + 1 : x0 + (band - bw) / 2, `bar${over ? " over" : ""}`);
      svg += `<text class="val" x="${(x0 + band / 2).toFixed(1)}" y="${(T + PH - (v / top) * PH - 5).toFixed(1)}" text-anchor="middle">${Math.round(v)}%</text>`;
      svg += `<text class="ax" x="${(x0 + band / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${STAY_LABELS[i]}</text></g>`;
    });
    svg += `<line class="base" x1="${L}" x2="${w - R}" y1="${T + PH}" y2="${T + PH}"/></svg>`;
    put(el, svg);
  }

  /* Share of all truck-hours by stage, with the bottleneck box. */
  renderWhere() {
    const r = this.r;
    const b = this.base;
    const changed = this.ctx.scenarioChanged();
    const keys = ["gate", "decl", "xq", "iq", "insp", "exit"].filter((k) => k !== "gate" || r.stages.gate.share > 0.2);
    const bar = keys.map((k) => `<i style="flex:${r.stages[k].share.toFixed(2)};background:${STAGE_COLOR[k]}" data-tip="${STAGE_NAME[k]}|${Math.round(r.stages[k].share)}% of truck-hours · median ${mins(r.stages[k].median)}"></i>`).join("");
    const rows = keys
      .map((k) => `<div class="wrow" data-tip="${STAGE_NAME[k]}|median ${mins(r.stages[k].median)} · P90 ${mins(r.stages[k].p90)}"><i style="background:${STAGE_COLOR[k]}"></i><span>${STAGE_NAME[k]}</span><b>${Math.round(r.stages[k].share)}%</b><em>${changed && Math.abs(r.stages[k].median - b.stages[k].median) > 0.5 ? `${mins(b.stages[k].median)} → ` : ""}${mins(r.stages[k].median)}</em></div>`)
      .join("");
    put(this.el.where, `<div class="wbar">${bar}</div><div class="wrows">${rows}</div>`);
    put(this.el.bn, bottleneckHTML(r));
  }

  /* Learned 24-hour pattern: arrivals against inspection starts (shift handovers show). */
  renderDay() {
    const el = this.el.day;
    const L = this.ctx.learned.demand;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w < 80 || h < 60) return;
    const scale = this.r.lamDay / L.hourly.reduce((a, v) => a + v, 0);
    const arr = L.hourly.map((v) => v * scale);
    const st = L.inspStarts.map((v) => v * scale);
    const P = { l: 28, r: 8, t: 10, b: 20 };
    const top = Math.ceil(Math.max(...arr, ...st) / 10) * 10;
    const X = (i) => P.l + (i / 23) * (w - P.l - P.r);
    const Y = (v) => P.t + (1 - v / top) * (h - P.t - P.b);
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    for (const hh of [6, 13, 21]) svg += `<rect x="${X(hh) - 4}" y="${P.t}" width="${X(hh + 1) - X(hh) + 8}" height="${h - P.t - P.b}" fill="rgba(255,255,255,0.05)" data-tip="${String(hh).padStart(2, "0")}:00 shift handover|inspection starts collapse"/>`;
    for (let v = 0; v <= top; v += top / 2) svg += `<line class="grid" x1="${P.l}" x2="${w - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${P.l - 5}" y="${Y(v) + 3.5}" text-anchor="end">${Math.round(v)}</text>`;
    for (const hh of [0, 6, 12, 18, 23]) svg += `<text class="ax" x="${X(hh)}" y="${h - 5}" text-anchor="middle">${String(hh).padStart(2, "0")}h</text>`;
    const path = (a) => a.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    svg += `<path d="${path(arr)}" fill="none" stroke="#d6b47a" stroke-width="2"/><path d="${path(st)}" fill="none" stroke="#4ccfd0" stroke-width="2" stroke-dasharray="4 3"/>`;
    arr.forEach((v, i) => (svg += `<rect x="${X(i) - 5}" y="${P.t}" width="10" height="${h - P.t - P.b}" fill="transparent" data-tip="${String(i).padStart(2, "0")}:00|${Math.round(v)} arrivals · ${Math.round(st[i])} inspection starts"/>`));
    svg += `</svg><div class="dkey"><span><i style="background:#d6b47a"></i>Trucks arriving / h</span><span><i style="background:#4ccfd0"></i>Inspections starting / h</span></div>`;
    put(el, svg);
  }

  renderMix() {
    const L = this.ctx.learned;
    const cats = this.ctx.cats;
    const rows = CATS.map((c) => {
      const info = L.cats[c];
      const q = this.r.cats[c];
      return `<div class="hrow" data-tip="${esc(cats[c].en)}|${info.share}% of trucks · ${q.docks} docks · ${Math.round(q.rho * 100)}% busy · median stay ${fmtH(this.r.byCat[c])}"><span><i class="sq" style="background:${cats[c].color}"></i>${esc(cats[c].tag || cats[c].short || cats[c].en)}</span><div><i style="width:${info.share}%;background:${cats[c].color}"></i></div><b>${Math.round(info.share)}%</b></div>`;
    }).join("");
    const co = Object.entries(L.countries).filter(([k]) => k !== "XX").sort((a, b) => b[1] - a[1]);
    const top = co[0][1];
    const crow = co.map(([k, v]) => `<div class="hrow" data-tip="${COUNTRY[k].en} plates|${v.toFixed(1)}% of trucks, 2026 gate passes"><span>${COUNTRY[k].en}</span><div><i style="width:${(v / top) * 100}%"></i></div><b>${Math.round(v)}%</b></div>`).join("");
    put(this.el.mix, `<div class="mix-h">Inspection category <em>from declaration items</em></div>${rows}<div class="mix-h">Plate country <em>from vehicle numbers</em></div>${crow}`);
  }

  renderFeed() {
    const { tr, hhmm } = this.ctx;
    const key = { release: "eRelease", xray: "eXray", ramp: "eRamp", gate: "eGate" };
    put(this.el.feed, this.events.map((e, i) => `<li data-ev="${i}"><time>${hhmm(e.clock)}</time><span><b>${tr(key[e.kind])}</b> · ${esc(e.plate)}</span><em>${esc(this.ctx.flowName(e.flow))}</em></li>`).join(""));
  }
}
