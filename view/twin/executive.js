/* Executive overview: a full-screen board over the twin. It keeps its own short history of the
   simulation (one sample every two simulated minutes, every released truck, the latest events)
   and draws everything from that, so each figure on it can be traced back to the 3D scene. */

export const SAMPLE_STEP = 120;
const PER_HOUR = 3600 / SAMPLE_STEP;
/* Service target for gate-to-release time. Illustrative: set it to the authority's own standard. */
const TARGET_MIN = 40;
const BIN_EDGES = [20, 25, 30, 35, 40, 45];
const BIN_LABELS = ["<20", "20–25", "25–30", "30–35", "35–40", "40–45", "45+"];
const CARGO_AR = {
  Foodstuffs: "مواد غذائية", "Construction steel": "حديد البناء", Electronics: "إلكترونيات", "Animal feed": "أعلاف",
  "Auto parts": "قطع غيار", Furniture: "أثاث", Textiles: "منسوجات", Cement: "إسمنت", "Fresh produce": "خضار وفواكه",
  Machinery: "معدات", "Building materials": "مواد بناء", "Household goods": "سلع منزلية", "Fuel / liquid bulk": "وقود وسوائل",
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const int = (v) => Math.round(v).toLocaleString();
const put = (el, html) => {
  if (el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
};

/* Axis bounds and step on round numbers, never finer than whole units. */
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

const roundTop = (x, y, w, h, r) => {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

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
    this.clearances = [];
    this.events = [];
    this.lastT = -Infinity;
    this.open = false;
    this.metric = "trucks";
    this.hoverX = null;
    this.ctx = null;
  }

  /* ---------- recording ---------- */
  sample(t, k) {
    this.samples.push({ t, trucks: k.trucksIn, park: (k.yard / Math.max(1, k.yardCapacity)) * 100, released: k.released, pax: k.passengers, scans: k.scansPerHour });
    if (this.samples.length > 160) this.samples.shift();
    this.lastT = t;
  }

  release(t, v) {
    if (v.enteredAt === undefined) return;
    this.clearances.push({ min: (t - v.enteredAt) / 60, red: v.route.stops.some((s) => s.kind === "ramp"), flow: v.route.flow });
    if (this.clearances.length > 400) this.clearances.shift();
  }

  event(item) {
    this.events.unshift(item);
    if (this.events.length > 5) this.events.pop();
  }

  /* Hourly rate of a running total at sample i, from the hour before it. */
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
      const v = metric === "rate" ? this.rateAt(i, "released") : metric === "pax" ? this.rateAt(i, "pax") : s[i][metric];
      if (v !== null) out.push({ t: s[i].t, v });
    }
    return out;
  }

  /* ---------- wiring ---------- */
  mount(ctx) {
    this.ctx = ctx;
    const $ = (id) => document.getElementById(id);
    this.root = $("exec");
    this.el = {
      sub: $("ex-sub"), health: $("ex-health"), tiles: $("ex-kpis"), trend: $("ex-trend"), trendNow: $("ex-trend-now"),
      stations: $("ex-stations"), legend: $("ex-legend"), clearStat: $("ex-clear-stat"), hist: $("ex-hist"),
      channel: $("ex-channel"), cargo: $("ex-cargo"), pax: $("ex-pax"), feed: $("ex-feed"), tip: $("ex-tip"),
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
    /* One floating tooltip for every mark that carries a data-tip of the form "label|value". */
    this.root.addEventListener("pointermove", (e) => {
      const mark = e.target.closest ? e.target.closest("[data-tip]") : null;
      const tip = this.el.tip;
      if (!mark) {
        tip.classList.remove("show");
        return;
      }
      const [label, value] = mark.dataset.tip.split("|");
      put(tip, `<span>${esc(label)}</span>${value ? `<b>${esc(value)}</b>` : ""}`);
      tip.classList.add("show");
      const flip = e.clientX > window.innerWidth - 240;
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

  /* Static labels; rebuilt when the language changes. */
  build() {
    const { tr } = this.ctx;
    const spark = `<svg class="tspark" viewBox="0 0 120 30" preserveAspectRatio="none"><path class="area"/><path class="line"/></svg>`;
    const meter = `<div class="tmeter"><i></i><u></u></div>`;
    const tile = (id, label, extra) => `<div class="tile" id="xt-${id}"><span class="tl">${tr(label)}</span><div class="tv"><b>–</b><small></small></div><div class="ts"></div>${extra}</div>`;
    this.el.tiles.__html = null;
    this.el.tiles.innerHTML =
      tile("trucks", "tTrucks", spark) + tile("clear", "tClear", meter) + tile("released", "tReleased", spark) +
      tile("park", "tParking", meter) + tile("scans", "tScans", spark) + tile("pax", "tPax", spark);
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

  /* Change against the reading an hour earlier, in plain ink: more trucks is neither good nor bad. */
  delta(now, before) {
    const { tr } = this.ctx;
    if (before === null || before === undefined) return "";
    const d = Math.round(now - before);
    return d === 0 ? `<span class="dl">${tr("xNoChange")}</span> ${tr("xVsHour")}` : `<span class="dl">${d > 0 ? "▲" : "▼"} ${int(Math.abs(d))}</span> ${tr("xVsHour")}`;
  }

  /* ---------- drawing ---------- */
  render(k, live) {
    if (!this.ctx) return;
    const { tr, hhmm, clockOf } = this.ctx;
    const s = this.samples;
    const last = s.length - 1;
    const hourAgo = last >= PER_HOUR ? s[last - PER_HOUR] : null;
    const tail = (fn) => s.slice(-PER_HOUR - 1).map(fn);

    put(this.el.sub, `${tr("xSub")} ${s.length ? hhmm(clockOf(s[0].t)) : "–"} · ${tr("xUpdated")} ${hhmm(clockOf(this.lastT))}`);

    /* headline tiles */
    this.tile("trucks", int(k.trucksIn), "", this.delta(k.trucksIn, hourAgo && hourAgo.trucks), tail((p) => p.trucks));

    const mins = this.clearances.map((c) => c.min);
    const within = mins.length ? Math.round((mins.filter((m) => m <= TARGET_MIN).length / mins.length) * 100) : null;
    const avg = k.avgClearance;
    const clear = this.tile("clear", avg ? int(avg) : "–", tr("min"), `${tr("xTarget")} ${TARGET_MIN} ${tr("min")}${within === null ? "" : ` · <span class="dl">${within}%</span> ${tr("xWithin")}`}`);
    if (clear) {
      clear.querySelector(".tmeter i").style.width = `${Math.min(100, (avg / (TARGET_MIN * 1.5)) * 100)}%`;
      clear.querySelector(".tmeter i").className = avg > TARGET_MIN ? "l2" : avg > TARGET_MIN * 0.9 ? "l1" : "";
      clear.querySelector(".tmeter u").style.left = `${100 / 1.5}%`;
    }

    const rate = last >= 0 ? this.rateAt(last, "released") : null;
    const byFlow = { inbound: 0, outbound: 0 };
    for (const c of this.clearances) if (byFlow[c.flow] !== undefined) byFlow[c.flow] += 1;
    const rates = [];
    for (let i = Math.max(0, s.length - PER_HOUR - 1); i < s.length; i += 1) {
      const v = this.rateAt(i, "released");
      if (v !== null) rates.push(v);
    }
    this.tile("released", int(k.released), "", `${rate === null ? "" : `<span class="dl">${int(rate)}</span> ${tr("xPerHour")} · `}${tr("import")} ${byFlow.inbound} · ${tr("export")} ${byFlow.outbound}`, rates);

    const pct = (k.yard / Math.max(1, k.yardCapacity)) * 100;
    const park = this.tile("park", int(pct), "%", `<span class="dl">${int(k.yard)}</span> / ${int(k.yardCapacity)} ${tr("bays")}`);
    if (park) {
      park.querySelector(".tmeter i").style.width = `${Math.min(100, pct)}%`;
      park.querySelector(".tmeter i").className = pct >= 90 ? "l2" : pct >= 75 ? "l1" : "";
      park.querySelector(".tmeter u").style.left = "90%";
    }

    this.tile("scans", int(k.scansPerHour), tr("uHour"), this.delta(k.scansPerHour, hourAgo && hourAgo.scans), tail((p) => p.scans));

    const paxRate = last >= 0 ? this.rateAt(last, "pax") : null;
    const paxRates = [];
    for (let i = Math.max(0, s.length - PER_HOUR - 1); i < s.length; i += 1) {
      const v = this.rateAt(i, "pax");
      if (v !== null) paxRates.push(v);
    }
    this.tile("pax", int(k.passengers), "", paxRate === null ? "" : `<span class="dl">${int(paxRate)}</span> ${tr("xPerHour")}`, paxRates);

    this.renderTrend();
    this.renderStations(k, live);
    this.renderClearance(mins, within);
    this.renderMix();
    this.renderPassengers(k, live, paxRate);
    this.renderFeed();
  }

  renderTrend() {
    if (!this.ctx) return;
    const { tr, hhmm, clockOf } = this.ctx;
    const el = this.el.trend;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w < 80 || h < 60) return;
    const def = { trucks: ["uTrucks", false], rate: ["uTrucksHr", true], park: ["uPct", false], pax: ["uPaxHr", true] }[this.metric];
    const pts = this.series(this.metric);
    put(this.el.trendNow, pts.length ? `<b>${int(pts[pts.length - 1].v)}</b> ${tr(def[0])} · ${tr("xNow")}` : "");
    if (pts.length < 2) {
      put(el, `<div class="empty">${tr("xCollecting")}</div>`);
      return;
    }
    const L = 40, R = 16, T = 12, B = 24;
    const PW = w - L - R;
    const PH = h - T - B;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const [y0, y1, step] = nice(Math.min(...pts.map((p) => p.v)), Math.max(...pts.map((p) => p.v)), def[1]);
    const X = (t) => L + ((t - t0) / (t1 - t0)) * PW;
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * PH;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="xg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d6b47a" stop-opacity="0.26"/><stop offset="1" stop-color="#d6b47a" stop-opacity="0"/></linearGradient></defs>`;
    for (let v = y0; v <= y1 + 1e-6; v += step) {
      svg += `<line class="grid" x1="${L}" x2="${w - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ax" x="${L - 9}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${int(v)}</text>`;
    }
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
    put(
      this.el.health,
      flagged.length
        ? `<i class="sd l${worst}"></i>${flagged.length} ${tr(flagged.length === 1 ? "xAttention1" : "xAttentionN")} · ${flagged.map((s) => esc(s.name)).join(", ")}`
        : `<i class="sd"></i>${tr("xAllGood")}`
    );
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

  renderClearance(mins, within) {
    const { tr } = this.ctx;
    const el = this.el.hist;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!mins.length) {
      put(this.el.clearStat, "");
      put(el, `<div class="empty">${tr("xCollecting")}</div>`);
      return;
    }
    const sorted = [...mins].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    put(this.el.clearStat, `<b>${within}%</b> ${tr("xWithin")} · ${tr("xMedian")} <b>${int(median)}</b> ${tr("min")} · ${mins.length} ${tr("uTrucks")}`);
    if (w < 80 || h < 60) return;
    const counts = BIN_LABELS.map(() => 0);
    for (const m of mins) counts[BIN_EDGES.filter((e) => m >= e).length] += 1;
    const L = 8, R = 8, T = 30, B = 24;
    const band = (w - L - R) / counts.length;
    const bar = Math.min(band - 2, 44);
    const top = Math.max(...counts);
    const PH = h - T - B;
    let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    counts.forEach((n, i) => {
      const x = L + band * i + (band - bar) / 2;
      const bh = n ? Math.max(3, (n / top) * PH) : 0;
      const y = T + PH - bh;
      const over = i >= 5;
      const share = Math.round((n / mins.length) * 100);
      svg += `<g data-tip="${BIN_LABELS[i]} ${tr("min")}|${n} ${tr("uTrucks")} · ${share}%"><rect x="${(L + band * i).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${PH + B}" fill="transparent"/>`;
      if (n) svg += `<path class="bar${over ? " over" : ""}" d="${roundTop(x.toFixed(1) * 1, y.toFixed(1) * 1, bar, bh, 4)}"/><text class="val" x="${(x + bar / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${n}</text>`;
      svg += `<text class="ax" x="${(x + bar / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${BIN_LABELS[i]}</text></g>`;
    });
    const tx = L + band * 5;
    svg += `<line class="base" x1="${L}" x2="${w - R}" y1="${T + PH}" y2="${T + PH}"/><line class="target" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="14" y2="${T + PH}"/><text class="ax tg" x="${(tx - 7).toFixed(1)}" y="12" text-anchor="end">${tr("xTarget")} ${TARGET_MIN} ${tr("min")}</text></svg>`;
    put(el, svg);
  }

  renderMix() {
    const { tr } = this.ctx;
    const total = this.clearances.length;
    if (total) {
      const red = this.clearances.filter((c) => c.red).length;
      const green = total - red;
      const pr = Math.round((red / total) * 100);
      put(
        this.el.channel,
        `<div class="split"><i class="g" style="flex:${Math.max(green, total * 0.02)}" data-tip="${tr("xGreen")}|${green} ${tr("uTrucks")} · ${100 - pr}%"></i><i class="r" style="flex:${Math.max(red, total * 0.02)}" data-tip="${tr("xRed")}|${red} ${tr("uTrucks")} · ${pr}%"></i></div>
        <div class="split-key"><span><i class="g"></i>${tr("xGreen")} <b>${100 - pr}%</b></span><span><i class="r"></i>${tr("xRed")} <b>${pr}%</b></span></div>`
      );
    } else put(this.el.channel, `<div class="empty">${tr("xCollecting")}</div>`);

    const tally = new Map();
    for (const name of this.ctx.cargo()) tally.set(name, (tally.get(name) || 0) + 1);
    const rows = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = rows.slice(0, 5);
    const rest = rows.slice(5).reduce((n, r) => n + r[1], 0);
    const sum = rows.reduce((n, r) => n + r[1], 0) || 1;
    const top = Math.max(1, ...shown.map((r) => r[1]));
    const label = (name) => (this.ctx.lang() === "ar" ? CARGO_AR[name] || name : name);
    let html = "";
    for (const [name, n] of shown) {
      html += `<div class="hrow" data-tip="${esc(label(name))}|${n} ${tr("uTrucks")} · ${Math.round((n / sum) * 100)}%"><span>${esc(label(name))}</span><div><i style="width:${((n / top) * 100).toFixed(1)}%"></i></div><b>${n}</b></div>`;
    }
    if (rest) html += `<div class="hrow rest"><span>${tr("xOther")}</span><div></div><b>${rest}</b></div>`;
    put(this.el.cargo, html);
  }

  renderPassengers(k, live, paxRate) {
    const { tr } = this.ctx;
    const q = (side) => [1, 2, 3, 4].reduce((n, i) => n + (live.queue.get(`${side}-${i}`) || 0), 0);
    let booths = "";
    for (let i = 0; i < k.booths; i += 1) booths += `<i class="${i < k.boothsBusy ? "on" : ""}"></i>`;
    put(
      this.el.pax,
      `<div class="pstats">
        <div><b>${int(k.passengers)}</b><span>${tr("uCleared")}</span></div>
        <div><b>${paxRate === null ? "–" : int(paxRate)}</b><span>${tr("xPerHour")}</span></div>
        <div><b>${k.vehicles}</b><span>${tr("xVehicles")}</span></div>
      </div>
      <div class="booths" data-tip="${tr("xBoothsUse")}|${k.boothsBusy} / ${k.booths}"><div class="bgrid">${booths}</div><span><b>${k.boothsBusy}</b> / ${k.booths} ${tr("xBoothsUse")}</span></div>
      <div class="pq"><span>${tr("xArrQ")} <b>${q("arrival")}</b></span><span>${tr("xDepQ")} <b>${q("departure")}</b></span></div>`
    );
  }

  renderFeed() {
    const { tr, hhmm } = this.ctx;
    const key = { release: "eRelease", xray: "eXray", ramp: "eRamp", gate: "eGate" };
    put(
      this.el.feed,
      this.events.map((e, i) => `<li data-ev="${i}"><time>${hhmm(e.clock)}</time><span><b>${tr(key[e.kind])}</b> · ${esc(e.plate)}</span><em>${esc(this.ctx.flowName(e.flow))}</em></li>`).join("")
    );
  }
}
