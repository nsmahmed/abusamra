import { VEHICLE_SPECS, pick } from "./vehicles.js";

const rnd = (a, b) => a + Math.random() * (b - a);
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

class Route {
  constructor(raw) {
    const n = raw.p.length;
    this.id = raw.id;
    this.kind = raw.kind;
    this.flow = raw.flow;
    this.name = raw.name;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.cum = new Float32Array(n);
    this.v = Uint8Array.from(raw.v);
    for (let i = 0; i < n; i += 1) {
      this.x[i] = raw.p[i][0];
      this.y[i] = raw.p[i][1];
      if (i) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.length = this.cum[n - 1];
    this.stops = raw.stops.map((stop) => ({ ...stop }));
  }

  index(s) {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  at(s, out = {}) {
    const c = Math.min(this.length, Math.max(0, s));
    const i = Math.min(this.index(c), this.cum.length - 2);
    const span = this.cum[i + 1] - this.cum[i] || 1;
    const t = (c - this.cum[i]) / span;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    out.i = i;
    return out;
  }

  speedClass(s) {
    return this.v[this.index(Math.min(this.length, Math.max(0, s)))];
  }
}

const KSA_LETTERS = ["أ ب ج", "ر س ط", "ك ل م", "ن هـ و", "د ص ع", "ب ح ي"];
const CARGO = ["Foodstuffs", "Construction steel", "Electronics", "Animal feed", "Auto parts", "Furniture", "Textiles", "Cement", "Fresh produce", "Machinery", "Building materials", "Household goods"];
const STOP_LABEL = {
  portal: "Radiation scan",
  gate: "Gate check",
  yard: "Holding yard",
  xray: "X-ray scan",
  ramp: "Inspection ramp",
  booth: "Passport and customs booth",
};
const GATE_LABEL = {
  "inbound-gate": "Appointment check",
  "outbound-gate": "Outbound entrance",
  "inbound-release": "Release gate",
  "outbound-release": "Release gate",
};
const stopLabel = (stop) => (stop.kind === "gate" && GATE_LABEL[stop.ref]) || STOP_LABEL[stop.kind];

export class Simulation {
  constructor(data, fleet, hooks = {}) {
    this.fleet = fleet;
    this.hooks = hooks;
    this.time = 0;
    this.clock0 = 7 * 3600 + 30 * 60;
    this.routes = data.routes.map((raw) => new Route(raw));
    this.vehicles = [];
    this.nextId = 1;
    this.stations = new Map();
    this.stats = { passengers: 0, buses: 0, scans: [], cleared: [], inspections: 0, released: 0 };
    this.tmp = {};
    this.tmp2 = {};

    const station = (ref, kind, extra = {}) => {
      if (!this.stations.has(ref)) this.stations.set(ref, { ref, kind, busy: 0, lanes: [0], load: [0], openUntil: 0, active: 0, ...extra });
      return this.stations.get(ref);
    };
    for (const booth of data.booths) station(booth.lane, "booth");
    for (const gate of data.gates) {
      const lanes = gate.lanes === 3 ? [0, 4.6, -4.6] : [0, 4.6];
      station(gate.ref, gate.kind, { lanes, load: lanes.map(() => 0), laneBusy: lanes.map(() => 0), laneOpen: lanes.map(() => 0) });
    }
    for (const portal of data.portals) station(portal.ref, "portal", { lanes: [0, 4.6], load: [0, 0], laneBusy: [0, 0], laneOpen: [0, 0] });
    for (const xray of data.xrays) station(xray.id, "xray");
    for (const route of this.routes) {
      for (const stop of route.stops) station(String(stop.ref), stop.kind);
      route.laneStops = route.stops.filter((stop) => this.station(stop.ref).laneBusy);
      route.nextSpawn = route.kind === "car" ? rnd(0, 30) : rnd(0, 500);
    }
  }

  get clock() {
    return this.clock0 + this.time;
  }

  station(ref) {
    return this.stations.get(String(ref));
  }

  spawn(route) {
    const truck = route.kind === "truck";
    const type = truck ? "truck" : Math.random() < 0.07 ? "bus" : "car";
    const vehicle = {
      id: this.nextId++,
      type,
      route,
      s: 0,
      speed: truck ? 12 : 18,
      state: "drive",
      stopIdx: 0,
      dwell: 0,
      shift: 0,
      lane: -1,
      laneOffset: null,
      laneReg: new Map(),
      ghost: 0,
      stuck: 0,
      x: route.x[0],
      y: route.y[0],
      dx: 0,
      dy: 1,
      spawnedAt: this.time,
      scale: type === "car" && Math.random() < 0.3 ? 1.1 : 1,
      phase: "approach",
    };
    const spec = VEHICLE_SPECS[type];
    vehicle.spec = spec;
    if (truck) {
      const inbound = route.flow === "inbound";
      vehicle.plate = inbound ? `${Math.floor(1000 + Math.random() * 8999)} ${pick(KSA_LETTERS)}` : `${Math.floor(100000 + Math.random() * 899999)}`;
      vehicle.origin = inbound ? "Saudi Arabia → Qatar" : "Qatar → Saudi Arabia";
      vehicle.declaration = `QA-${inbound ? "IM" : "EX"}-2026-${Math.floor(100000 + Math.random() * 899999)}`;
      vehicle.cargo = pick(CARGO);
    } else {
      vehicle.plate = `${Math.floor(10000 + Math.random() * 899999)}`;
      vehicle.origin = route.flow === "arrival" ? "Arriving in Qatar" : "Departing Qatar";
    }
    if (!this.fleet.allocate(vehicle)) return null;
    if (vehicle.tanker) vehicle.cargo = "Fuel / liquid bulk";
    this.vehicles.push(vehicle);
    return vehicle;
  }

  startClear(route) {
    for (const v of this.vehicles) {
      if (v.route === route && v.s < 26) return false;
    }
    return true;
  }

  buildGrid() {
    const grid = new Map();
    for (const v of this.vehicles) {
      const key = Math.floor(v.x / 30) * 100003 + Math.floor(v.y / 30);
      let cell = grid.get(key);
      if (!cell) grid.set(key, (cell = []));
      cell.push(v);
    }
    return grid;
  }

  leaderGap(v, grid) {
    let best = Infinity;
    const cx = Math.floor(v.x / 30);
    const cy = Math.floor(v.y / 30);
    for (let gx = cx - 1; gx <= cx + 1; gx += 1) {
      for (let gy = cy - 1; gy <= cy + 1; gy += 1) {
        const cell = grid.get(gx * 100003 + gy);
        if (!cell) continue;
        for (const o of cell) {
          if (o === v) continue;
          const rx = o.x - v.x;
          const ry = o.y - v.y;
          const ahead = rx * v.dx + ry * v.dy;
          if (ahead <= 0.5 || ahead > 45) continue;
          const lat = Math.abs(rx * v.dy - ry * v.dx);
          if (lat > 2.3 || lat > ahead) continue;
          if (o.dx * v.dx + o.dy * v.dy < 0.35) continue;
          const gap = ahead - (v.spec.length + o.spec.length) / 2;
          if (gap < best) best = gap;
        }
      }
    }
    return best;
  }

  dwellFor(v, stop) {
    const ref = String(stop.ref);
    switch (stop.kind) {
      case "booth":
        return v.type === "bus" ? rnd(80, 140) : rnd(22, 50);
      case "portal":
        return rnd(8, 14);
      case "gate":
        return ref.endsWith("release") ? rnd(25, 55) : rnd(45, 95);
      case "yard":
        return rnd(480, 1300);
      case "ramp":
        return rnd(700, 1500);
      default:
        return 20;
    }
  }

  stopTarget(stop) {
    return stop.kind === "xray" ? stop.s - 16 : stop.s;
  }

  arrive(v, stop) {
    const st = this.station(stop.ref);
    if (stop.kind === "xray") {
      v.state = "scan";
      if (st) st.active += 1;
      return;
    }
    v.state = "dwell";
    v.speed = 0;
    v.dwell = this.dwellFor(v, stop);
    if (st) {
      st.busy += 1;
      if (st.laneBusy && v.lane >= 0) st.laneBusy[v.lane] += 1;
    }
  }

  finish(v, stop) {
    const st = this.station(stop.ref);
    const ref = String(stop.ref);
    if (st) {
      if (stop.kind === "xray") st.active = Math.max(0, st.active - 1);
      else st.busy = Math.max(0, st.busy - 1);
      if (st.laneBusy && v.lane >= 0) {
        st.laneBusy[v.lane] = Math.max(0, st.laneBusy[v.lane] - 1);
        st.laneOpen[v.lane] = performance.now() + 2600;
      }
      st.openUntil = performance.now() + 2600;
    }
    if (stop.kind === "booth") {
      this.stats.passengers += v.type === "bus" ? 28 : Math.round(rnd(1, 4));
      if (v.type === "bus") this.stats.buses += 1;
    }
    if (stop.kind === "xray") this.stats.scans.push(this.time);
    if (stop.kind === "ramp") this.stats.inspections += 1;
    if (stop.kind === "gate" && !ref.endsWith("release") && v.type === "truck") {
      v.phase = "in";
      v.enteredAt = this.time;
    }
    if (stop.kind === "gate" && ref.endsWith("release")) {
      v.phase = "cleared";
      this.stats.released += 1;
      if (v.enteredAt !== undefined) {
        this.stats.cleared.push((this.time - v.enteredAt) / 60);
        if (this.stats.cleared.length > 30) this.stats.cleared.shift();
      }
    }
    v.state = "drive";
    v.stopIdx += 1;
    v.stuck = 0;
  }

  /* Multi-lane gates: pick the shortest lane and keep it through gates that sit close together. */
  updateLanes(v) {
    for (const stop of v.route.laneStops) {
      if (stop.s - v.s > 170 || v.s > stop.s + 60 || v.laneReg.has(stop)) continue;
      const st = this.station(stop.ref);
      let idx = v.laneOffset === null ? -1 : st.lanes.indexOf(v.laneOffset);
      if (idx < 0) {
        idx = 0;
        for (let i = 1; i < st.load.length; i += 1) if (st.load[i] < st.load[idx]) idx = i;
      }
      st.load[idx] += 1;
      v.laneReg.set(stop, { idx, done: false });
      v.laneOffset = st.lanes[idx];
    }
    let weight = 0;
    let open = false;
    for (const [stop, entry] of v.laneReg) {
      const at = stop.s;
      weight = Math.max(weight, smooth(at - 130, at - 60, v.s) * (1 - smooth(at + 18, at + 60, v.s)));
      if (!entry.done && v.s > at + 60) {
        const st = this.station(stop.ref);
        st.load[entry.idx] = Math.max(0, st.load[entry.idx] - 1);
        entry.done = true;
      }
      if (!entry.done) open = true;
    }
    v.shift = (v.laneOffset || 0) * weight;
    if (!open && weight === 0) v.laneOffset = null;
    const stop = v.route.stops[v.stopIdx];
    const entry = stop && v.laneReg.get(stop);
    v.lane = entry ? entry.idx : -1;
  }

  dropLanes(v) {
    for (const [stop, entry] of v.laneReg) {
      if (entry.done) continue;
      const st = this.station(stop.ref);
      st.load[entry.idx] = Math.max(0, st.load[entry.idx] - 1);
    }
  }

  position(v) {
    const r = v.route;
    const a = r.at(v.s - 3, this.tmp);
    const ax = a.x;
    const ay = a.y;
    const b = r.at(v.s + 3, this.tmp2);
    let dx = b.x - ax;
    let dy = b.y - ay;
    const n = Math.hypot(dx, dy) || 1;
    dx /= n;
    dy /= n;
    const c = r.at(v.s, this.tmp);
    v.dx = dx;
    v.dy = dy;
    v.x = c.x - dy * v.shift;
    v.y = c.y + dx * v.shift;
  }

  step(dt) {
    this.time += dt;
    for (const route of this.routes) {
      if (this.time < route.nextSpawn) continue;
      if (!this.startClear(route)) {
        route.nextSpawn = this.time + 4;
        continue;
      }
      this.spawn(route);
      route.nextSpawn = this.time + (route.kind === "car" ? rnd(30, 80) : route.flow === "inbound" ? rnd(520, 900) : rnd(700, 1200));
    }

    const grid = this.buildGrid();
    const removed = [];
    for (const v of this.vehicles) {
      const route = v.route;
      const stop = route.stops[v.stopIdx];
      if (v.state === "dwell") {
        v.dwell -= dt;
        if (v.dwell <= 0) this.finish(v, stop);
        continue;
      }
      const spec = v.spec;
      let target = spec.vmax[route.speedClass(v.s + 10)];
      let distance = Infinity;
      this.updateLanes(v);
      if (stop) {
        if (v.state === "scan") {
          target = 0.24;
          if (v.s >= stop.s + 16) this.finish(v, stop);
        } else {
          distance = this.stopTarget(stop) - v.s;
          target = Math.min(target, Math.sqrt(2 * 1.8 * Math.max(0, distance - 0.2)) + (distance > 0.3 ? 0.25 : 0));
          if (distance <= 0.4) {
            v.s = Math.max(v.s, this.stopTarget(stop));
            this.arrive(v, stop);
            continue;
          }
        }
      }
      if (v.ghost > 0) {
        v.ghost -= dt;
      } else {
        const gap = this.leaderGap(v, grid);
        if (gap < Infinity) {
          target = Math.min(target, Math.max(0, gap - 2.2) * 0.7);
          if (stop && (stop.kind === "yard" || stop.kind === "ramp") && distance < 90 && gap < 4 && v.speed < 0.4) {
            this.arrive(v, stop);
            continue;
          }
        }
      }
      const delta = target - v.speed;
      v.speed += Math.max(-4.5 * dt, Math.min(spec.accel * dt, delta));
      if (v.speed < 0.05) {
        v.stuck += dt;
        if (v.stuck > 120) {
          v.ghost = 25;
          v.stuck = 0;
        }
      } else {
        v.stuck = 0;
      }
      v.s += v.speed * dt;
      this.position(v);
      if (v.s >= route.length - 1) removed.push(v);
    }
    if (removed.length) {
      for (const v of removed) {
        this.dropLanes(v);
        this.fleet.release(v);
        if (this.hooks.onRemove) this.hooks.onRemove(v);
      }
      const gone = new Set(removed);
      this.vehicles = this.vehicles.filter((v) => !gone.has(v));
    }
  }

  advance(seconds) {
    let left = seconds;
    while (left > 0) {
      const dt = Math.min(0.5, left);
      this.step(dt);
      left -= dt;
    }
  }

  pose(v) {
    const r = v.route;
    if (v.type !== "truck") {
      return { cx: v.x, cz: -v.y, cyaw: Math.atan2(v.dx, -v.dy) };
    }
    const sx = -v.dy * v.shift;
    const sy = v.dx * v.shift;
    const f0 = r.at(v.s + 4.0, this.tmp);
    const f0x = f0.x;
    const f0y = f0.y;
    const f1 = r.at(v.s + 7.0, this.tmp2);
    const cdx = f1.x - f0x;
    const cdy = f1.y - f0y;
    const front = r.at(v.s + 5.5, this.tmp);
    const cx = front.x + sx;
    const cy = front.y + sy;
    const tf = r.at(v.s + 4.0, this.tmp);
    const tfx = tf.x;
    const tfy = tf.y;
    const tr = r.at(v.s - 8.1, this.tmp2);
    return {
      cx,
      cz: -cy,
      cyaw: Math.atan2(cdx, -cdy),
      tx: (tfx + tr.x) / 2 + sx,
      tz: -((tfy + tr.y) / 2 + sy),
      tyaw: Math.atan2(tfx - tr.x, -(tfy - tr.y)),
    };
  }

  render() {
    for (const v of this.vehicles) this.fleet.place(v, this.pose(v));
  }

  describe(v) {
    const stop = v.route.stops[v.stopIdx];
    let status = "Driving";
    if (v.state === "dwell") status = stopLabel(stop) || "Stopped";
    else if (v.state === "scan") status = "Passing through the x-ray gantry";
    else if (v.speed < 0.3) status = stop ? `Queuing for ${stopLabel(stop).toLowerCase()}` : "Waiting";
    const next = stop ? stopLabel(stop) : "Exit toward " + (v.route.flow === "inbound" || v.route.flow === "arrival" ? "Doha" : "Saudi Arabia");
    const done = v.route.stops.slice(0, v.stopIdx).map((s) => stopLabel(s));
    return {
      title: v.type === "truck" ? (v.tanker ? "Tanker truck" : "Container truck") : v.type === "bus" ? "Passenger bus" : "Passenger car",
      plate: v.plate,
      origin: v.origin,
      cargo: v.cargo,
      declaration: v.declaration,
      status,
      next,
      done,
      speed: Math.round(v.speed * 3.6),
      minutes: Math.round((this.time - v.spawnedAt) / 60),
      plan: v.route.stops.map((s, i) => ({ label: stopLabel(s), state: i < v.stopIdx ? "done" : i === v.stopIdx ? "now" : "next" })),
    };
  }

  kpis(staticYard, yardCapacity, staticRamp) {
    let trucksIn = 0;
    let yardDyn = 0;
    let rampDyn = 0;
    let cars = 0;
    let trucksMoving = 0;
    for (const v of this.vehicles) {
      if (v.type === "truck") {
        if (v.phase === "in") trucksIn += 1;
        const stop = v.route.stops[v.stopIdx];
        if (v.state === "dwell" && stop && stop.kind === "yard") yardDyn += 1;
        if (v.state === "dwell" && stop && stop.kind === "ramp") rampDyn += 1;
        if (v.state !== "dwell") trucksMoving += 1;
      } else {
        cars += 1;
      }
    }
    const window = Math.min(3600, Math.max(600, this.time));
    const scans = this.stats.scans.filter((t) => t > this.time - window).length * (3600 / window);
    const cleared = this.stats.cleared;
    const avg = cleared.length ? cleared.reduce((a, b) => a + b, 0) / cleared.length : 0;
    let boothsBusy = 0;
    let booths = 0;
    for (const st of this.stations.values()) {
      if (st.kind === "booth") {
        booths += 1;
        if (st.busy > 0) boothsBusy += 1;
      }
    }
    return {
      trucksIn: trucksIn + staticYard + staticRamp,
      yard: staticYard + yardDyn,
      yardCapacity,
      scansPerHour: Math.round(scans),
      avgClearance: avg,
      inspections: staticRamp + rampDyn,
      passengers: this.stats.passengers,
      vehicles: cars,
      trucksMoving,
      booths,
      boothsBusy,
      released: this.stats.released,
    };
  }
}
