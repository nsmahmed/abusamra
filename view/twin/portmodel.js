/* WASL port model: one engine behind the planner, the dashboards, the truck cards, goal seeking
   and the 2030 story page.

   What it is made of (all parameters come from learned.json, written by ml/learn.py):
   - A synthetic population of 4,000 import trucks drawn from Gaussian mixtures fitted to the
     2026 gate-pass journeys (stage times per truck, category, X-ray, arrival hour, plate country).
   - Queues for the X-ray lanes and for the inspection docks of each category, one hour at a time
     over three days with the learned arrival profile and the shift-handover capacity dips. Each
     hour is a multi-server queue (Sakasegawa's M/M/c approximation) plus a fluid backlog when
     arrivals outrun capacity.
   - Calibration: the effective X-ray cycle time, the effective dock occupancy time, and today's
     split of docks between categories are solved so the queues reproduce the waiting times seen
     in the data. The dock split is therefore inferred from waits, not read from a file.
   - A scenario rescales each synthetic truck's stages by how much its queues change, so the shape
     of waiting (the long tail, the night effect) comes from data and the size from the queues.
   Every headline figure is a median, as in the GAC bottleneck report. */

export const CATS = ["chem", "oga", "health"];
export const STAGE_KEYS = ["gate", "decl", "xq", "iq", "insp", "exit"];
const H = 24;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const median = (a) => quantile(a, 0.5);
function quantile(arr, p) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(a.length - 1, lo + 1)] - a[lo]) * (i - lo);
}
/* Deterministic per-truck uniforms, so a lever always selects the same trucks. */
const hash01 = (i, salt) => {
  let x = (i + 1) * 2654435761 + salt * 97531;
  x = (x ^ (x >>> 16)) * 2246822507;
  x = (x ^ (x >>> 13)) * 3266489909;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

/* Mean wait in queue (hours) for c servers of service time S at arrival rate lam per hour:
   Sakasegawa's approximation, smooth in c so fractional staffing works. */
function mmcWait(c, S, lam) {
  if (lam <= 0) return 0;
  const rho = Math.min(0.97, (lam * S) / Math.max(1e-6, c));
  return (S * rho ** (Math.sqrt(2 * (c + 1)) - 1)) / (Math.max(1e-6, c) * (1 - rho));
}

/* One resource hour by hour: a warm-up day, then a week at the scenario's demand. Returns the
   arrival-weighted mean wait (h) over that week, utilisation, and how fast an unserved backlog
   grows (trucks per day). A week is the horizon of a surge episode, and it keeps an overloaded
   scenario finite: the queue it reports is what a week of that demand would build. */
const WEEK = 7;
function queueDays(c, S, lamDay, prof, avail) {
  let Q = 0;
  let qEnd1 = 0;
  let wsum = 0;
  let lsum = 0;
  let busy = 0;
  let capSum = 0;
  let peak = 0;
  for (let d = 0; d <= WEEK; d += 1) {
    for (let h = 0; h < H; h += 1) {
      const lam = lamDay * prof[h];
      const servers = Math.max(1e-6, c * avail[h]);
      const thr = servers / S;
      const before = Q;
      Q = Math.max(0, Q + lam - thr);
      if (d >= 1) {
        const wq = mmcWait(servers, S, lam) + (before + Q) / 2 / thr;
        wsum += lam * wq;
        lsum += lam;
        busy += Math.min(lam + before, thr) * S;
        capSum += servers;
        peak = Math.max(peak, (lam * S) / servers);
      }
    }
    if (d === WEEK - 1) qEnd1 = Q;
  }
  return { wait: lsum ? wsum / lsum : 0, util: capSum ? busy / capSum : 0, peak, growth: Q - qEnd1, backlog: Q };
}

export class PortModel {
  constructor(learned, cfg) {
    this.L = learned;
    this.cfg = cfg;
    const L = learned;
    const m = cfg.model || {};
    this.base = L.demand.currentPerDay;
    const tot = L.demand.hourly.reduce((a, b) => a + b, 0);
    this.prof = L.demand.hourly.map((v) => v / tot);
    /* Capacity by hour: inspection starts against their own neighbourhood, so only the local
       collapses at 06:00, 13:00-14:00 and 21:00-22:00 (shift handovers) count, not quiet nights. */
    const st = L.demand.inspStarts;
    this.handover = st.map((v, h) => {
      const near = [-3, -2, -1, 1, 2, 3].map((k) => st[(h + k + H) % H]).sort((a, b) => a - b);
      const ref = (near[2] + near[3]) / 2;
      return clamp(v / ref, 0.25, 1);
    });
    this.flat = Array(H).fill(1);
    this.xrayShare = L.current.kpis.xrayPct / 100;
    this.share = Object.fromEntries(CATS.map((c) => [c, L.cats[c].share / 100]));
    /* Part of the inspection queue that is agency review rather than a wait for a dock: the
       extra median wait of restricted categories over Chemical & others. */
    const iq0 = L.cats.chem.iqMedian;
    this.dockPart = Object.fromEntries(CATS.map((c) => [c, 1 - Math.max(0, L.cats[c].iqMedian - iq0) / L.cats[c].iqMedian]));
    this.elastic = L.elasticity.decl.elasticity;
    /* Share of today's X-ray and dock waits that is congestion. The rest is process latency
       (assignment, paperwork): the inspection queue stayed flat while 2026 volume doubled and is
       nearly the same at every hour, so it cannot all be queueing. */
    this.kappa = m.congestionShare ?? 0.4;
    this.prefileFactor = m.prefileFactor ?? 0.2;
    this.peakFactor = m.peakFactor ?? 1.2;
    this.damping = m.growthDamping ?? 0.55;
    this.cagr = L.demand.growth.cagr;
    this.pop = L.population.map((p, i) => ({ ...p, cat: CATS[p.c], night: p.h >= 22 || p.h < 6, u1: hash01(i, 1), u2: hash01(i, 2) }));
    this.calibrate();
    this.today = this.todayState();
    this.baseRun = this.evaluate(this.today);
  }

  /* ---------- calibration ---------- */
  calibrate() {
    const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    const xrayTarget = mean(this.pop.filter((p) => p.x).map((p) => p.s[1])) / 60;
    const lamX = this.base * this.xrayShare;
    const lanes = this.cfg.xray.default;
    const solve = (f, target, lo = 0.002, hi = 30) => {
      for (let k = 0; k < 60; k += 1) {
        const mid = Math.sqrt(lo * hi);
        if (f(mid) > target) hi = mid;
        else lo = mid;
      }
      return Math.sqrt(lo * hi);
    };
    this.Sx = solve((S) => queueDays(lanes, S, lamX, this.prof, this.handover).wait, xrayTarget * this.kappa);
    const target = Object.fromEntries(CATS.map((c) => [c, (mean(this.pop.filter((p) => p.cat === c).map((p) => p.s[2])) / 60) * this.dockPart[c] * this.kappa]));
    this.dockTarget = target;
    const total = this.cfg.docks.default;
    const need = (c, S) => {
      const lam = this.base * this.share[c];
      let lo = 1;
      let hi = 800;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (queueDays(mid, S, lam, this.prof, this.handover).wait <= target[c]) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let best = null;
    for (let S = 0.2; S <= 12; S *= 1.01) {
      const n = Object.fromEntries(CATS.map((c) => [c, need(c, S)]));
      const sum = CATS.reduce((s, c) => s + n[c], 0);
      const err = Math.abs(sum - total);
      if (!best || err < best.err) best = { S, n, err, sum };
    }
    this.Sd = best.S;
    /* round the inferred split to the real number of docks */
    const n = { ...best.n };
    let diff = total - CATS.reduce((s, c) => s + n[c], 0);
    const order = [...CATS].sort((a, b) => this.share[b] - this.share[a]);
    for (let i = 0; diff !== 0; i = (i + 1) % 3) {
      const c = order[i];
      if (diff > 0) (n[c] += 1), (diff -= 1);
      else if (n[c] > 2) (n[c] -= 1), (diff += 1);
    }
    this.inferred = n;
    this.calib = { xrayCycleMin: this.Sx * 60, dockHours: this.Sd, inferred: n, xrayTargetMin: xrayTarget * 60, dockTargetMin: Object.fromEntries(CATS.map((c) => [c, target[c] * 60])) };
  }

  todayState() {
    const c = this.cfg;
    return { surge: 0, year: 2026, parking: c.parking.default, xray: c.xray.default, docks: c.docks.default, alloc: { ...this.inferred }, prefile: c.prefile.default, green: c.green.default, overlap: 0 };
  }

  /* Square-root staffing (Halfin-Whitt): docks per category = offered load + beta * sqrt(load),
     with beta chosen so the categories use exactly the docks available. */
  smartAlloc(total, s = this.today) {
    const lamDay = this.demandOf(s);
    const load = Object.fromEntries(CATS.map((c) => [c, (lamDay / 24) * this.share[c] * (c === "chem" ? 1 - s.green / 100 : 1) * this.Sd]));
    let lo = -5;
    let hi = 40;
    const size = (b) => CATS.reduce((n, c) => n + Math.max(2, load[c] + b * Math.sqrt(load[c])), 0);
    for (let k = 0; k < 50; k += 1) {
      const mid = (lo + hi) / 2;
      if (size(mid) > total) hi = mid;
      else lo = mid;
    }
    const raw = CATS.map((c) => [c, Math.max(2, load[c] + lo * Math.sqrt(load[c]))]);
    const out = Object.fromEntries(raw.map(([c, v]) => [c, Math.floor(v)]));
    let left = total - CATS.reduce((n, c) => n + out[c], 0);
    raw.sort((a, b) => (b[1] % 1) - (a[1] % 1));
    for (let i = 0; left > 0; i = (i + 1) % 3, left -= 1) out[raw[i][0]] += 1;
    return out;
  }

  growthFactor(year) {
    let f = 1;
    for (let y = 2027; y <= year; y += 1) f *= 1 + this.cagr * this.damping ** (y - 2026);
    return f;
  }

  demandOf(s) {
    return this.base * (1 + (s.surge || 0) / 100) * this.growthFactor(s.year || 2026);
  }

  /* ---------- one scenario ---------- */
  evaluate(s, lite = false) {
    const lamDay = this.demandOf(s);
    const vol = lamDay / this.base;
    const avail = s.overlap ? this.handover.map((v) => Math.max(v, 0.92)) : this.handover;
    const green = clamp((s.green || 0) / 100, 0, 1);
    const prefile = clamp((s.prefile || 0) / 100, 0, 1);
    const base = this.baseRun;
    const xq = queueDays(s.xray, this.Sx, lamDay * this.xrayShare, this.prof, avail);
    const cats = {};
    for (const c of CATS) {
      const lam = lamDay * this.share[c] * (c === "chem" ? 1 - green : 1);
      const n = Math.max(1, s.alloc[c] || 0);
      const q = queueDays(n, this.Sd, lam, this.prof, avail);
      cats[c] = { docks: s.alloc[c] || 0, share: this.share[c], lamDay: lam, wait: q.wait, rho: q.util, peak: q.peak, growth: q.growth, busy: Math.min(n, (lam / 24) * this.Sd) };
    }
    const kx = base ? xq.wait / Math.max(1e-6, base.queues.xray.wait) : 1;
    const kc = Object.fromEntries(CATS.map((c) => [c, base ? cats[c].wait / Math.max(1e-6, base.queues.cats[c].wait) : 1]));
    const kd = vol ** this.elastic;
    /* Per-truck stages under the scenario (minutes). */
    const n = this.pop.length;
    const st = STAGE_KEYS.map(() => new Float64Array(n));
    let yardMin = 0;
    for (let i = 0; i < n; i += 1) {
      const p = this.pop[i];
      const pre = p.u1 < prefile;
      const grn = p.cat === "chem" && p.u2 < green;
      const decl = p.s[0] * kd * (pre ? this.prefileFactor : 1);
      const K = this.kappa;
      const x = p.s[1] * (K * kx + 1 - K);
      const f = this.dockPart[p.cat];
      const iq = grn ? 0 : p.s[2] * (f * (K * kc[p.cat] + 1 - K) + (1 - f));
      const insp = grn ? 0 : p.s[3];
      st[1][i] = decl;
      st[2][i] = x;
      st[3][i] = iq;
      st[4][i] = insp;
      st[5][i] = p.s[4] + p.s[5] + (p.x ? this.L.generator.xdMedian : 0);
      yardMin += decl + x + iq;
    }
    /* Parking: trucks waiting inside (Little's law on the mean yard time), with a peak-hour
       margin. Trucks that find it full wait at the entry gate. */
    const yardH = yardMin / n / 60;
    const inYard = (lamDay / 24) * yardH;
    const peakYard = inYard * this.peakFactor;
    const over = Math.max(0, peakYard - s.parking);
    const gateMin = over > 0 ? Math.min(24 * 60, (over / (lamDay / 24)) * 60) : 0;
    const stay = new Float64Array(n);
    let over12 = 0;
    for (let i = 0; i < n; i += 1) {
      st[0][i] = gateMin;
      stay[i] = gateMin + st[1][i] + st[2][i] + st[3][i] + st[4][i] + st[5][i];
      if (stay[i] > 720) over12 += 1;
    }
    const unstable = xq.growth > 1 || CATS.some((c) => cats[c].growth > 1);
    if (lite) {
      const sorted = Float64Array.from(stay).sort();
      const at = (p) => sorted[Math.round((n - 1) * p)] / 60;
      return { s, lamDay, median: at(0.5), p90: at(0.9), over12: (over12 / n) * 100, overflow: over, peakYard, unstable };
    }
    const total = stay.reduce((a, b) => a + b, 0);
    const stages = {};
    STAGE_KEYS.forEach((k, j) => {
      const has = [];
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        sum += st[j][i];
        if (k === "xq" ? this.pop[i].x : k === "iq" || k === "insp" ? st[j][i] > 0 : true) has.push(st[j][i]);
      }
      stages[k] = { median: median(has), p90: quantile(has, 0.9), share: (sum / total) * 100, hours: sum };
    });
    const byCat = {};
    for (const c of CATS) {
      const sel = [];
      for (let i = 0; i < n; i += 1) if (this.pop[i].cat === c) sel.push(stay[i]);
      byCat[c] = median(sel) / 60;
    }
    /* Daily capacity: arrivals per day each resource can sustain, with today's mix. */
    const capH = avail.reduce((a, b) => a + b, 0);
    const caps = [["xray", (s.xray * capH) / this.Sx / this.xrayShare]];
    for (const c of CATS) caps.push([c, (Math.max(1, s.alloc[c]) * capH) / this.Sd / (this.share[c] * (c === "chem" ? Math.max(0.05, 1 - green) : 1))]);
    caps.push(["parking", (s.parking / (yardH * this.peakFactor)) * 24]);
    caps.sort((a, b) => a[1] - b[1]);
    const util = { xray: xq.util, ...Object.fromEntries(CATS.map((c) => [c, cats[c].rho])), parking: peakYard / s.parking };
    const res = {
      s, lamDay, vol, stay, st,
      median: median(stay) / 60, p90: quantile(stay, 0.9) / 60, over12: (over12 / n) * 100,
      stages, byCat, util, inYard, peakYard, overflow: over,
      capacity: caps[0][1], limit: caps[0][0], caps: Object.fromEntries(caps),
      queues: { xray: xq, cats },
      unstable,
      // fields the 3D scene reads
      lam: lamDay / 24, xray: { wait: xq.wait, rho: xq.util }, cats, occupancy: peakYard / s.parking,
    };
    res.bottleneck = this.bottleneck(res);
    return res;
  }

  /* Biggest share of truck-hours, the resource running hottest, and who is stuck there. */
  bottleneck(r) {
    const order = Object.entries(r.stages).sort((a, b) => b[1].share - a[1].share);
    const [stage, info] = order[0];
    const res = Object.entries(r.util).sort((a, b) => b[1] - a[1])[0];
    return { stage, share: info.share, median: info.median, resource: res[0], util: res[1], pattern: this.pattern(r, stage) };
  }

  /* Attributes over-represented among the slowest quarter of trucks at a stage (lift). */
  pattern(r, stage) {
    const j = STAGE_KEYS.indexOf(stage);
    const n = this.pop.length;
    const vals = r.st[j];
    const cut = quantile(Array.from(vals), 0.75);
    const tests = [
      ["night", (p) => p.night],
      ["afternoon", (p) => p.h >= 13 && p.h <= 15],
      ["chem", (p) => p.cat === "chem"],
      ["oga", (p) => p.cat === "oga"],
      ["health", (p) => p.cat === "health"],
      ["multi", (p) => p.n > 1],
      ["shared", (p) => p.sh === 1],
      ["xray", (p) => p.x === 1],
      ["SA", (p) => p.co === "SA"],
      ["QA", (p) => p.co === "QA"],
    ];
    let slow = 0;
    const hit = tests.map(() => [0, 0]);
    for (let i = 0; i < n; i += 1) {
      const p = this.pop[i];
      const isSlow = vals[i] >= cut && vals[i] > 0;
      if (isSlow) slow += 1;
      tests.forEach(([, f], k) => {
        if (f(p)) {
          hit[k][1] += 1;
          if (isSlow) hit[k][0] += 1;
        }
      });
    }
    return tests
      .map(([key], k) => ({ key, inSlow: (hit[k][0] / Math.max(1, slow)) * 100, overall: (hit[k][1] / n) * 100 }))
      .filter((t) => t.overall > 3 && t.inSlow >= 20)
      .map((t) => ({ ...t, lift: t.inSlow / t.overall }))
      .filter((t) => t.lift >= 1.2)
      .sort((a, b) => b.lift - a.lift)
      .slice(0, 3);
  }

  /* ---------- why it changed ---------- */
  explain(r, b = this.baseRun) {
    const s = r.s;
    const t = this.today;
    const out = [];
    const mins = (h) => `${Math.round(h * 60)} min`;
    const dStage = (k) => r.stages[k].median - b.stages[k].median;
    if (r.lamDay !== b.lamDay) out.push({ lever: "demand", text: `Arrivals ${Math.round(b.lamDay)} → ${Math.round(r.lamDay)} trucks a day: the declaration wait grows with volume (learned elasticity ${this.elastic.toFixed(2)}), and every queue runs hotter.` });
    if (s.xray !== t.xray || Math.abs(r.queues.xray.wait - b.queues.xray.wait) > 1 / 60) {
      out.push({ lever: "xray", text: `X-ray lanes ${t.xray} → ${s.xray}: lane load ${Math.round(b.util.xray * 100)}% → ${Math.round(r.util.xray * 100)}%, so the X-ray queue moves ${Math.round(b.stages.xq.median)} → ${Math.round(r.stages.xq.median)} min for the ${Math.round(this.xrayShare * 100)}% of trucks scanned.` });
    }
    const allocChanged = CATS.some((c) => s.alloc[c] !== t.alloc[c]);
    if (allocChanged || s.docks !== t.docks) {
      const parts = CATS.map((c) => `${this.cfg.ramps.categories.find((x) => x.id === c).tag || c} ${t.alloc[c]}→${s.alloc[c]} (${Math.round(b.util[c] * 100)}%→${Math.round(r.util[c] * 100)}% busy)`);
      out.push({ lever: "docks", text: `Inspection docks ${t.docks} → ${s.docks}: ${parts.join(", ")}. Only the dock part of the inspection queue responds; agency review time stays. Inspection queue ${Math.round(b.stages.iq.median)} → ${Math.round(r.stages.iq.median)} min.` });
    }
    if (s.prefile) out.push({ lever: "prefile", text: `${s.prefile}% of trucks file the declaration before arriving: their paperwork wait drops to ${Math.round(this.prefileFactor * 100)}% of today's. Declaration wait ${Math.round(b.stages.decl.median)} → ${Math.round(r.stages.decl.median)} min.` });
    if (s.green) out.push({ lever: "green", text: `${s.green}% of Chemical & others trucks cleared in a green channel: they skip the inspection queue and free docks for the rest.` });
    if (s.overlap) out.push({ lever: "overlap", text: "Overlapping shift handovers keep docks and scanners staffed at 06:00, 13:00-14:00 and 21:00-22:00, where inspection starts collapse in the data." });
    if (r.overflow > 0) out.push({ lever: "parking", warn: true, text: `Parking full at peak: about ${Math.round(r.overflow)} trucks wait at the entry gate (${mins(r.stages.gate.median / 60)} each).` });
    else if (s.parking !== t.parking) out.push({ lever: "parking", text: `Parking ${t.parking} → ${s.parking} bays: peak use ${Math.round(r.peakYard)} trucks (${Math.round(r.occupancy * 100)}%). Bays only cut time when the yard overflows.` });
    if (r.unstable) out.push({ lever: "limit", warn: true, text: `Demand is above what ${r.limit === "xray" ? "the X-ray lanes" : r.limit === "parking" ? "the parking" : "the inspection docks"} can serve in a day: the queue grows every day (${Math.round(r.capacity)} trucks/day sustainable).` });
    return out;
  }

  /* ---------- costs ---------- */
  cost(s) {
    const C = this.cfg.costs;
    const t = this.today;
    const items = [];
    const add = (key, units, label) => {
      if (units <= 0) return;
      const c = C[key];
      items.push({ key, units, label, capex: c.capex * units, opex: c.opex * units, lead: c.lead });
    };
    add("xray", s.xray - t.xray, `${s.xray - t.xray} X-ray lane${s.xray - t.xray > 1 ? "s" : ""}`);
    add("dock", s.docks - t.docks, `${s.docks - t.docks} inspection docks`);
    /* docks that end up in another category than today, beyond the new docks themselves */
    const gained = CATS.reduce((m, c) => m + Math.max(0, s.alloc[c] - t.alloc[c]), 0);
    const reassigned = Math.max(0, gained - Math.max(0, s.docks - t.docks));
    add("realloc", reassigned, `${reassigned} docks reassigned`);
    add("parking", s.parking - t.parking, `${s.parking - t.parking} parking bays`);
    add("prefile", (s.prefile - t.prefile) / 10, `Pre-arrival filing to ${s.prefile}%`);
    add("green", (s.green - t.green) / 10, `Green channel ${s.green}%`);
    add("overlap", s.overlap ? 1 : 0, "Overlapping shift handovers");
    const years = this.cfg.costYears || 5;
    const capex = items.reduce((a, i) => a + i.capex, 0);
    const opex = items.reduce((a, i) => a + i.opex, 0);
    return { items, capex, opex, total: capex + opex * years, years, lead: items.reduce((m, i) => Math.max(m, i.lead), 0) };
  }

  /* ---------- goal seeking: inverse search over the calibrated model ---------- */
  async goalSeek({ target, year = 2026, surge = 0, metric = "median", onProgress } = {}) {
    const lim = this.limits();
    const t = this.today;
    const grid = (a, b, step) => {
      const out = [];
      for (let v = a; v <= b + 1e-9; v += step) out.push(Math.round(v));
      return out;
    };
    const xs = grid(t.xray, lim.xray[1], 1);
    const ds = grid(t.docks, lim.docks[1], Math.max(5, Math.round((lim.docks[1] - t.docks) / 6 / 5) * 5 || 10));
    const ps = grid(0, lim.prefile[1], 10);
    const gs = grid(0, lim.green[1], 10);
    const combos = [];
    for (const x of xs) for (const d of ds) for (const smart of d === t.docks ? [0, 1] : [1]) for (const p of ps) for (const g of gs) for (const o of [0, 1]) combos.push({ x, d, smart, p, g, o });
    const tried = [];
    const value = (r) => (metric === "p90" ? r.p90 : r.median);
    for (let k = 0; k < combos.length; k += 1) {
      const c = combos[k];
      const s = { ...t, year, surge, xray: c.x, docks: c.d, prefile: c.p, green: c.g, overlap: c.o };
      s.alloc = c.smart ? this.smartAlloc(c.d, s) : { ...t.alloc };
      let r = this.evaluate(s, true);
      /* size the parking so the yard never overflows at peak */
      if (r.overflow > 0) {
        s.parking = Math.min(lim.parking[1], Math.ceil((r.peakYard + 5) / 10) * 10);
        r = this.evaluate(s, true);
      }
      const cost = this.cost(s);
      tried.push({ s, value: value(r), median: r.median, p90: r.p90, over12: r.over12, cost: cost.total, capex: cost.capex, opex: cost.opex, lead: cost.lead, items: cost.items, unstable: r.unstable });
      if (k % 120 === 0) {
        if (onProgress) onProgress(k / combos.length);
        await new Promise((ok) => setTimeout(ok, 0));
      }
    }
    if (onProgress) onProgress(1);
    const ok = tried.filter((p) => p.value <= target && !p.unstable);
    const pool = ok.length ? ok : [...tried].filter((p) => !p.unstable).sort((a, b) => a.value - b.value).slice(0, 40);
    /* plans count as different only if a lever differs, not just the dock split */
    const key = (p) => JSON.stringify([p.s.xray, p.s.docks, p.s.prefile, p.s.green, p.s.overlap, p.s.parking]);
    /* Cost-smart: the cheapest plan that reaches the goal.
       Resilient: the cheapest plan that still holds the goal in a busy week (+16%, the busiest
       week in the 2026 data), so a demand spike does not undo the decision.
       Best result: the lowest time in port for at most 1.5x the Cost-smart budget. */
    const byCost = (a, b) => a.cost - b.cost || a.value - b.value;
    const cheap = [...pool].sort(byCost)[0];
    const busy = Math.round(this.L.demand.busiestWeek.vsCurrent);
    const stress = (p) => (p.stress ??= value(this.evaluate({ ...p.s, surge: surge + busy }, true)));
    const others = pool.filter((p) => key(p) !== key(cheap)).sort(byCost);
    const resilient = others.find((p) => stress(p) <= target) || [...others].sort((a, b) => stress(a) - stress(b) || a.cost - b.cost)[0] || cheap;
    const rest = others.filter((p) => key(p) !== key(resilient));
    const budget = rest.filter((p) => p.cost <= Math.max(cheap.cost * 1.5, cheap.cost + 1e6));
    const best = (budget.length ? budget : rest).sort((a, b) => a.value - b.value || a.cost - b.cost)[0] || resilient;
    for (const p of [cheap, best, resilient]) stress(p);
    const plans = [
      { id: "cheap", name: "Cost-smart", ...cheap },
      { id: "resilient", name: "Resilient", ...resilient },
      { id: "best", name: "Best result", ...best },
    ];
    /* what each lever contributes: take it out and see how far the result moves */
    for (const p of plans) {
      p.contrib = [];
      const r0 = this.evaluate(p.s, true);
      const tries = [
        ["xray", { xray: t.xray }],
        ["docks", { docks: t.docks, alloc: { ...t.alloc } }],
        ["prefile", { prefile: 0 }],
        ["green", { green: 0 }],
        ["overlap", { overlap: 0 }],
      ];
      for (const [lever, patch] of tries) {
        const same = Object.keys(patch).every((k) => JSON.stringify(p.s[k]) === JSON.stringify(patch[k]));
        if (same) continue;
        const r1 = this.evaluate({ ...p.s, ...patch }, true);
        p.contrib.push({ lever, hours: value(r1) - value(r0) });
      }
      p.contrib.sort((a, b) => b.hours - a.hours);
    }
    return { plans, reached: ok.length > 0, searched: tried.length, feasible: ok.length, target, year, metric };
  }

  /* Median time in port each year to 2030 for a fixed set of resources. */
  projection(s, years = [2026, 2027, 2028, 2029, 2030]) {
    return years.map((year) => {
      const r = this.evaluate({ ...s, year });
      return { year, median: r.median, p90: r.p90, perDay: r.lamDay, occupancy: r.occupancy, unstable: r.unstable, limit: r.limit, over12: r.over12, bottleneck: r.bottleneck };
    });
  }

  limits() {
    const c = this.cfg;
    return { parking: [c.parking.min, c.parking.max], xray: [c.xray.min, c.xray.max], docks: [c.docks.min, c.docks.max], surge: [0, c.surge.max], prefile: [0, c.prefile.max], green: [0, c.green.max] };
  }

  /* Demand presets for the surge slider, from the learned daily series. */
  presets() {
    const d = this.L.demand;
    const fmt = (s) => new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const list = [
      { pct: Math.round((d.p90PerDay / d.currentPerDay - 1) * 100), label: "Busy day (1 in 10)", sub: `${d.p90PerDay} trucks` },
      { pct: Math.round(d.busiestWeek.vsCurrent), label: "Busiest week", sub: `${fmt(d.busiestWeek.from)}–${fmt(d.busiestWeek.to)}` },
    ];
    const top = d.episodes[0];
    if (top) list.push({ pct: Math.round(top.vsCurrent), label: "Peak day 2026", sub: `${fmt(top.from)} · ${top.peak} trucks` });
    list.push({ pct: Math.round(d.marchToOctober), label: "2026 growth repeated", sub: "Mar → Oct, trucks/day" });
    for (const e of this.cfg.surge.events || []) list.push(e);
    return list.filter((p) => p.pct > 0 && p.pct <= this.cfg.surge.max).sort((a, b) => a.pct - b.pct);
  }

  /* Expected journey for one synthetic truck under a scenario (minutes per stage). */
  journey(p, r = this.baseRun) {
    const i = this.pop.indexOf(p);
    if (i < 0) return null;
    return { gate: r.st[0][i], decl: r.st[1][i], xq: r.st[2][i], iq: r.st[3][i], insp: r.st[4][i], exit: r.st[5][i], total: r.stay[i] };
  }
}

export async function loadModel(base = "") {
  const [learned, cfg] = await Promise.all([fetch(`${base}learned.json`).then((r) => r.json()), fetch(`${base}config.json`, { cache: "no-store" }).then((r) => r.json())]);
  return new PortModel(learned, cfg);
}
