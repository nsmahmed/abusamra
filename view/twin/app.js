import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { buildWorld, buildFlows, buildZones } from "./world.js";
import { Fleet, pick } from "./vehicles.js";
import { Simulation } from "./sim.js";
import { Atmosphere, PRESETS } from "./atmosphere.js";
import { buildGround } from "./terrain.js";
import { buildBeacons, buildRouteTrace } from "./overlays.js";
import { Executive, SAMPLE_STEP } from "./executive.js";
import { Planner, fmtH, bottleneckHTML } from "./planner.js";
import { PortModel, CATS } from "./portmodel.js";
import { makePlate, drawCountry, COUNTRY } from "./plates.js";
import { createDemo } from "./demo.js";
import { buildInspectors } from "./people.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const wait = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function status(text) {
  $("loader-step").textContent = text;
}

const TONES = { gold: "#e6bd74", maroon: "#e0527a", green: "#3fd193", teal: "#4ccfd0", proposal: "#f0c9c4" };

/* Final colour pass, applied after tone mapping: saturation, contrast, a tint, a soft vignette
   and a fixed sub-visible dither that keeps the sky gradient from banding. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSaturation: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0.3 },
    uTint: { value: new THREE.Color("#ffffff") },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uSaturation, uContrast, uVignette;
    uniform vec3 uTint;
    varying vec2 vUv;
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c *= uTint;
      vec2 q = (vUv - 0.5) * vec2(1.0, 0.82);
      c *= 1.0 - uVignette * smoothstep(0.32, 0.86, length(q));
      c += (hash(vUv * 937.0) - 0.5) * 0.006;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

async function main() {
  status("Loading port geometry");
  const response = await fetch("../../data/processed/scene.json", { cache: "no-store" });
  if (!response.ok) throw new Error("scene.json returned " + response.status);
  const data = await response.json();
  if (!Array.isArray(data.roads) || !Array.isArray(data.routes)) {
    throw new Error("scene.json is outdated; run python -m abu_samra.scene and reload");
  }
  /* The appointment check (import) and the entry-permit gate (export) are not part of the
     operation we model: drop their gates, the stops at them and their stations, then number
     the remaining stations 1, 2, 3 ... for display. st.n stays the survey number for logic. */
  const DROP_GATES = new Set(["inbound-gate", "outbound-permit"]);
  data.gates = data.gates.filter((g) => !DROP_GATES.has(g.ref));
  for (const r of data.routes) r.stops = r.stops.filter((s) => !DROP_GATES.has(String(s.ref)));
  data.stations = data.stations.filter((st) => !((st.flow === "inbound" || st.flow === "outbound") && st.n === 3));
  for (const flow of ["inbound", "outbound"]) {
    let i = 0;
    for (const st of data.stations) if (st.flow === flow && typeof st.n === "number") st.shown = ++i;
  }
  for (const st of data.stations) if (st.shown === undefined) st.shown = st.n;
  /* Planner defaults and limits: parking bays, x-ray scanners, inspection categories, model. */
  const cfg = await (await fetch("config.json", { cache: "no-store" })).json();
  /* the shipped limits, before any the viewer saved in this browser: the demo runs on these so
     every viewer sees the same numbers */
  const cfgDefault = JSON.parse(JSON.stringify(cfg));
  /* The learned port model (ml/learn.py → learned.json): synthetic trucks, calibrated queues,
     demand profile. Every KPI on the dashboards and the planner comes from it. */
  status("Loading the learned port model");
  const learned = await (await fetch("learned.json")).json();
  const pm = new PortModel(learned, cfg);
  const plan = { pins: [], open: false };
  await wait();

  const stage = $("stage");
  /* ?film=1 or 2: a clean capture mode for video. No interface, a transparent background, and
     the port builds itself frame by frame when the capture script calls __film.frame(t).
     1 sweeps and rises the whole site seen from above; 2 is the architect's reveal (side view
     of the core, then pulling up to the plan view while the site grows outwards). */
  const filmStyle = params.get("film");
  const film = filmStyle === "1" || filmStyle === "2";
  const renderer = new THREE.WebGLRenderer({ antialias: film, alpha: film, preserveDrawingBuffer: film, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  if (film) {
    renderer.setClearColor(0x000000, 0);
    document.body.classList.add("film");
  }
  /* The picture is fill-rate bound on integrated graphics, so the default draws about a
     1080p frame whatever the display scaling, and smooths edges in post. ?quality=high lifts
     the cap and switches to multisampling for machines with a discrete GPU. */
  const high = params.get("quality") === "high";
  /* Phone view (?m=1, or a small touch screen): the live twin with three numbers and a few
     big buttons; panels, planner and feeds stay hidden. ?m=0 forces the full view. */
  const mobile = params.get("m") === "1" || matchMedia("(max-width: 760px), (pointer: coarse) and (max-width: 1024px)").matches;
  document.body.classList.toggle("mobile", mobile);
  const budget = high ? 6.5e6 : mobile ? 1.1e6 : 2.2e6;
  const fitRatio = () => Math.min(window.devicePixelRatio, high ? 2 : 1.5, Math.sqrt(budget / Math.max(1, stage.clientWidth * stage.clientHeight)));
  let pixelRatio = fitRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.appendChild(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.setSize(stage.clientWidth, stage.clientHeight);
  labels.domElement.className = "labels";
  stage.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, stage.clientWidth / stage.clientHeight, 0.5, 60000);
  const controls = new MapControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
  controls.minDistance = 12;
  controls.maxDistance = 7000;
  controls.zoomToCursor = true;

  const atmosphere = new Atmosphere(scene, renderer);

  status("Building roads, yards and customs structures");
  await wait();
  const world = buildWorld(scene, data, renderer);
  const flows = buildFlows(scene, data);
  const zones = buildZones(scene, data);
  const beacons = buildBeacons(scene, data.stations, TONES);
  const trace = buildRouteTrace(scene);
  const fleet = new Fleet(scene);

  /* ---------- desert floor and sea ---------- */
  let ground = null;
  try {
    ground = await buildGround(scene, { noise: world.noise, waterNormal: world.waterNormal, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
    world.setGround(true);
  } catch (error) {
    console.warn("Ground tone maps missing; using the plain painted desert.", error);
  }

  /* ---------- simulation ---------- */
  let followed = null;
  let warming = true;
  const feed = [];
  const exec = new Executive();
  const sim = new Simulation(data, fleet, {
    onRemove(v) {
      if (followed === v) stopFollow();
    },
    onEvent(kind, v) {
      if (kind !== "release" && kind !== "xray" && kind !== "ramp" && kind !== "gate") return;
      const item = { kind, v, plate: v.plate, flow: v.route.flow, clock: sim.clock, fresh: !warming };
      feed.unshift(item);
      if (feed.length > 4) feed.pop();
      exec.event(item);
      feedDirty = true;
    },
  });
  sim.setModel(pm);
  sim.mix = { ...pm.share };
  let feedDirty = true;

  const statics = [];
  const placeStatic = (slot, where) => {
    const v = {
      type: "truck",
      static: true,
      where,
      kind: slot.kind,
      stall: slot.stall ?? -1,
      cargo: pick(["Foodstuffs", "Construction steel", "Electronics", "Animal feed", "Auto parts", "Furniture", "Textiles", "Machinery"]),
    };
    v.profile = pick(pm.pop);
    v.plateInfo = makePlate(v.profile.co);
    v.plate = v.plateInfo.ar || v.plateInfo.text;
    v.country = v.plateInfo.country;
    v.cat = v.profile.cat;
    if (!fleet.allocate(v)) return;
    const dx = Math.sin(slot.h);
    const dy = Math.cos(slot.h);
    const yaw = Math.atan2(dx, -dy);
    v.x = slot.x;
    v.y = slot.y;
    v.dx = dx;
    v.dy = dy;
    v.pose = { cx: slot.x + dx * 5.5, cz: -(slot.y + dy * 5.5), cyaw: yaw, tx: slot.x - dx * 2.05, tz: -(slot.y - dy * 2.05), tyaw: yaw };
    fleet.place(v, v.pose);
    statics.push(v);
  };
  world.yardSlots.forEach((slot) => placeStatic(slot, "yard"));
  world.rampSlots.forEach((slot) => placeStatic(slot, "ramp"));
  sim.setBays(world.rampBays);
  /* customs officers at every bay where a truck is being inspected */
  const inspectors = buildInspectors(scene, world.rampBays);
  sim.reserveParked([...world.yardSlots, ...world.parkSlots]);

  /* ---------- trucks the capacity model sets ----------
     How full the main parking (and any proposed bays) looks, how many import docks are busy in
     each category, and how long the queue beside the x-ray lanes is, all come from the same
     model as the planner's figures, so the picture and the numbers tell one story. Each set is
     filled in a fixed shuffled order, so a small change adds or removes a few trucks rather
     than reshuffling the lot. */
  const props = new Map();
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const shuffled = (n) => {
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const parkOrder = shuffled(world.parkSlots.length);
  const bayOrder = shuffled(world.rampBays.length);
  const showProp = (key, slot, where, kind) => {
    if (props.has(key)) return;
    const before = statics.length;
    placeStatic({ ...slot, kind }, where);
    if (statics.length > before) props.set(key, statics.pop());
  };
  const hideProp = (key) => {
    const v = props.get(key);
    if (!v) return;
    if (followed === v) stopFollow();
    fleet.release(v);
    props.delete(key);
  };
  function syncProps(state, res) {
    const today = cfg.parking.default;
    /* parking: open stalls are main stalls not closed by the scenario, plus opened proposals */
    const closed = new Set(state.parking < today ? closeOrderOf(today - state.parking) : []);
    const opened = Math.max(0, state.parking - today);
    const want = Math.round(Math.min(res.inYard, state.parking));
    let n = 0;
    for (const i of parkOrder) {
      const slot = world.parkSlots[i];
      const open = slot.kind === "main" ? !closed.has(slot.stall) : slot.stall < opened;
      const key = `p${i}`;
      if (open && n < want) {
        showProp(key, slot, "yard", "main");
        n += 1;
      } else hideProp(key);
    }
    /* import docks: busy docks per category, counting trucks the simulation already has there */
    for (const cat of ["chem", "oga", "health"]) {
      const busy = Math.min(physAlloc(state)[cat] || 0, res.cats[cat].busy * (dockOrder.length / Math.max(1, state.docks)));
      const live = world.rampBays.filter((b) => b.cat === cat && b.v && b.v !== "static").length;
      let need = Math.max(0, Math.round(busy) - live);
      for (const i of bayOrder) {
        const bay = world.rampBays[i];
        if (bay.home === null) continue;
        const key = `r${i}`;
        if (bay.cat !== cat) {
          if (bay.cat && !["chem", "oga", "health"].includes(bay.cat)) continue;
          continue;
        }
        if (bay.v && bay.v !== "static") continue;
        if (need > 0 && bay.free) {
          showProp(key, bay, "ramp", "ramp");
          bay.v = "static";
          need -= 1;
        } else {
          hideProp(key);
          bay.v = null;
        }
      }
    }
    /* x-ray holding lines: the model's queue, shared by the lanes in service */
    const lanes = world.holdLines.filter((l) => !sim.xrayOff.has(l.ref));
    const queued = Number.isFinite(res.xray.wait) ? res.lam * res.xray.wait : Infinity;
    for (const line of world.holdLines) {
      const on = lanes.includes(line);
      const count = on ? Math.min(line.slots.length, Math.round(queued / Math.max(1, lanes.length))) : 0;
      line.slots.forEach((slot, k) => (k < count ? showProp(`q${line.ref}${k}`, slot, "queue", "queue") : hideProp(`q${line.ref}${k}`)));
    }
    fleet.commit();
  }
  const rampStaticCount = () => statics.filter((v) => v.where === "ramp").length + [...props.values()].filter((v) => v.where === "ramp").length;
  /* Main stalls close from the north-east end of the lot. */
  const closeRank = world.mainStalls.map((st, i) => [i, st.x * 0.76 + st.y * 0.65]).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const closeOrderOf = (k) => closeRank.slice(0, k);
  /* The scenario runs in the simulation too: arrivals (with the learned hourly profile) and
     scanner lanes. The category mix is the learned one. */
  function syncSim(state) {
    sim.setInbound(pm.demandOf(state) / 24);
    const lanes = data.xrays.map((x) => x.id);
    sim.xrayOff = new Set(state.xray < lanes.length ? lanes.slice(state.xray) : []);
    sim.tandem = new Set(lanes.slice(0, Math.max(0, state.xray - lanes.length)));
  }
  /* Docks in the scene: a scenario with more or fewer docks than exist is drawn on the real
     docks in proportion, and the difference is shown as a proposal pin. */
  let dockOrder = [];
  const physAlloc = (st) => {
    const n = dockOrder.length || st.docks;
    const raw = CATS.map((c) => [c, ((st.alloc[c] || 0) / Math.max(1, st.docks)) * n]);
    const out = Object.fromEntries(raw.map(([c, v]) => [c, Math.floor(v)]));
    let left = n - CATS.reduce((a, c) => a + out[c], 0);
    raw.sort((a, b) => (b[1] % 1) - (a[1] % 1));
    for (let i = 0; left > 0; i = (i + 1) % 3, left -= 1) out[raw[i][0]] += 1;
    return out;
  };
  {
    const ri = (data.ramps || []).find((r) => r.categories);
    const ax = ri ? [ri.categories[2].x - ri.categories[0].x, ri.categories[2].y - ri.categories[0].y] : [1, 0];
    dockOrder = world.importBays.map((b, i) => [i, b.home, b.x * ax[0] + b.y * ax[1]]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([i]) => i);
    pm.shed = ri ? ri.categories : [];
    plan.result = pm.baseRun;
    syncSim(pm.today);
    syncProps(pm.today, plan.result);
  }
  fleet.commit();

  status("Warming up traffic");
  /* Ninety simulated minutes run before the scene opens, so traffic is in a steady state and the
     dashboards open with real history: trends, released trucks and clearance times. */
  const prewarm = Number(params.get("prewarm") || 5400);
  /* Trucks parked in the main parking, including any proposed bays (the other lots have their
     own counts). */
  const mainParked = () => [...props.values()].reduce((n, v) => n + (v.where === "yard" ? 1 : 0), 0);
  const seedHistory = [];
  for (let t = 0, n = 0; t < prewarm; t += SAMPLE_STEP, n += 1) {
    sim.advance(SAMPLE_STEP);
    const k = sim.kpis(mainParked(), world.yardCapacity, rampStaticCount());
    seedHistory.push(k.trucksIn);
    exec.sample(sim.time, k);
    if (n % 3 === 2) {
      $("loader-bar").style.width = `${Math.round((t / prewarm) * 100)}%`;
      await wait();
    }
  }
  warming = false;
  sim.render();
  fleet.commit();

  /* ---------- post-processing ---------- */
  const target = new THREE.WebGLRenderTarget(stage.clientWidth, stage.clientHeight, { type: THREE.HalfFloatType, samples: high ? 4 : 0 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(stage.clientWidth, stage.clientHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(stage.clientWidth, stage.clientHeight), 0.2, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  if (!high) composer.addPass(new SMAAPass(stage.clientWidth * pixelRatio, stage.clientHeight * pixelRatio));
  /* Bloom is a soft glow; computing it at half size is invisible and much cheaper. */
  const sizeBloom = () => {
    if (!high) bloom.setSize((stage.clientWidth * pixelRatio) / 2, (stage.clientHeight * pixelRatio) / 2);
  };
  sizeBloom();

  /* ---------- lighting ---------- */
  let lighting = PRESETS[params.get("light")] ? params.get("light") : "day";
  /* Everything outside the atmosphere that follows the time of day. */
  function pushLighting() {
    const v = atmosphere.now;
    bloom.strength = v.bloom;
    bloom.threshold = v.threshold;
    bloom.radius = v.radius;
    grade.uniforms.uSaturation.value = v.saturation;
    grade.uniforms.uContrast.value = v.contrast;
    grade.uniforms.uVignette.value = v.vignette;
    grade.uniforms.uTint.value.copy(v.tint);
    world.setNight(v.night);
    zones.setNight(v.night);
    fleet.setNight(v.night);
    beacons.shared.uNight.value = v.night;
    document.body.classList.toggle("is-night", v.night > 0.5);
  }
  function applyLighting(name, instant = false) {
    lighting = name;
    atmosphere.set(name, instant);
    sim.clock0 = PRESETS[name].clock * 3600 - sim.time;
    pushLighting();
    document.querySelectorAll("[data-light]").forEach((el) => el.classList.toggle("on", el.dataset.light === name));
  }

  /* ---------- camera helpers ---------- */
  const v3 = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
  function camPose(x, y, distance, polar, bearing) {
    const t = v3(x, y);
    const offset = new THREE.Vector3().setFromSphericalCoords(distance, THREE.MathUtils.degToRad(polar), THREE.MathUtils.degToRad(180 - bearing));
    return { target: t, position: t.clone().add(offset) };
  }
  let flight = null;
  let idle = 0;
  const drift = params.get("drift") !== "0";
  function flyTo(pose, duration = 2.6) {
    flight = { from: { p: camera.position.clone(), t: controls.target.clone() }, to: pose, t: 0, duration };
    controls.enabled = false;
    idle = 0;
  }
  function stepFlight(dt) {
    if (!flight) return;
    flight.t += dt / flight.duration;
    const k = flight.t >= 1 ? 1 : flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    const lift = Math.sin(Math.PI * Math.min(1, flight.t)) * flight.from.p.distanceTo(flight.to.position) * (flight.lift ?? 0.12);
    camera.position.lerpVectors(flight.from.p, flight.to.position, k);
    camera.position.y += lift;
    controls.target.lerpVectors(flight.from.t, flight.to.target, k);
    if (flight.t >= 1) {
      const done = flight.then;
      flight = null;
      controls.enabled = true;
      if (done) done();
    }
  }

  const station = (flow, n) => data.stations.find((st) => st.flow === flow && st.n === n);
  const VIEWS = {
    overview: () => camPose(170, 130, 1680, 67, 152),
    yard: () => {
      const s = station("inbound", 4);
      return camPose(s.x, s.y, 470, 62, 128);
    },
    xray: () => {
      const x = data.xrays[0];
      return camPose(x.x, x.y, 150, 66, 108);
    },
    gates: () => {
      const p = data.portals[0] || data.gates[0];
      const g = data.gates.find((item) => item.ref === "outbound-gate") || p;
      return camPose(g.x, g.y, 150, 73, 96);
    },
    booths: () => {
      const b = data.booths[0];
      return camPose(b.x, b.y, 78, 76, THREE.MathUtils.radToDeg(b.h) + 35);
    },
    ramps: () => {
      const s = station("inbound", 6);
      return camPose(s.x, s.y, 290, 64, 132);
    },
  };

  /* ---------- language ---------- */
  const I18N = {
    en: {
      subtitle: "Digital twin · Customs operations", import: "Import", export: "Export", passengers: "Passengers",
      layers: "Layers", labels: "Labels", paths: "Flow paths", zones: "Zones", process: "Process steps",
      operations: "Operations", simulated: "Simulated", trucksOnSite: "Trucks on site", parking: "Main parking", bays: "bays",
      scans: "X-ray / hr", clearance: "Avg clearance", atRamps: "At ramps", released: "Released",
      cleared: "cleared", booths: "booths active", queue: "on approach", min: "min", activity: "Live activity",
      vOverview: "Overview", vGates: "Gates", vParking: "Parking", vXray: "X-ray", vRamps: "Ramps", vBooths: "Booths", tour: "Tour", demo: "Demo",
      exec: "Executive", planner: "Planner", xTitle: "Executive overview", xSub: "Abu Samra Land Port · figures since", xUpdated: "updated",
      xAllGood: "All stations operating normally", xAttention1: "station needs attention", xAttentionN: "stations need attention",
      tTrucks: "Trucks on site", tClear: "Avg clearance time", tReleased: "Trucks released", tParking: "Main parking occupancy", tScans: "X-ray scans", tPax: "Passengers cleared",
      xVsHour: "vs 1 h ago", xPerHour: "per hour", xTarget: "Target", xWithin: "within target", xNoChange: "No change", xNow: "now",
      mTrucks: "Trucks on site", mRate: "Releases / hr", mPark: "Parking %", mPax: "Passengers / hr",
      uTrucks: "trucks", uTrucksHr: "trucks / hr", uPct: "% full", uPaxHr: "passengers / hr",
      xTrend: "Trend · last 2 hours", xStations: "Process health", sNormal: "Normal", sBusy: "Busy", sCongested: "Congested", xProposed: "Proposed",
      xClearDist: "Clearance time · gate to release", xMedian: "median", xChannel: "Inspection channel · released trucks",
      xGreen: "Green channel", xRed: "Red channel · physical inspection", xCargo: "Cargo on site", xOther: "Other",
      xPaxHall: "Passenger hall", xBoothsUse: "booths in use", xArrQ: "Arrivals queue", xDepQ: "Departures queue", xVehicles: "vehicles on site",
      xCollecting: "Collecting data…",
      uQueue: "queued", uRoute: "en route", uFull: "", uHour: "/ h", uRamps: "in use", uReleased: "cleared", uParked: "trucks", uCleared: "travellers",
      eRelease: "Released", eXray: "X-ray scan complete", eRamp: "Inspection complete", eGate: "Gate check passed",
      mkStay: "hours in port\nmedian truck", mkDay: "trucks\na day", mkPark: "parking\nin use", mPort: "Port", mTruck: "A truck", mHint: "Drag to move · pinch to zoom",
    },
    ar: {
      subtitle: "التوأم الرقمي · العمليات الجمركية", import: "الوارد", export: "الصادر", passengers: "المسافرون",
      layers: "الطبقات", labels: "التسميات", paths: "مسارات الحركة", zones: "المناطق", process: "خطوات الإجراء",
      operations: "العمليات", simulated: "محاكاة", trucksOnSite: "الشاحنات في المنفذ", parking: "المواقف الرئيسية", bays: "موقف",
      scans: "مسح / ساعة", clearance: "متوسط التخليص", atRamps: "في الرمبات", released: "تم الإفراج",
      cleared: "مسافر", booths: "أكشاك عاملة", queue: "في الطريق", min: "دقيقة", activity: "النشاط المباشر",
      vOverview: "عام", vGates: "البوابات", vParking: "المواقف", vXray: "الأشعة", vRamps: "الرمبات", vBooths: "الأكشاك", tour: "جولة", demo: "العرض",
      exec: "العرض التنفيذي", planner: "المخطط", xTitle: "النظرة التنفيذية", xSub: "منفذ أبو سمرة البري · الأرقام منذ", xUpdated: "آخر تحديث",
      xAllGood: "جميع المحطات تعمل بشكل طبيعي", xAttention1: "محطة تحتاج إلى متابعة", xAttentionN: "محطات تحتاج إلى متابعة",
      tTrucks: "الشاحنات في المنفذ", tClear: "متوسط زمن التخليص", tReleased: "الشاحنات المفرج عنها", tParking: "إشغال المواقف الرئيسية", tScans: "المسح بالأشعة", tPax: "المسافرون المنجزون",
      xVsHour: "مقارنة بالساعة الماضية", xPerHour: "في الساعة", xTarget: "المستهدف", xWithin: "ضمن المستهدف", xNoChange: "لا تغيير", xNow: "الآن",
      mTrucks: "الشاحنات في المنفذ", mRate: "الإفراج / ساعة", mPark: "إشغال المواقف", mPax: "المسافرون / ساعة",
      uTrucks: "شاحنة", uTrucksHr: "شاحنة / ساعة", uPct: "% إشغال", uPaxHr: "مسافر / ساعة",
      xTrend: "الاتجاه · آخر ساعتين", xStations: "حالة الإجراءات", sNormal: "طبيعي", sBusy: "مزدحم", sCongested: "مكتظ", xProposed: "مقترح",
      xClearDist: "زمن التخليص · من البوابة إلى الإفراج", xMedian: "الوسيط", xChannel: "مسار التفتيش · الشاحنات المفرج عنها",
      xGreen: "المسار الأخضر", xRed: "المسار الأحمر · تفتيش فعلي", xCargo: "البضائع في المنفذ", xOther: "أخرى",
      xPaxHall: "صالة المسافرين", xBoothsUse: "أكشاك عاملة", xArrQ: "انتظار القدوم", xDepQ: "انتظار المغادرة", xVehicles: "مركبة في المنفذ",
      xCollecting: "جارٍ جمع البيانات…",
      uQueue: "بالانتظار", uRoute: "في الطريق", uFull: "", uHour: "/ س", uRamps: "قيد الاستخدام", uReleased: "خُلّصت", uParked: "شاحنة", uCleared: "مسافر",
      eRelease: "تم الإفراج", eXray: "اكتمل المسح بالأشعة", eRamp: "اكتمل التفتيش", eGate: "اجتياز البوابة",
      mkStay: "ساعة في المنفذ\nللشاحنة الوسيطة", mkDay: "شاحنة\nيوميًا", mkPark: "إشغال\nالمواقف", mPort: "المنفذ", mTruck: "شاحنة", mHint: "اسحب للتحريك · قرّب بإصبعين",
    },
  };
  const FLOWS = {
    inbound: { en: ["Import", "Saudi Arabia → Qatar"], ar: ["الوارد", "من السعودية إلى قطر"] },
    outbound: { en: ["Export", "Qatar → Saudi Arabia"], ar: ["الصادر", "من قطر إلى السعودية"] },
    passenger: { en: ["Passengers", "Cars and buses"], ar: ["المسافرون", "السيارات والحافلات"] },
  };
  let lang = params.get("lang") === "ar" ? "ar" : "en";
  const tr = (key) => I18N[lang][key] ?? key;
  const stationName = (st) => (lang === "ar" ? st.ar_short || st.ar : st.short || st.en);

  /* ---------- live values per station ---------- */
  /* Each station shows one live number from the simulation and a status light. */
  function stationLive(st, k, live) {
    const q = (...refs) => refs.reduce((s, ref) => s + (live.queue.get(ref) || 0), 0);
    const queue = (n) => [n, "uQueue", n >= 6 ? 2 : n >= 3 ? 1 : 0];
    if (st.flow === "inbound") {
      if (st.n === 1) return [live.approach.inbound, "uRoute", 0];
      if (st.n === 2) return queue(q("inbound-portal"));
      if (st.n === 4) {
        const pct = k.yard / Math.max(1, k.yardCapacity);
        return [`${Math.round(pct * 100)}%`, "uFull", pct >= 0.9 ? 2 : pct >= 0.75 ? 1 : 0];
      }
      const lv = (rho) => (!Number.isFinite(rho) || rho >= 0.9 ? 2 : rho >= 0.75 ? 1 : 0);
      if (st.n === 5) return [k.scansPerHour, "uHour", plan.result ? lv(plan.result.xray.rho) : 0];
      if (st.n === 6) return [k.inspections, "uRamps", plan.result ? Math.max(...Object.values(plan.result.cats).map((c) => lv(c.rho))) : 0];
      if (st.n === 7) return [sim.stats.releasedBy.inbound, "uReleased", 0];
      return null;
    }
    if (st.flow === "outbound") {
      if (st.n === 1) return [live.approach.outbound, "uRoute", 0];
      if (st.n === 2) return [q("export-staging"), "uParked", 0];
      if (st.n === 4) return queue(q("outbound-gate"));
      if (st.n === 5) return [q("export-parking"), "uParked", 0];
      if (st.n === 6) return [q("ramp-export"), "uRamps", 0];
      if (st.n === 7) return [sim.stats.releasedBy.outbound, "uReleased", 0];
      return null;
    }
    if (st.n === "C") return [k.passengers.toLocaleString(), "uCleared", 0];
    const side = /arrival/i.test(st.en) ? "arrival" : "departure";
    return queue(q(`${side}-1`, `${side}-2`, `${side}-3`, `${side}-4`));
  }
  const liveHtml = (value) => (value ? `<i></i><b>${value[0]}</b>${tr(value[1]) ? `<em>${tr(value[1])}</em>` : ""}` : "");

  /* ---------- station pins ---------- */
  const stationObjects = [];
  data.stations.forEach((st, index) => {
    const el = document.createElement("button");
    el.className = `station tone-${st.tone}`;
    el.title = `${st.en} · ${st.ar}`;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      focusStation(index);
    });
    const obj = new CSS2DObject(el);
    obj.position.copy(v3(st.x, st.y, beacons.items[index].height + 1.5));
    obj.center.set(0.5, 1);
    scene.add(obj);
    stationObjects.push({ st, obj, el, lv: null, railLv: null });
  });
  function paintPins() {
    for (const s of stationObjects) {
      s.el.innerHTML = `<span class="dotn">${s.st.shown}</span><span class="nm">${stationName(s.st)}</span><span class="lv"></span>`;
      s.lv = s.el.querySelector(".lv");
      s.shown = null;
    }
  }

  const focusDistance = (st) => (/parking/i.test(st.en) ? 520 : st.n === 1 ? 420 : st.n === 6 ? 300 : 210);
  function focusStation(index) {
    const { st } = stationObjects[index];
    stopTour();
    stopFollow();
    if (st.flow !== activeFlow) setFlow(st.flow);
    flyTo(camPose(st.x, st.y, focusDistance(st), 64, 138));
    highlightStep(index);
  }
  function highlightStep(index) {
    document.querySelectorAll(".step").forEach((el) => el.classList.toggle("on", Number(el.dataset.index) === index));
    stationObjects.forEach((s, i) => s.el.classList.toggle("on", i === index));
    beacons.setActive(index);
  }

  /* ---------- flow switch and process rail ---------- */
  let activeFlow = ["inbound", "outbound", "passenger"].includes(params.get("flow")) ? params.get("flow") : "inbound";
  let showLabels = params.get("labels") !== "0";
  let showFlows = params.get("flows") !== "0";
  let showZones = params.get("zones") !== "0";
  let showRail = params.get("rail") !== "0";
  function renderRail() {
    const [title, sub] = FLOWS[activeFlow][lang];
    $("rail-title").textContent = title;
    $("rail-sub").textContent = sub;
    const host = $("steps");
    host.innerHTML = "";
    stationObjects.forEach((s, index) => {
      s.railLv = null;
      const st = s.st;
      if (st.flow !== activeFlow) return;
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="step tone-${st.tone}" data-index="${index}" title="${st.en}"><span class="dotn">${st.shown}</span><span class="nm">${stationName(st)}</span><span class="lv"></span></button>`;
      li.firstChild.addEventListener("click", () => focusStation(index));
      host.appendChild(li);
      s.railLv = li.querySelector(".lv");
      s.shown = null;
    });
  }
  function applyVisibility() {
    stationObjects.forEach(({ st, obj }, index) => {
      const mine = st.flow === activeFlow;
      obj.visible = mine && showLabels;
      beacons.setVisible(index, mine);
    });
    for (const flow of ["inbound", "outbound", "passenger"]) {
      flows.setVisible(flow, flow === activeFlow && showFlows);
      zones.setVisible(flow, flow === activeFlow && showZones);
    }
    $("rail").classList.toggle("hidden", !showRail);
    for (const pin of plan.pins) pin.obj.visible = showLabels && pin.shown && (activeFlow === "inbound" || plan.open);
  }
  function setFlow(flow) {
    activeFlow = flow;
    document.querySelectorAll("[data-flow]").forEach((b) => b.classList.toggle("on", b.dataset.flow === flow));
    renderRail();
    applyVisibility();
    renderKpis();
  }
  document.querySelectorAll("[data-flow]").forEach((b) =>
    b.addEventListener("click", () => {
      stopTour();
      stopFollow();
      setFlow(b.dataset.flow);
      const first = data.stations.filter((st) => st.flow === b.dataset.flow && st.n !== 1);
      if (b.dataset.flow === "inbound") flyTo(VIEWS.overview());
      else if (first.length) {
        const cx = first.reduce((s, st) => s + st.x, 0) / first.length;
        const cy = first.reduce((s, st) => s + st.y, 0) / first.length;
        flyTo(camPose(cx, cy, b.dataset.flow === "passenger" ? 1150 : 1000, 62, 145));
      }
    })
  );

  function applyLanguage() {
    document.body.classList.toggle("ar", lang === "ar");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = I18N[lang][el.dataset.i18n] ?? el.textContent;
      el.lang = lang;
    });
    $("lang").textContent = lang === "ar" ? "EN" : "ع";
    $("m-lang").textContent = lang === "ar" ? "EN" : "ع";
    $("brand-title").innerHTML = lang === "ar" ? "منفذ أبو سمرة <span>البري</span>" : "Abu Samra <span>Land Port</span>";
    paintPins();
    renderRail();
    feedDirty = true;
    exec.build();
    if (plan.planner) {
      plan.planner.build();
      plan.paint();
    }
  }
  $("lang").addEventListener("click", () => {
    lang = lang === "ar" ? "en" : "ar";
    applyLanguage();
    renderKpis();
  });

  /* ---------- layers popover ---------- */
  const layerSwitch = (id, get, set) => {
    const input = $(id);
    input.checked = get();
    input.addEventListener("change", () => {
      set(input.checked);
      applyVisibility();
    });
  };
  layerSwitch("toggle-labels", () => showLabels, (v) => (showLabels = v));
  layerSwitch("toggle-flows", () => showFlows, (v) => (showFlows = v));
  layerSwitch("toggle-zones", () => showZones, (v) => (showZones = v));
  layerSwitch("toggle-rail", () => showRail, (v) => (showRail = v));
  $("layers-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("layers").classList.toggle("open");
    $("layers-btn").classList.toggle("on", $("layers").classList.contains("open"));
  });
  document.addEventListener("click", (e) => {
    if (!$("layers").contains(e.target)) {
      $("layers").classList.remove("open");
      $("layers-btn").classList.remove("on");
    }
  });

  /* ---------- capacity planner ----------
     What-if settings drawn into the scene: proposed parking bays light up in the unused lot (or
     main-lot stalls close), proposed x-ray gantries appear as blueprints on the x-ray lanes, and
     the import docks take the colour of the inspection category they are allocated to. */
  plan.cats = Object.fromEntries(cfg.ramps.categories.map((c) => [c.id, c]));
  const rampInfo = (data.ramps || []).find((r) => r.categories);
  const shedDocks = Object.fromEntries((rampInfo ? rampInfo.categories : []).map((c) => [c.id, c.bays]));
  /* Main stalls close from the north-east end of the lot; proposed bays open nearest first. */
  /* Docks in allocation order: by home shed, then along the line of sheds, so a category that
     outgrows its shed takes the neighbouring shed's nearest docks. */
  const shedAt = Object.fromEntries((rampInfo ? rampInfo.categories : []).map((c, i) => [i, c]));
  const axis = rampInfo ? [rampInfo.categories[2].x - rampInfo.categories[0].x, rampInfo.categories[2].y - rampInfo.categories[0].y] : [1, 0];
  dockOrder = world.importBays.map((b, i) => [i, b.home, b.x * axis[0] + b.y * axis[1]]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([i]) => i);
  const CAT_IDS = ["chem", "oga", "health"];
  /* Line icons on a 24-unit grid: a flask, a government portico, a shield with a cross. */
  const CAT_ICON = {
    chem: "M9 3h6M10 3v6.5L4.6 18.4A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.4-2.6L14 9.5V3M6.8 15h10.4",
    oga: "M3 20.5h18M4.5 9.5h15M12 3.5 3.5 8.5h17zM6.5 9.5v8.5M10 9.5v8.5M14 9.5v8.5M17.5 9.5v8.5M4.5 18h15",
    health: "M12 3l7 3v5.2c0 4.6-3 8.3-7 9.8-4-1.5-7-5.2-7-9.8V6zM12 8.5v7M8.5 12h7",
  };

  const pin = (x, y, h, cls) => {
    const el = document.createElement("div");
    el.className = `ppin ${cls}`;
    const obj = new CSS2DObject(el);
    obj.position.copy(v3(x, y, h));
    obj.center.set(0.5, 1);
    scene.add(obj);
    const item = { el, obj, shown: false };
    plan.pins.push(item);
    return item;
  };
  const parkPin = pin(0, 0, 8, "prop");
  const closedPin = pin(0, 0, 8, "closed");
  const xrayPins = world.proposedXrays.map((g) => Object.assign(pin(g.x, g.y, 14, "prop xr"), { g }));
  /* From a distance the proposed scanners share one pin, above the x-ray station's own. */
  const xrayAll = world.proposedXrays.length ? pin(world.proposedXrays.reduce((s2, g) => s2 + g.x, 0) / world.proposedXrays.length, world.proposedXrays.reduce((s2, g) => s2 + g.y, 0) / world.proposedXrays.length, 85, "prop xr-all") : null;
  const xrayOffPin = data.xrays[1] ? pin(data.xrays[1].x, data.xrays[1].y, 13, "closed") : null;
  const shedPins = rampInfo ? rampInfo.categories.map((c) => Object.assign(pin(c.x, c.y, 13, "shed"), { c })) : [];
  /* A roof marking on each import shed: the category's line icon in a ring of its colour,
     painted flat on the roof like a helipad marking, so it reads from any height. */
  if (rampInfo) {
    const roofH = Math.max(...data.buildings.filter((b) => b.role === "ramp_shed").map((b) => b.h)) + 0.68;
    for (const c of rampInfo.categories) {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 256;
      const g = cv.getContext("2d");
      g.fillStyle = "rgba(24, 28, 34, 0.92)";
      g.beginPath();
      g.arc(128, 128, 120, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = plan.cats[c.id].color;
      g.lineWidth = 12;
      g.beginPath();
      g.arc(128, 128, 110, 0, Math.PI * 2);
      g.stroke();
      g.save();
      g.translate(128 - 72, 128 - 72);
      g.scale(6, 6);
      g.strokeStyle = "#f2efe8";
      g.lineWidth = 1.5;
      g.lineCap = g.lineJoin = "round";
      g.stroke(new Path2D(CAT_ICON[c.id]));
      g.restore();
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const size = c.bays > 40 ? 17 : 14;
      const emblem = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      emblem.rotation.x = -Math.PI / 2;
      emblem.position.copy(v3(c.x, c.y, roofH));
      emblem.renderOrder = 4;
      scene.add(emblem);
    }
  }
  const centroid = (list) => [list.reduce((s, q) => s + q.x, 0) / list.length, list.reduce((s, q) => s + q.y, 0) / list.length];
  const catName = (id) => (lang === "ar" ? plan.cats[id].ar : plan.cats[id].short || plan.cats[id].en);

  plan.state = null;
  plan.paint = () => {
    const st = plan.state;
    if (!st) return;
    const P = (en, ar) => (lang === "ar" ? ar : en);
    /* parking */
    const today = cfg.parking.default;
    const closed = new Set(st.parking < today ? closeOrderOf(today - st.parking) : []);
    world.mainStalls.forEach((_, i) => world.stallOverlays.main.set(i, closed.has(i) ? "#ff5d6c" : null));
    const open = Math.max(0, st.parking - today);
    world.proposedStalls.forEach((_, i) => world.stallOverlays.proposed.set(i, i < open ? "#5fe0d8" : null));
    world.yardCapacity = st.parking;
    parkPin.shown = open > 0;
    if (open > 0) {
      const [x, y] = centroid(world.proposedStalls.slice(0, open));
      parkPin.obj.position.copy(v3(x, y, 8));
      parkPin.el.innerHTML = `<b>+${open}</b> ${P("bays", "موقف")}<em>${P("proposed", "مقترح")}</em>`;
    }
    closedPin.shown = closed.size > 0;
    if (closed.size) {
      const [x, y] = centroid([...closed].map((i) => world.mainStalls[i]));
      closedPin.obj.position.copy(v3(x, y, 8));
      closedPin.el.innerHTML = `<b>−${closed.size}</b> ${P("bays", "موقف")}<em>${P("closed", "مغلق")}</em>`;
    }
    /* x-ray */
    const extra = st.xray - cfg.xray.default;
    xrayPins.forEach((p, i) => {
      const on = i < extra;
      p.g.group.visible = on;
      p.shown = on;
      p.el.innerHTML = `<b>${P("X-ray", "أشعة")} ${cfg.xray.default + i + 1}</b><em>${P("proposed", "مقترح")}</em>`;
    });
    if (xrayAll) {
      xrayAll.shown = extra > 0;
      xrayAll.el.innerHTML = `<b>+${extra}</b> ${P(extra === 1 ? "scanner" : "scanners", "أجهزة")}<em>${P("proposed", "مقترح")}</em>`;
    }
    if (xrayOffPin) {
      xrayOffPin.shown = st.xray < cfg.xray.default;
      xrayOffPin.el.innerHTML = `<b>${P("X-ray 2", "أشعة 2")}</b><em>${P("offline", "متوقف")}</em>`;
    }
    /* docks: contiguous blocks in allocation order, scaled onto the docks that exist */
    let k = 0;
    const phys = physAlloc(st);
    for (const cat of CAT_IDS) {
      for (let n = 0; n < phys[cat] && k < dockOrder.length; n += 1, k += 1) {
        const i = dockOrder[k];
        world.importBays[i].cat = cat;
        world.dockOverlay.set(i, plan.cats[cat].color);
      }
    }
    for (const p of shedPins) {
      const home = CAT_IDS.indexOf(p.c.id);
      const mine = world.importBays.filter((b) => b.home === home);
      const parts = CAT_IDS.map((c) => [c, mine.filter((b) => b.cat === c).length]).filter(([, n]) => n);
      p.shown = true;
      p.el.style.setProperty("--c", plan.cats[p.c.id].color);
      p.el.innerHTML = `<svg viewBox="0 0 24 24"><path d="${CAT_ICON[p.c.id]}"/></svg><span class="nm">${catName(p.c.id)}</span><span class="lvv"><b>${mine.length}</b></span>${
        parts.length > 1 ? `<span class="mixbar">${parts.map(([c, n]) => `<u style="flex:${n};background:${plan.cats[c].color}" title="${catName(c)} ${n}"></u>`).join("")}</span>` : ""
      }`;
    }
    plan.result = plan.planner && plan.planner.result ? plan.planner.result : pm.evaluate(st);
    syncSim(st);
    syncProps(st, plan.result);
    /* Docks per category in the scenario, and trucks queuing for them, on each shed's tag. */
    for (const p of shedPins) {
      const q = plan.result.cats[p.c.id];
      const tag = p.el.querySelector(".lvv");
      tag.innerHTML = `<b>${q.docks}</b>`;
      const waiting = (q.lamDay / 24) * q.wait;
      if (waiting >= 1) tag.insertAdjacentHTML("afterend", `<span class="wait">${Math.round(waiting)} ${P("waiting", "بالانتظار")}</span>`);
    }
    const extraDocks = st.docks - pm.today.docks;
    dockPin.shown = extraDocks !== 0;
    if (extraDocks) dockPin.el.innerHTML = `<b>${extraDocks > 0 ? "+" : "−"}${Math.abs(extraDocks)}</b> ${P("docks", "رصيف")}<em>${P(extraDocks > 0 ? "proposed" : "closed", extraDocks > 0 ? "مقترح" : "مغلق")}</em>`;
    dockPin.el.className = `ppin ${extraDocks > 0 ? "prop" : "closed"}`;
    applyVisibility();
  };
  const dockPin = rampInfo ? pin(rampInfo.categories[1].x + 40, rampInfo.categories[1].y - 30, 16, "prop") : { el: document.createElement("div"), obj: { visible: false, position: new THREE.Vector3() } };
  plan.planner = new Planner(pm, {
    lang: () => lang,
    onChange(state) {
      plan.state = state;
      if (!plan.ready) return;
      plan.paint();
      plan.syncHash();
      renderKpis();
      noteChange(state);
    },
    onVisualize(p) {
      plan.lastPlan = p;
      plan.goal = plan.planner.goal.target;
      if (!plan.open) setPlanner(true);
      /* the camera then visits each change the plan makes (noteChange) */
    },
  });
  plan.state = plan.planner.state;
  plan.planner.mount($("planner"));

  /* ---------- what changed: the camera visits each change and it glows ----------
     After any planner change (a slider, a goal-seek plan, a shared link) the camera flies to
     every place that changed, rings pulse on the ground there and a tag shows before → after. */
  const snap = (s) => JSON.parse(JSON.stringify(s));
  function changeSpots(a, b) {
    const out = [];
    const pct = (v) => `${Math.round(v)}%`;
    const yard = station("inbound", 4);
    const ramps = station("inbound", 6);
    if (b.xray !== a.xray) {
      const extra = b.xray - cfg.xray.default;
      const list = extra > 0 ? world.proposedXrays.slice(0, extra) : data.xrays;
      const [x, y] = centroid(list.length ? list : data.xrays);
      out.push({ x, y, r: 60, dist: 360, title: P2("X-ray lanes", "مسارات الأشعة"), from: a.xray, to: b.xray, up: b.xray > a.xray, pins: [xrayAll, xrayOffPin, ...xrayPins] });
    }
    if (b.parking !== a.parking) {
      const today = cfg.parking.default;
      const list = b.parking > today ? world.proposedStalls.slice(0, b.parking - today) : b.parking < today ? closeOrderOf(today - b.parking).map((i) => world.mainStalls[i]) : world.mainStalls;
      const [x, y] = centroid(list.length ? list : world.mainStalls);
      out.push({ x, y, r: 100, dist: 540, title: P2("Parking bays", "المواقف"), from: a.parking, to: b.parking, up: b.parking > a.parking, pins: [parkPin, closedPin] });
    }
    const split = (s) => CATS.map((c) => s.alloc[c]).join(" / ");
    if (b.docks !== a.docks || split(a) !== split(b)) {
      const [x, y] = rampInfo ? centroid(rampInfo.categories) : [ramps.x, ramps.y];
      const more = b.docks !== a.docks;
      const added = b.docks - a.docks;
      out.push({
        x, y, r: 120, dist: 520,
        title: more ? P2("Inspection docks", "أرصفة التفتيش") : P2("Docks per goods type", "الأرصفة لكل فئة"),
        from: more ? a.docks : split(a), to: more ? b.docks : split(b), up: b.docks >= a.docks, pins: [dockPin, ...shedPins],
        note: added > 0 ? P2("New docks in pink", "الأرصفة الجديدة بالوردي") : "",
        /* paint the share of docks the plan adds in pink while the camera is there */
        highlight: added > 0 ? () => {
          const n = Math.max(1, Math.round((dockOrder.length * added) / b.docks));
          const list = dockOrder.slice(-n);
          for (const i of list) world.dockOverlay.set(i, NEW_DOCK);
          return () => list.forEach((i) => world.dockOverlay.set(i, plan.cats[world.importBays[i].cat]?.color || null));
        } : null,
      });
    }
    /* Parking size unchanged but the plan empties the yard faster: show its peak use. Only
       alongside a lever change, so a traffic change alone does not start a tour. */
    if (out.length && b.parking === a.parking) {
      const ua = Math.min(1, pm.evaluate(a).util.parking);
      const ub = Math.min(1, pm.evaluate(b).util.parking);
      if (Math.abs(ua - ub) >= 0.1) out.push({ x: yard.x, y: yard.y, r: 110, dist: 560, title: P2("Main parking at peak", "المواقف الرئيسية وقت الذروة"), from: pct(ua * 100), to: pct(ub * 100), up: ub < ua, pins: [], note: ub < ua ? P2("Trucks leave the yard sooner", "الشاحنات تغادر أسرع") : "" });
    }
    if (b.prefile !== a.prefile) out.push({ x: yard.x, y: yard.y, r: 110, dist: 520, title: P2("Declarations filed before arrival", "بيانات مقدمة قبل الوصول"), from: pct(a.prefile), to: pct(b.prefile), up: b.prefile > a.prefile, process: true });
    if (b.green !== a.green) out.push({ x: ramps.x, y: ramps.y, r: 110, dist: 480, title: P2("Green channel", "المسار الأخضر"), from: pct(a.green), to: pct(b.green), up: b.green > a.green, process: true });
    if (!!b.overlap !== !!a.overlap) out.push({ x: ramps.x + 40, y: ramps.y - 30, r: 110, dist: 480, title: P2("Shift handovers", "تسليم المناوبات"), from: a.overlap ? P2("overlapped", "متداخلة") : P2("gap", "فجوة"), to: b.overlap ? P2("overlapped", "متداخلة") : P2("gap", "فجوة"), up: !!b.overlap, process: true });
    return out;
  }
  function P2(en, ar) {
    return lang === "ar" ? ar : en;
  }
  const ringGeo = new THREE.RingGeometry(0.86, 1, 72);
  ringGeo.rotateX(-Math.PI / 2);
  const rings = [];
  const chgEl = document.createElement("div");
  chgEl.className = "chg-tag";
  const chgObj = new CSS2DObject(chgEl);
  chgObj.center.set(0.5, 1);
  chgObj.visible = false;
  scene.add(chgObj);
  let chgHide = 0;
  /* how long the camera rests on each change, and how long the flight to it takes */
  const CHG_DWELL = 7;
  const CHG_FLY = 3.6;
  const NEW_DOCK = "#ff4fd8";
  function addRings(s, color, life, pulse = false) {
    for (let k = 0; k < 3; k += 1) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
      m.position.copy(v3(s.x, s.y, 1.5));
      m.renderOrder = 7;
      scene.add(m);
      rings.push({ m, r: s.r, t: -k * 0.55, life, pulse });
    }
  }
  function flashSpot(s, step) {
    const color = s.process ? "#f2c14e" : s.up ? "#5fe0d8" : "#ff5d6c";
    addRings(s, color, CHG_DWELL);
    const undo = s.highlight && s.highlight();
    if (undo) setTimeout(undo, CHG_DWELL * 1000);
    chgEl.innerHTML = `<div class="chg-in ${s.process ? "proc" : s.up ? "up" : "down"}">${step ? `<small>${step}</small>` : ""}<b>${s.title}</b><span>${s.from}<i>→</i><em>${s.to}</em></span>${s.note ? `<small class="note">${s.note}</small>` : ""}</div>`;
    chgObj.position.copy(v3(s.x, s.y, s.r * 0.35 + 12));
    chgObj.visible = true;
    clearTimeout(chgHide);
    chgHide = setTimeout(() => (chgObj.visible = false), CHG_DWELL * 1000);
    for (const p of s.pins || []) {
      if (!p || !p.el) continue;
      p.el.classList.remove("flash");
      void p.el.offsetWidth;
      p.el.classList.add("flash");
      setTimeout(() => p.el.classList.remove("flash"), CHG_DWELL * 1000);
    }
  }
  function stepRings(dt) {
    for (let i = rings.length - 1; i >= 0; i -= 1) {
      const g = rings[i];
      g.t += dt;
      g.life -= dt;
      if (g.life <= 0) {
        scene.remove(g.m);
        g.m.material.dispose();
        rings.splice(i, 1);
        continue;
      }
      const f = g.t < 0 ? 0 : (g.t % 1.65) / 1.65;
      const s = g.r * (0.35 + 0.9 * f);
      g.m.scale.set(s, 1, s);
      g.m.material.opacity = g.t < 0 ? 0 : (1 - f) * 0.95 * Math.min(1, g.life / 1.2);
    }
  }
  /* Red pulses with a tag on each bottleneck, all at once (the demo's "where it breaks"). */
  const pulseTags = [];
  function pulseSpots(list) {
    clearPulses();
    for (const s of list) {
      addRings(s, "#ff4d5e", 3600, true);
      const el = document.createElement("div");
      el.className = "pulse-tag";
      el.innerHTML = `<div class="chg-in down"><b>${s.title}</b><span>${s.value}</span></div>`;
      const o = new CSS2DObject(el);
      o.center.set(0.5, 1);
      o.position.copy(v3(s.x, s.y, s.z ?? 70));
      scene.add(o);
      pulseTags.push(o);
    }
  }
  function clearPulses() {
    for (const g of rings) if (g.pulse) g.life = Math.min(g.life, 1.2);
    for (const o of pulseTags) {
      scene.remove(o);
      o.element.remove();
    }
    pulseTags.length = 0;
  }
  function bottleneckSpots(r) {
    const yard = station("inbound", 4);
    const [rx, ry] = rampInfo ? centroid(rampInfo.categories) : [station("inbound", 6).x, station("inbound", 6).y];
    const [xx, xy] = centroid(data.xrays);
    const full = Math.round(Math.min(1, r.util.parking) * 100);
    const d = (m) => (lang === "ar" ? (m >= 90 ? `${(m / 60).toFixed(1)} ساعة` : `${Math.round(m)} دقيقة`) : dur(m));
    const out = Math.round(r.overflow);
    return [
      { x: yard.x, y: yard.y, r: 230, title: P2("Main parking", "المواقف الرئيسية"), value: P2(`${full}% full at peak${out >= 1 ? ` · ${out} wait outside` : ""}`, `ممتلئة ${full}% وقت الذروة${out >= 1 ? ` · ${out} تنتظر خارجًا` : ""}`) },
      { x: xx, y: xy, r: 150, title: P2("X-ray queue", "طابور الأشعة"), value: d(r.stages.xq.median) },
      { x: rx, y: ry, r: 200, title: P2("Wait for inspection", "انتظار التفتيش"), value: d(r.stages.iq.median) },
    ];
  }
  let changeTour = null;
  function showChanges(spots) {
    stopTour();
    if (followed) stopFollow();
    cancelChanges();
    changeTour = { spots, i: -1, timer: 0 };
    nextChange();
  }
  function nextChange() {
    const ct = changeTour;
    if (!ct) return;
    ct.i += 1;
    const s = ct.spots[ct.i];
    if (!s) {
      changeTour = null;
      return;
    }
    flyTo(camPose(s.x, s.y, s.dist, 57, 128 + ct.i * 22), CHG_FLY);
    flight.then = () => {
      if (changeTour !== ct) return;
      flashSpot(s, ct.spots.length > 1 ? `Change ${ct.i + 1} of ${ct.spots.length}` : "");
      ct.timer = setTimeout(nextChange, CHG_DWELL * 1000);
    };
  }
  function cancelChanges() {
    if (changeTour) clearTimeout(changeTour.timer);
    changeTour = null;
  }
  let focusTimer = 0;
  function noteChange(st) {
    if (!plan.seen) plan.seen = snap(pm.today);
    clearTimeout(focusTimer);
    if (plan.quiet) {
      plan.quiet = false;
      plan.seen = snap(st);
      return;
    }
    focusTimer = setTimeout(() => {
      const spots = changeSpots(plan.seen, plan.state);
      plan.seen = snap(plan.state);
      if (spots.length) showChanges(spots);
    }, 600);
  }
  /* seconds the camera needs to visit every change from the last one shown to state s */
  plan.changeTime = (s) => changeSpots(plan.seen || pm.today, s).length * (CHG_DWELL + CHG_FLY + 0.4);
  /* A scenario lives in the address (#plan=…), so it can be shared or reopened as a link. */
  const encodePlan = (s) => `s${s.surge}.p${s.parking}.x${s.xray}.d${s.docks}.a${CATS.map((c) => s.alloc[c]).join("-")}.f${s.prefile}.g${s.green}.o${s.overlap}`;
  const decodePlan = (text) => {
    const out = {};
    for (const part of text.split(".")) {
      const k = part[0];
      const v = part.slice(1);
      const key = { s: "surge", p: "parking", x: "xray", d: "docks", f: "prefile", g: "green", o: "overlap" }[k];
      if (key) out[key] = Number(v);
      if (k === "a") {
        const [a, b, c] = v.split("-").map(Number);
        out.alloc = { chem: a, oga: b, health: c };
      }
    }
    return out;
  };
  plan.planner.onShare = () => location.href;
  plan.syncHash = () => {
    const url = plan.planner.changed() ? `#plan=${encodePlan(plan.state)}` : " ";
    window.history.replaceState(null, "", url === " " ? location.pathname + location.search : url);
  };
  function setPlanner(on) {
    plan.open = on;
    plan.planner.open = on;
    $("planner").classList.toggle("open", on);
    $("plan-btn").classList.toggle("on", on);
    document.body.classList.toggle("planner-on", on);
    if (on) {
      setExec(false);
      stopTour();
      stopFollow();
      if (activeFlow !== "inbound") setFlow("inbound");
      flyTo(camPose(-120, -150, 1450, 54, 150));
    }
    applyVisibility();
  }
  $("plan-btn").addEventListener("click", () => setPlanner(!plan.open));

  /* ---------- dashboard and presentation mode ---------- */
  let showDash = params.get("dash") !== "0";
  const applyDash = () => {
    $("dash").classList.toggle("hidden", !showDash);
    $("toggle-dash").classList.toggle("on", showDash);
  };
  /* Both side panels slide off their edge and leave a small tab to bring them back. */
  $("dash-tuck").addEventListener("click", () => $("dash").classList.toggle("tucked"));
  $("toggle-dash").addEventListener("click", () => {
    showDash = !showDash;
    applyDash();
  });
  /* The executive overview covers the scene; station rows and events on it lead back into 3D. */
  exec.mount({
    tr,
    lang: () => lang,
    hhmm: (c) => hhmm(c),
    clockOf: (t) => sim.clock0 + t,
    flowName: (flow) => (FLOWS[flow] || FLOWS.inbound)[lang][0],
    stations: (k, live) => stationObjects.map(({ st }, index) => ({ index, flow: st.flow, n: st.shown, tone: st.tone, name: stationName(st), title: lang === "ar" ? st.ar : st.en, value: stationLive(st, k, live) })),
    learned,
    cats: plan.cats,
    scenarioChanged: () => plan.planner.changed(),
    scenarioLabel: () => scenarioLabel(plan.state),
    onStation(index) {
      setExec(false);
      focusStation(index);
    },
    onVehicle(v) {
      if (!sim.vehicles.includes(v)) return;
      setExec(false);
      select(v);
    },
  });
  function scenarioLabel(st) {
    const t = pm.today;
    const parts = [];
    if (st.surge) parts.push(`+${st.surge}% trucks`);
    if (st.xray !== t.xray) parts.push(`${st.xray} X-ray lanes`);
    if (st.docks !== t.docks) parts.push(`${st.docks} docks`);
    else if (CATS.some((c) => st.alloc[c] !== t.alloc[c])) parts.push("docks re-split");
    if (st.parking !== t.parking) parts.push(`${st.parking} bays`);
    if (st.prefile) parts.push(`${st.prefile}% pre-filed`);
    if (st.green) parts.push(`${st.green}% green channel`);
    if (st.overlap) parts.push("shift overlap");
    return parts.join(" · ");
  }
  function setExec(on) {
    exec.setOpen(on);
    document.body.classList.toggle("exec-on", on);
    $("exec-btn").classList.toggle("on", on);
    if (on) renderKpis();
  }
  $("exec-btn").addEventListener("click", () => setExec(!exec.open));
  $("dash-more").addEventListener("click", () => setExec(true));
  $("exec-close").addEventListener("click", () => setExec(false));
  $("exec-back").addEventListener("click", () => setExec(false));
  const togglePresent = (on = !document.body.classList.contains("present")) => document.body.classList.toggle("present", on);
  $("present").addEventListener("click", () => togglePresent());
  if (params.get("present") === "1") togglePresent(true);

  /* ---------- time controls ---------- */
  let speed = Number(params.get("speed") || 20);
  let paused = false;
  document.querySelectorAll("[data-speed]").forEach((el) => {
    el.classList.toggle("on", Number(el.dataset.speed) === speed);
    el.addEventListener("click", () => {
      speed = Number(el.dataset.speed);
      document.querySelectorAll("[data-speed]").forEach((b) => b.classList.toggle("on", b === el));
    });
  });
  const togglePause = () => {
    paused = !paused;
    $("play").classList.toggle("paused", paused);
    document.body.classList.toggle("paused-all", paused);
  };
  $("play").addEventListener("click", togglePause);
  document.querySelectorAll("[data-light]").forEach((el) => el.addEventListener("click", () => applyLighting(el.dataset.light)));
  document.querySelectorAll("[data-view]").forEach((el) =>
    el.addEventListener("click", () => {
      stopTour();
      stopFollow();
      flyTo(VIEWS[el.dataset.view]());
      document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b === el));
    })
  );
  controls.addEventListener("start", () => {
    idle = 0;
    chase = false;
    if (!flight) document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("on"));
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "d") $("toggle-dash").click();
    else if (k === "e") setExec(!exec.open);
    else if (k === "c") setPlanner(!plan.open);
    else if (k === "p") togglePresent();
    else if (k === "escape") {
      if (exec.open) return setExec(false);
      if (plan.open) return setPlanner(false);
      togglePresent(false);
      stopFollow();
    } else if (k === " ") {
      e.preventDefault();
      togglePause();
    } else if (k === "l") $("toggle-labels").click();
    else if (k === "t") $("tour").click();
    else if (k === "f") $("follow").click();
    else if (k === "n") applyLighting({ day: "sunset", sunset: "night", night: "day" }[lighting]);
    else if (k === "1" || k === "2" || k === "3") document.querySelectorAll("[data-flow]")[Number(k) - 1].click();
  });

  /* ---------- tour ---------- */
  let tour = null;
  function startTour() {
    stopFollow();
    const order = stationObjects.map((s, i) => i).filter((i) => stationObjects[i].st.flow === activeFlow && stationObjects[i].st.n !== "+");
    tour = { order, k: -1, hold: 0 };
    $("tour").classList.add("on");
    nextTourStop();
  }
  function nextTourStop() {
    tour.k = (tour.k + 1) % tour.order.length;
    const index = tour.order[tour.k];
    const { st } = stationObjects[index];
    flyTo(camPose(st.x, st.y, focusDistance(st) * 0.9, 64, 100 + (tour.k % 4) * 28), 2.6);
    tour.hold = 6;
    highlightStep(index);
  }
  function stopTour() {
    if (!tour) return;
    tour = null;
    $("tour").classList.remove("on");
  }
  $("tour").addEventListener("click", () => (tour ? stopTour() : startTour()));

  /* ---------- demo: the WASL story played with the twin's own features ---------- */
  let demoSpeed = 0;
  let demoCfg = null;
  const demo = createDemo({
    pm,
    /* true while the camera is still moving, so the story waits before counting down */
    moving: () => !!flight,
    lang: () => lang,
    prepare() {
      demoCfg = pm.cfg;
      pm.cfg = cfgDefault;
      stopTour();
      stopFollow();
      setExec(false);
      if (activeFlow !== "inbound") setFlow("inbound");
      showDash = true;
      applyDash();
      $("dash").classList.remove("tucked");
      $("planner").classList.remove("tucked");
      $("demo-btn").classList.add("on");
      /* the story plays the simulation at 5x so trucks can be followed by eye */
      demoSpeed = speed;
      document.querySelector('[data-speed="5"]')?.click();
    },
    finish() {
      setExec(false);
      clearPulses();
      if (demoCfg) pm.cfg = demoCfg;
      demoCfg = null;
      if (demoSpeed) document.querySelector(`[data-speed="${demoSpeed}"]`)?.click();
      demoSpeed = 0;
      $("demo-btn").classList.remove("on");
    },
    reset() {
      plan.quiet = true;
      demoScenario({ ...pm.today });
      setPlanner(false);
    },
    view(name) {
      stopFollow();
      cancelChanges();
      flyTo(VIEWS[name](), 4.5);
      document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
    },
    followTruck() {
      $("follow").click();
      return followed;
    },
    stopFollow,
    setScenario: (s) => demoScenario(s),
    /* fly to one inspection shed and pulse it, with a tag */
    focusShed(id, title, value) {
      stopFollow();
      cancelChanges();
      const c = rampInfo && rampInfo.categories.find((x) => x.id === id);
      if (!c) return;
      flyTo(camPose(c.x, c.y, 260, 60, 128), 4.5);
      document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("on"));
      pulseSpots([{ x: c.x, y: c.y, r: 60, z: 16, title, value }]);
    },
    pulseBottlenecks(r) {
      pulseSpots(bottleneckSpots(r));
    },
    clearPulses,
    async goalSeek(target, physical = false) {
      setPlanner(true);
      const pl = plan.planner;
      pl.goal.physical = physical;
      pl.goal.target = target;
      pl.goal.metric = "median";
      pl.goal.year = 2026;
      pl.setTab("goal");
      const box = $("gs-target");
      if (box) box.value = target;
      await pl.runGoal();
      pl.goal.physical = false;
      return pl.goal.result;
    },
    /* Loads the plan; the camera then visits each change. Returns the seconds that takes. */
    applyPlan(p) {
      const pl = plan.planner;
      pl.load({ ...p.s, surge: pl.state.surge });
      pl.setTab("whatif");
      const secs = plan.changeTime(pl.state);
      pl.onChange(pl.state);
      plan.goal = pl.goal.target;
      return secs;
    },
    exec(on) {
      if (on) setPlanner(false);
      setExec(on);
    },
  });
  function demoScenario(s) {
    const pl = plan.planner;
    pl.load(s);
    pl.onChange(pl.state);
  }
  $("demo-btn").addEventListener("click", () => (demo.running ? demo.stop() : demo.start()));
  /* phone buttons press the same controls as the full view */
  document.querySelectorAll("#m-panel [data-m]").forEach((b) => b.addEventListener("click", () => $(b.dataset.m).click()));
  controls.addEventListener("start", () => {
    if (!flight) {
      stopTour();
      cancelChanges();
    }
  });

  /* ---------- vehicle picking and ride-along ---------- */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
  let chase = false;
  labels.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  labels.domElement.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const meshes = fleet.pickables();
    meshes.forEach((m) => (m.boundingSphere = null));
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return;
    const v = fleet.ownerOf(hit.object, hit.instanceId);
    if (v) select(v);
  });
  /* The camera rides behind and above the vehicle, looking along its heading. */
  /* A truck backed onto an inspection dock has the shed behind it, so the camera swings round
     to the apron side and looks at it from the front instead. */
  const chaseOffset = (v, back = 50, up = 17) => {
    const side = v.bayT > 0 ? -0.9 : 1;
    return new THREE.Vector3(-v.dx * back * side, v.bayT > 0 ? up + 7 : up, v.dy * back * side);
  };
  function select(v) {
    stopTour();
    followed = v;
    $("vehicle").classList.add("open");
    const p = v3(v.x, v.y, 1.5);
    if (v.static) {
      trace.hide();
      chase = false;
      flyTo({ target: p, position: p.clone().add(chaseOffset(v, -34, 17)) }, 1.8);
    } else {
      trace.show(v.route);
      const pose = { target: p, position: p.clone().add(chaseOffset(v)) };
      flyTo(pose, 2.0);
      flight.lift = 0.04;
      flight.then = () => (chase = true);
    }
    renderCard();
  }
  function stopFollow() {
    followed = null;
    chase = false;
    truckTag.visible = false;
    trace.hide();
    $("vehicle").classList.remove("open");
  }
  $("vehicle-close").addEventListener("click", stopFollow);
  $("follow").addEventListener("click", () => {
    const flowOf = { inbound: "inbound", outbound: "outbound" };
    const moving = sim.vehicles.filter((v) => v.type === "truck" && v.state === "drive" && Math.hypot(v.x, v.y) < 1500 && v.speed > 2 && (!flowOf[activeFlow] || v.route.flow === activeFlow));
    /* Prefer a truck that still has most of the process ahead of it. */
    const early = moving.filter((v) => v.stopIdx <= 2 && v !== followed);
    const candidates = early.length ? early : moving;
    if (candidates.length) select(pick(candidates));
  });
  /* The ride-along card: who the truck is (plate in its country's format, origin, category from
     its goods) and the journey the learned model expects for it under the current scenario. */
  const STAGE_SHORT = { decl: "Waiting for declaration", xq: "X-ray queue and scan", iq: "Waiting for inspection", insp: "Physical inspection", exit: "Release to gate exit" };
  const STAGE_TAG = { decl: "Declaration", xq: "X-ray", iq: "Wait for dock", insp: "Inspection", exit: "Release" };
  const dur = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
  /* A tag above the followed truck: how long it stays at each stage. */
  const truckTagEl = document.createElement("div");
  truckTagEl.className = "truck-tag";
  const truckTag = new CSS2DObject(truckTagEl);
  truckTag.center.set(0.5, 1);
  truckTag.visible = false;
  scene.add(truckTag);
  function paintTruckTag(v) {
    const p = v && v.profile;
    const j = p && (v.static || (v.route && v.route.flow === "inbound")) ? pm.journey(p, plan.result || pm.baseRun) : null;
    truckTag.visible = !!j;
    if (!j) return;
    const keys = ["decl", "xq", "iq", "insp", "exit"].filter((k) => k !== "xq" || p.x);
    const top = keys.reduce((a, k) => (j[k] > j[a] ? k : a), keys[0]);
    truckTagEl.innerHTML = `<b>${fmtH(j.total / 60)} <small>in port</small></b>${keys.map((k) => `<span class="${k === top ? "top" : ""}">${STAGE_TAG[k]}<em>${dur(j[k])}</em></span>`).join("")}`;
  }
  function plateHTML(v) {
    const p = v.plateInfo;
    if (!p) return `<div class="vc-plate">${v.plate}</div>`;
    const c = COUNTRY[p.country] || COUNTRY.XX;
    return `<div class="vc-plate pl-${p.country}" title="${c.en} plate · ${p.rule}"><span class="cc">${c.code}${p.emirate ? ` · ${p.emirate}` : ""}</span><b>${p.text}</b>${p.ar && p.ar !== p.text ? `<i>${p.ar}</i>` : ""}</div>`;
  }
  function journeyHTML(v) {
    const p = v.profile;
    if (!p) return "";
    const r = plan.result || pm.baseRun;
    const j = pm.journey(p, r);
    if (!j) return "";
    const t0 = v.clockIn ?? (p.h * 3600 + 15 * 60);
    let at = t0 + j.gate * 60;
    const rows = [];
    for (const k of ["decl", "xq", "iq", "insp", "exit"]) {
      if (k === "xq" && !p.x) continue;
      at += j[k] * 60;
      rows.push(`<li><span>${STAGE_SHORT[k]}</span><em>${dur(j[k])}</em><b>${hhmm(at)}</b></li>`);
    }
    const risk = Math.round((p.r || 0) * 100);
    const lv = risk >= 50 ? "l2" : risk >= 30 ? "l1" : "l0";
    return `<div class="vc-sec"><div class="vc-h">Time at each stage <em>learned model${plan.planner.changed() ? " · scenario" : ""}</em></div>
      <ol class="vc-j">${rows.join("")}</ol>
      <div class="vc-total">Time in port <b>${fmtH(j.total / 60)}</b> · port median ${fmtH(r.median)}</div>
      <div class="vc-risk ${lv}"><span>Delay risk (over 8 h)</span><b>${risk}%</b></div></div>`;
  }
  function renderCard() {
    const v = followed;
    paintTruckTag(v);
    if (!v) return;
    const catRow = v.cat && plan.cats[v.cat] ? `<dt>Category</dt><dd><span class="vc-cat" style="--c:${plan.cats[v.cat].color}">${plan.cats[v.cat].en}</span></dd>` : "";
    const p = v.profile;
    const facts = p
      ? `<dt>Declarations</dt><dd>${p.n}${p.sh ? " · shared with other trucks" : ""}</dd><dt>Arrived</dt><dd>${String(p.h).padStart(2, "0")}:00 band${p.night ? " · night" : ""}</dd><dt>X-ray</dt><dd>${p.x ? "Selected" : "Not selected"}</dd>`
      : "";
    const country = v.country ? COUNTRY[v.country] : null;
    if (v.static) {
      $("vehicle-body").innerHTML = `
        <div class="vc-title">Truck <span class="tag">${v.where === "yard" ? "Parked" : v.where === "queue" ? "X-ray queue" : "At ramp"}</span></div>
        ${plateHTML(v)}
        <dl>${country ? `<dt>Plate</dt><dd>${country.en}</dd>` : ""}${catRow}<dt>Cargo</dt><dd>${v.cargo}</dd><dt>Status</dt><dd>${v.where === "yard" ? "Waiting for declaration or inspection" : v.where === "queue" ? "Queuing for X-ray" : "Physical inspection"}</dd>${facts}</dl>
        ${journeyHTML(v)}`;
      return;
    }
    const d = sim.describe(v);
    const steps = d.plan.map((q) => `<li class="${q.state}" title="${q.label}"></li>`).join("");
    const now = d.plan.find((q) => q.state === "now");
    const inspect = v.type === "truck" && v.route.stops.some((st) => st.kind === "ramp");
    const channel = v.type === "truck" ? `<span class="vc-chan ${inspect ? "red" : "green"}">${inspect ? "Red channel · inspection" : "Green channel"}</span>` : "";
    $("vehicle-body").innerHTML = `
      <div class="vc-title">${d.title} <span class="tag">${d.speed} km/h</span></div>
      ${plateHTML(v)}${channel}
      <dl>
        <dt>Route</dt><dd>${d.origin}${country && v.type === "truck" ? ` · ${country.en} plate` : ""}</dd>
        ${d.declaration ? `<dt>Declaration</dt><dd>${d.declaration}</dd>` : ""}
        ${d.cargo ? `<dt>Cargo</dt><dd>${d.cargo}</dd>` : ""}
        ${catRow}${facts}
        <dt>Status</dt><dd>${d.status}</dd>
      </dl>
      <ol class="plan">${steps}</ol>
      <div class="plan-now">${now ? `Next · <b>${now.label}</b>` : "<b>Leaving the port</b>"}</div>
      ${v.route.flow === "inbound" ? journeyHTML(v) : ""}`;
  }

  /* ---------- live activity feed ---------- */
  const EVENT_KEY = { release: "eRelease", xray: "eXray", ramp: "eRamp", gate: "eGate" };
  const hhmm = (c) => `${String(Math.floor(c / 3600) % 24).padStart(2, "0")}:${String(Math.floor(c / 60) % 60).padStart(2, "0")}`;
  function renderFeed() {
    feedDirty = false;
    const host = $("feed");
    host.innerHTML = "";
    feed.forEach((item, i) => {
      const li = document.createElement("li");
      if (i === 0 && item.fresh) li.className = "new";
      item.fresh = false;
      li.innerHTML = `<time>${hhmm(item.clock)}</time><span><b>${tr(EVENT_KEY[item.kind])}</b> · ${item.plate}</span>`;
      li.addEventListener("click", () => {
        if (sim.vehicles.includes(item.v)) select(item.v);
      });
      host.appendChild(li);
    });
  }

  /* ---------- dashboard metrics ---------- */
  const history = seedHistory.slice(-24);
  let sampleTimer = 0;
  function renderSpark() {
    if (history.length < 2) return;
    const lo = Math.min(...history) - 2;
    const hi = Math.max(...history) + 2;
    const pts = history.map((v, i) => [(i / (history.length - 1)) * 240, 42 - ((v - lo) / (hi - lo)) * 38]);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
    $("spark").querySelector(".line").setAttribute("d", line);
    $("spark").querySelector(".area").setAttribute("d", `${line}L240,44L0,44Z`);
    const back = history[Math.max(0, history.length - 16)];
    const diff = history[history.length - 1] - back;
    const el = $("k-trend");
    el.textContent = diff === 0 ? "steady" : `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)}`;
    el.className = `delta ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`;
  }
  function renderKpis(dt = 0) {
    const k = sim.kpis(mainParked(), world.yardCapacity, rampStaticCount());
    $("k-trucks").textContent = k.trucksIn;
    const pct = k.yard / Math.max(1, k.yardCapacity);
    $("k-yard").textContent = k.yard;
    $("k-yard-cap").textContent = k.yardCapacity;
    $("k-park-pct").textContent = `${Math.round(pct * 100)}%`;
    const ring = $("g-park");
    ring.style.strokeDashoffset = `${169.6 * (1 - Math.min(1, pct))}`;
    ring.style.stroke = pct < 0.75 ? "var(--green)" : pct < 0.9 ? "var(--gold)" : "#e0607e";
    $("k-scans").textContent = k.scansPerHour;
    /* Port KPIs from the learned model under the current scenario, against today. */
    const r = plan.result || pm.baseRun;
    const b0 = pm.baseRun;
    const changed = plan.planner.changed();
    $("dash-badge").textContent = changed ? "Scenario" : "Today";
    $("dash-badge").classList.toggle("on", changed);
    $("k-stay").textContent = r.median.toFixed(1);
    if (mobile) {
      $("m-stay").textContent = r.median.toFixed(1);
      $("m-day").textContent = Math.round(r.lamDay).toLocaleString("en-US");
      $("m-park").textContent = `${Math.round(pct * 100)}%`;
    }
    const dStay = r.median - b0.median;
    $("k-stay-d").textContent = changed && Math.abs(dStay) >= 0.05 ? `${dStay > 0 ? "▲" : "▼"} ${Math.abs(dStay).toFixed(1)} h` : "";
    $("k-stay-d").className = `delta ${dStay < -0.04 ? "good" : dStay > 0.04 ? "bad" : ""}`;
    $("k-stay-sub").innerHTML = `${changed ? `today ${b0.median.toFixed(1)} h · ` : ""}P90 ${fmtH(r.p90)} · ${Math.round(r.over12)}% over 12 h`;
    const flag = (id, now, then, fmt, lowerBetter = true) => {
      const el = $(id);
      el.textContent = fmt(now);
      el.className = changed && fmt(now) !== fmt(then) ? ((lowerBetter ? now < then : now > then) ? "good" : "bad") : "";
      el.title = changed ? `today ${fmt(then)}` : "";
    };
    const mm = (m) => (m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
    flag("k-perday", r.lamDay, b0.lamDay, (v) => Math.round(v).toLocaleString(), false);
    flag("k-cap", r.capacity, b0.capacity, (v) => Math.round(v).toLocaleString(), false);
    flag("k-decl", r.stages.decl.median, b0.stages.decl.median, mm);
    flag("k-iq", r.stages.iq.median, b0.stages.iq.median, mm);
    const bnKey = `${r.bottleneck.stage}|${Math.round(r.bottleneck.share)}|${r.bottleneck.pattern.map((q) => q.key).join()}`;
    if ($("k-bn").__k !== bnKey) {
      $("k-bn").__k = bnKey;
      $("k-bn").innerHTML = bottleneckHTML(r, lang);
    }
    $("k-ramps").textContent = k.inspections;
    $("k-pass").textContent = k.passengers.toLocaleString();
    $("k-booths").textContent = `${k.boothsBusy}/${k.booths}`;
    $("k-cars").textContent = k.vehicles;
    $("k-released").textContent = k.released;
    $("clock").textContent = hhmm(sim.clock);

    const live = sim.live();
    for (const s of stationObjects) {
      if (s.st.flow !== activeFlow) continue;
      const value = stationLive(s.st, k, live);
      const key = value ? value.join("|") + lang : "";
      if (key === s.shown) continue;
      s.shown = key;
      const html = liveHtml(value);
      const cls = `lv${value && value[2] ? ` l${value[2]}` : ""}`;
      for (const el of [s.lv, s.railLv]) {
        if (!el) continue;
        el.innerHTML = html;
        el.className = cls;
      }
    }
    if (feedDirty) renderFeed();
    if (sim.time - exec.lastT >= SAMPLE_STEP) exec.sample(sim.time, k);
    if (exec.open) {
      exec.setScenario(plan.result || pm.baseRun, pm.baseRun, plan.goal);
      exec.render(k, live);
    }
    if (plan.open) plan.planner.live(sim.stats);

    sampleTimer -= dt;
    if (sampleTimer <= 0 || history.length === 0) {
      history.push(k.trucksIn);
      if (history.length > 48) history.shift();
      sampleTimer = 2.5;
      renderSpark();
    }
  }
  applyLanguage();
  setFlow(activeFlow);
  applyDash();
  plan.ready = true;
  {
    const m = /#plan=([^&]+)/.exec(location.hash);
    if (m) {
      plan.planner.load(decodePlan(decodeURIComponent(m[1])));
      setPlanner(true);
    }
  }
  plan.paint();

  /* ---------- resize and loop ---------- */
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    pixelRatio = fitRatio();
    renderer.setPixelRatio(pixelRatio);
    composer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h);
    composer.setSize(w, h);
    sizeBloom();
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  applyLighting(lighting, true);
  const startView = params.get("view");
  /* ?cam=x,y,distance,polar,bearing frames an exact shot (deep links, screenshots). */
  const camParam = (params.get("cam") || "").split(",").map(Number);
  const camShot = camParam.length === 5 && camParam.every(Number.isFinite) ? camPose(...camParam) : null;
  const execStart = params.get("exec") === "1";
  const intro = params.get("intro") !== "0" && !startView && !camShot && !execStart;
  const initial = camShot || (startView && VIEWS[startView] ? VIEWS[startView]() : VIEWS.overview());
  /* Open high over the desert and descend into the port while the title holds. The opening is
     timed in rendered seconds and starts only once the first frames are on screen, so shader
     compilation on a slow machine cannot swallow it. */
  let opening = null;
  if (intro) {
    const far = camPose(-300, 300, 6400, 52, 205);
    camera.position.copy(far.position);
    controls.target.copy(far.target);
    document.body.classList.add("intro-on");
  } else {
    camera.position.copy(initial.position);
    controls.target.copy(initial.target);
  }
  controls.update();
  idle = 1e3;
  function reveal() {
    $("loader").classList.add("done");
    setTimeout(() => $("loader").remove(), 900);
    if (execStart) setExec(true);
    if (!intro) return;
    $("intro").classList.add("show");
    flyTo(initial, 8);
    flight.lift = 0;
    opening = { t: 0 };
  }
  function stepOpening(dt) {
    if (!opening) return;
    opening.t += dt;
    if (opening.t > 3.8) $("intro").classList.remove("show");
    if (opening.t > 5.6) {
      document.body.classList.remove("intro-on");
      opening = null;
    }
  }

  const markerGeo = new THREE.RingGeometry(10.4, 10.9, 72);
  markerGeo.rotateX(-Math.PI / 2);
  const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffd27a").multiplyScalar(1.25), toneMapped: false, transparent: true, opacity: 0.85, depthWrite: false }));
  marker.renderOrder = 6;
  marker.visible = false;
  scene.add(marker);

  const clock = new THREE.Clock();
  let kpiTimer = 0;
  let elapsed = 0;
  let slowFrames = 0;
  let frames = 0;
  const lastTarget = new THREE.Vector3();
  const want = new THREE.Vector3();
  function frame() {
    const raw = clock.getDelta();
    const dt = Math.min(0.05, raw);
    elapsed += dt;
    if (!paused) sim.advance(dt * speed);
    sim.render();
    fleet.commit();
    world.update(elapsed, dt, sim);
    inspectors.update(elapsed);
    flows.uniforms.uTime.value = elapsed;
    zones.uniforms.uTime.value = elapsed;
    beacons.shared.uTime.value = elapsed;
    trace.uniforms.uTime.value = elapsed;
    if (ground) ground.uniforms.uTime.value = elapsed;

    marker.visible = !!followed;
    if (followed) {
      marker.position.set(followed.x, 0.4, -followed.y);
      truckTag.position.set(followed.x, 9, -followed.y);
      const pulse = 1 + 0.06 * Math.sin(elapsed * 4);
      marker.scale.set(pulse, 1, pulse);
      if (!followed.static) trace.progress(followed.s + 9);
    }
    if (followed && !followed.static && !flight) {
      lastTarget.copy(controls.target);
      want.set(followed.x, 1.5, -followed.y);
      controls.target.lerp(want, Math.min(1, dt * 4));
      camera.position.add(want.copy(controls.target).sub(lastTarget));
      if (chase) camera.position.lerp(want.copy(controls.target).add(chaseOffset(followed)), Math.min(1, dt * 0.8));
    }
    if (tour && !flight) {
      tour.hold -= dt;
      if (tour.hold <= 0) nextTourStop();
    }
    /* Left alone, the camera drifts slowly round the port so the picture never sits still. */
    idle += dt;
    const drifting = drift && !followed && !tour && idle > 25;
    controls.autoRotate = !flight && (!!tour || drifting);
    controls.autoRotateSpeed = tour ? 0.55 : 0.22;
    stepRings(dt);
    stepFlight(dt);
    stepOpening(dt);
    controls.update();

    const distance = camera.position.distanceTo(controls.target);
    if (atmosphere.update(dt, elapsed, camera, controls.target, distance)) pushLighting();
    labels.domElement.classList.toggle("far", distance > 2400);
    labels.domElement.classList.toggle("mid", distance > 750);

    kpiTimer -= dt;
    if (kpiTimer <= 0) {
      renderKpis(0.4);
      renderCard();
      kpiTimer = 0.4;
    }
    /* Behind the executive overview the scene is barely visible, so it is drawn only now and
       then and the board gets the whole frame budget. */
    frames += 1;
    if (!exec.open || frames % 6 === 0) {
      composer.render();
      labels.render(scene, camera);
    }

    /* Trade resolution for smoothness on weak GPUs: sustained slow frames lower the pixel ratio. */
    if (frames === 4) reveal();
    if (frames > 120 && pixelRatio > 0.75) {
      slowFrames = raw > 1 / 30 ? slowFrames + 1 : Math.max(0, slowFrames - 2);
      if (slowFrames > 90) {
        pixelRatio = Math.max(0.75, pixelRatio * 0.85);
        renderer.setPixelRatio(pixelRatio);
        composer.setPixelRatio(pixelRatio);
        sizeBloom();
        slowFrames = 0;
      }
    }
    requestAnimationFrame(frame);
  }
  renderKpis();
  if (film) setupFilm();
  else requestAnimationFrame(frame);
  /* The port assembles itself: a vertical clipping plane sweeps across the site drawing the
     ground and roads, then a rising plane grows every building from the ground up, then the
     trucks roll. Desert, sea, sky, fog, overlays and labels are hidden; the background stays
     transparent. The capture script steps time with __film.frame(t, dt). */
  function setupFilm() {
    if (ground) ground.mesh.visible = false;
    world.setGround(true);
    atmosphere.dome.visible = false;
    scene.traverse((o) => {
      if (o.isMesh && o.material && (o.material.isShaderMaterial || o.material.isRawShaderMaterial)) o.visible = false;
    });
    labels.domElement.style.display = "none";
    applyLighting(params.get("light") || "day");
    /* The film shows the port as a cut-out model: everything is clipped to a box laid along
       the site's axis (the Saudi-Doha road, 44 degrees), round the operational core, standing
       on a sand plate whose edges fade to transparent. u runs along the axis, v across it. */
    const ang = THREE.MathUtils.degToRad(44);
    const U = [Math.cos(ang), Math.sin(ang)];
    const V = [-Math.sin(ang), Math.cos(ang)];
    const BOX = { u0: -850, u1: 1600, v0: -480, v1: 780 };
    const cu = (BOX.u0 + BOX.u1) / 2;
    const cvv = (BOX.v0 + BOX.v1) / 2;
    const cx = cu * U[0] + cvv * V[0];
    const cy = cu * U[1] + cvv * V[1];
    const cv = document.createElement("canvas");
    cv.width = cv.height = 256;
    const g2 = cv.getContext("2d");
    const img = g2.createImageData(256, 256);
    for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const e = Math.min(x / 255, 1 - x / 255, (y / 255) * 2, (1 - y / 255) * 2);
        const a = Math.min(1, Math.max(0, e / 0.08));
        const v = Math.round(255 * a * a * (3 - 2 * a));
        const k = (y * 256 + x) * 4;
        img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
        img.data[k + 3] = 255;
      }
    }
    g2.putImageData(img, 0, 0);
    const alphaMap = new THREE.CanvasTexture(cv);
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(BOX.u1 - BOX.u0 + 80, BOX.v1 - BOX.v0 + 80), new THREE.MeshStandardMaterial({ color: "#d8c29a", roughness: 1, transparent: true, alphaMap, depthWrite: false }));
    plate.rotation.order = "YXZ";
    plate.rotation.set(-Math.PI / 2, ang, 0);
    plate.position.set(cx, -0.3, -cy);
    plate.receiveShadow = true;
    plate.renderOrder = -1;
    scene.add(plate);
    /* in the scene, map (x, y) is (x, h, -y): u = x*U0 - z*U1 */
    const keep = (nu, nv, c) => new THREE.Plane(new THREE.Vector3(nu * U[0] + nv * V[0], 0, -(nu * U[1] + nv * V[1])), c);
    if (filmStyle === "2") {
      setupReveal({ keep, BOX, cx, cy });
      $("loader")?.remove();
      return;
    }
    const sweep = keep(-1, 0, 0);
    const rise = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    renderer.clippingPlanes = [sweep, rise, keep(1, 0, -BOX.u0), keep(0, 1, -BOX.v0), keep(0, -1, BOX.v1)];
    const x0 = BOX.u0;
    const x1 = BOX.u1;
    const ease = (f) => (f <= 0 ? 0 : f >= 1 ? 1 : f < 0.5 ? 4 * f ** 3 : 1 - (-2 * f + 2) ** 3 / 2);
    const lerp = (a, b, f) => a + (b - a) * f;
    const T = { sweep: [0, 2.4], rise: [1.6, 4.4] };
    const phase = (t, [a, b]) => ease((t - a) / (b - a));
    $("loader")?.remove();
    window.__film = {
      extent: [x0, x1],
      frame(t, dt = 1 / 30) {
        elapsed += dt;
        sim.advance(dt * 5);
        sim.render();
        fleet.commit();
        world.update(elapsed, dt, sim);
        inspectors.update(elapsed);
        const fs = phase(t, T.sweep);
        sweep.constant = Math.min(x1, lerp(x0 - 20, x1 + 20, fs));
        const fr = phase(t, T.rise);
        rise.constant = t >= T.rise[1] ? 1e6 : lerp(0.45, 70, fr);
        /* a slow orbit, closing in a little */
        const f = Math.min(1, t / 8);
        const pose = camPose(cx, cy, lerp(3200, 2750, ease(f)), lerp(58, 50, f), lerp(146, 160, f));
        camera.position.copy(pose.position);
        controls.target.copy(pose.target);
        camera.lookAt(controls.target);
        atmosphere.update(dt, elapsed, camera, controls.target, camera.position.distanceTo(controls.target));
        if (scene.fog) {
          scene.fog.near = 1e8;
          scene.fog.far = 2e8;
        }
        renderer.render(scene, camera);
        return true;
      },
    };
  }
  /* The architect's reveal (?film=2). Every surface is drawn through a small shader patch:
     anything farther than R from the heart of the port (ramps, X-ray, main parking) is cut away,
     and buildings near that edge are pressed into the ground, so as R grows the port rises out
     of the sand from the middle outwards. The camera starts low at the side of the core, moves
     in, then pulls up and out to the plan view while R grows to take in the whole site. */
  function setupReveal({ keep, BOX, cx, cy }) {
    renderer.clippingPlanes = [keep(1, 0, -BOX.u0), keep(-1, 0, BOX.u1), keep(0, 1, -BOX.v0), keep(0, -1, BOX.v1)];
    const rp = rampInfo ? centroid(rampInfo.categories) : [station("inbound", 6).x, station("inbound", 6).y];
    const xr = centroid(data.xrays);
    const yd = station("inbound", 4);
    /* the heart of the port, a third of the way from the inspection ramps to the X-ray: the
       opening shot looks from beside the ramps, X-ray behind, main parking to the side */
    const F = [rp[0] + (xr[0] - rp[0]) * 0.35, rp[1] + (xr[1] - rp[1]) * 0.35];
    const sideBearing = THREE.MathUtils.radToDeg(Math.atan2(rp[0] - xr[0], rp[1] - xr[1]));
    const ang = THREE.MathUtils.degToRad(44);
    let reach = 0;
    for (const u of [BOX.u0, BOX.u1]) {
      for (const v of [BOX.v0, BOX.v1]) {
        const x = u * Math.cos(ang) - v * Math.sin(ang);
        const y = u * Math.sin(ang) + v * Math.cos(ang);
        reach = Math.max(reach, Math.hypot(x - F[0], y - F[1]));
      }
    }
    const U = { uC: { value: new THREE.Vector2(F[0], -F[1]) }, uR: { value: 0 }, uRamp: { value: 110 } };
    const decl = "uniform vec2 uC;\nuniform float uR;\nuniform float uRamp;\nvarying vec2 vFilmXZ;\n";
    const project = [
      "vec4 mvPosition = vec4( transformed, 1.0 );",
      "#ifdef USE_BATCHING",
      "  mvPosition = batchingMatrix * mvPosition;",
      "#endif",
      "#ifdef USE_INSTANCING",
      "  mvPosition = instanceMatrix * mvPosition;",
      "#endif",
      "vec4 filmW = modelMatrix * mvPosition;",
      "vFilmXZ = filmW.xz;",
      "float filmG = clamp( ( uR - length( filmW.xz - uC ) ) / uRamp, 0.0, 1.0 );",
      "filmG = filmG * filmG * ( 3.0 - 2.0 * filmG );",
      "if ( filmW.y > 0.6 ) filmW.y = 0.6 + ( filmW.y - 0.6 ) * filmG;",
      "mvPosition = viewMatrix * filmW;",
      "gl_Position = projectionMatrix * mvPosition;",
    ].join("\n");
    const patched = new WeakSet();
    function patch(m, soft) {
      if (!m || patched.has(m) || m.isShaderMaterial || m.isRawShaderMaterial) return;
      patched.add(m);
      m.onBeforeCompile = (shader) => {
        if (!shader.vertexShader.includes("#include <project_vertex>") || !shader.fragmentShader.includes("#include <clipping_planes_fragment>")) return;
        Object.assign(shader.uniforms, U);
        shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\n" + decl).replace("#include <project_vertex>", project);
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\n" + decl)
          .replace("#include <clipping_planes_fragment>", "float vFilmD = length( vFilmXZ - uC );\nif ( vFilmD > uR ) discard;\n#include <clipping_planes_fragment>");
        if (soft) shader.fragmentShader = shader.fragmentShader.replace("#include <dithering_fragment>", "#include <dithering_fragment>\ngl_FragColor.a *= 1.0 - smoothstep( uR - 80.0, uR, vFilmD );");
      };
      m.customProgramCacheKey = () => (soft ? "film-reveal-soft" : "film-reveal");
      m.needsUpdate = true;
    }
    /* shadows are cast from a depth pass, which needs the same patch or flattened buildings
       would still throw full-height shadows */
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    patch(depth, false);
    const plate = scene.children.find((o) => o.isMesh && o.material?.alphaMap && o.renderOrder === -1);
    function patchScene() {
      scene.traverse((o) => {
        if (!(o.isMesh || o.isLine || o.isPoints) || !o.visible) return;
        for (const m of [].concat(o.material)) patch(m, o === plate);
        if (o.isMesh && o.castShadow && !o.customDepthMaterial) o.customDepthMaterial = depth;
      });
    }
    patchScene();
    const ease = (f) => (f <= 0 ? 0 : f >= 1 ? 1 : f < 0.5 ? 4 * f ** 3 : 1 - (-2 * f + 2) ** 3 / 2);
    const out = (f) => (f <= 0 ? 0 : f >= 1 ? 1 : 1 - (1 - f) ** 3);
    const lerp = (a, b, f) => a + (b - a) * f;
    const seg = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));
    /* timeline, seconds */
    const T = { push: [0, 4.6], pull: [4.6, 10.8], end: 12.5 };
    window.__film = {
      style: 2,
      duration: T.end,
      focus: F,
      points: { ramps: rp, xray: xr, yard: [yd.x, yd.y] },
      frame(t, dt = 1 / 30) {
        elapsed += dt;
        sim.advance(dt * 5);
        sim.render();
        fleet.commit();
        world.update(elapsed, dt, sim);
        inspectors.update(elapsed);
        patchScene();
        const a = ease(seg(t, ...T.push));
        const b = ease(seg(t, ...T.pull));
        /* the core rises in front of a low camera, then the rest grows as the camera climbs */
        const core = 540;
        U.uR.value = t < T.pull[0] ? lerp(0, core, out(seg(t, 0.15, 4.2))) : lerp(core, reach + 140, out(seg(t, T.pull[0] + 0.4, T.pull[1] - 0.2)));
        const dist = lerp(lerp(700, 470, a), 2700, b);
        const polar = lerp(lerp(77, 73, a), 6, b ** 0.8);
        const bearing = lerp(lerp(sideBearing - 14, sideBearing + 6, a), 136, b);
        const tx = lerp(F[0], cx, b);
        const ty = lerp(F[1], cy, b);
        const pose = camPose(tx, ty, dist, polar, bearing);
        camera.position.copy(pose.position);
        controls.target.copy(pose.target);
        camera.lookAt(controls.target);
        atmosphere.update(dt, elapsed, camera, controls.target, dist);
        if (scene.fog) {
          scene.fog.near = 1e8;
          scene.fog.far = 2e8;
        }
        renderer.render(scene, camera);
        return true;
      },
    };
  }
  window.__twin = { plan, sim, world, fleet, camera, controls, renderer, flyTo, VIEWS, applyLighting, camPose, atmosphere, ground, select, scene, composer };
}

main().catch((error) => {
  console.error(error);
  status("Could not start: " + error.message);
  $("loader").classList.add("error");
});
