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
import { Planner, model } from "./planner.js";

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
  /* Planner defaults and limits: parking bays, x-ray scanners, inspection categories, model. */
  const cfg = await (await fetch("config.json", { cache: "no-store" })).json();
  const plan = { pins: [], open: false };
  await wait();

  const stage = $("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  /* The picture is fill-rate bound on integrated graphics, so the default draws about a
     1080p frame whatever the display scaling, and smooths edges in post. ?quality=high lifts
     the cap and switches to multisampling for machines with a discrete GPU. */
  const high = params.get("quality") === "high";
  const budget = high ? 6.5e6 : 2.2e6;
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
      if (kind === "release") exec.release(sim.time, v);
      feedDirty = true;
    },
  });
  let feedDirty = true;

  const statics = [];
  const placeStatic = (slot, where) => {
    const v = {
      type: "truck",
      static: true,
      where,
      kind: slot.kind,
      stall: slot.stall ?? -1,
      plate: Math.random() < 0.6 ? `${Math.floor(1000 + Math.random() * 8999)} ${pick(["أ ب ج", "ر س ط", "ك ل م", "ن هـ و"])}` : `${Math.floor(100000 + Math.random() * 899999)}`,
      cargo: pick(["Foodstuffs", "Construction steel", "Electronics", "Animal feed", "Auto parts", "Furniture", "Textiles", "Machinery"]),
    };
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
  const scenarioOf = (s) => ({ ...s, alloc: s.alloc || Object.fromEntries((data.ramps.find((r) => r.categories) || { categories: [] }).categories.map((c) => [c.id, c.bays])) });
  function syncProps(state, res) {
    const m = cfg.model;
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
      const busy = Math.min(state.alloc[cat] || 0, res.lam * m.inspectRate * (state.mix[cat] || 0) * m.inspectionHours);
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
  /* The scenario runs in the simulation too: arrivals, scanner lanes, inspection mix. */
  function syncSim(state) {
    sim.setInbound(state.demand / 24);
    sim.mix = { ...state.mix };
    const lanes = data.xrays.map((x) => x.id);
    sim.xrayOff = new Set(state.xray < lanes.length ? lanes.slice(state.xray) : []);
    sim.tandem = new Set(lanes.slice(0, Math.max(0, state.xray - lanes.length)));
  }
  {
    const s0 = scenarioOf({ demand: cfg.model.demandPerDay, parking: cfg.parking.default, xray: cfg.xray.default, mix: { ...cfg.ramps.volumeMix } });
    plan.result = model(cfg, s0);
    syncSim(s0);
    syncProps(s0, plan.result);
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
      const g = data.gates.find((item) => item.ref === "inbound-gate") || p;
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
      vOverview: "Overview", vGates: "Gates", vParking: "Parking", vXray: "X-ray", vRamps: "Ramps", vBooths: "Booths", tour: "Tour",
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
    },
    ar: {
      subtitle: "التوأم الرقمي · العمليات الجمركية", import: "الوارد", export: "الصادر", passengers: "المسافرون",
      layers: "الطبقات", labels: "التسميات", paths: "مسارات الحركة", zones: "المناطق", process: "خطوات الإجراء",
      operations: "العمليات", simulated: "محاكاة", trucksOnSite: "الشاحنات في المنفذ", parking: "المواقف الرئيسية", bays: "موقف",
      scans: "مسح / ساعة", clearance: "متوسط التخليص", atRamps: "في الرمبات", released: "تم الإفراج",
      cleared: "مسافر", booths: "أكشاك عاملة", queue: "في الطريق", min: "دقيقة", activity: "النشاط المباشر",
      vOverview: "عام", vGates: "البوابات", vParking: "المواقف", vXray: "الأشعة", vRamps: "الرمبات", vBooths: "الأكشاك", tour: "جولة",
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
      if (st.n === 3) return queue(q("inbound-gate"));
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
      if (st.n === 3) return queue(q("outbound-permit"));
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
      s.el.innerHTML = `<span class="dotn">${s.st.n}</span><span class="nm">${stationName(s.st)}</span><span class="lv"></span>`;
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
      li.innerHTML = `<button type="button" class="step tone-${st.tone}" data-index="${index}" title="${st.en}"><span class="dotn">${st.n}</span><span class="nm">${stationName(st)}</span><span class="lv"></span></button>`;
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
  const dockOrder = world.importBays.map((b, i) => [i, b.home, b.x * axis[0] + b.y * axis[1]]).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([i]) => i);
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
    /* docks: contiguous blocks in allocation order */
    let k = 0;
    for (const cat of CAT_IDS) {
      for (let n = 0; n < st.alloc[cat] && k < dockOrder.length; n += 1, k += 1) {
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
    plan.result = plan.planner ? plan.planner.result : model(cfg, st);
    syncSim(st);
    syncProps(st, plan.result);
    /* Waiting trucks per category, from the model, on each shed's tag. */
    for (const p of shedPins) {
      const q = plan.result.cats[p.c.id];
      const waiting = Number.isFinite(q.wait) ? res0(q) : Infinity;
      const tag = p.el.querySelector(".lvv");
      if (waiting >= 1) tag.insertAdjacentHTML("afterend", `<span class="wait">${Number.isFinite(waiting) ? `${Math.round(waiting)} ${P("waiting", "بالانتظار")}` : P("overloaded", "فوق الطاقة")}</span>`);
    }
    applyVisibility();
  };
  const res0 = (q) => plan.result.lam * cfg.model.inspectRate * q.share * q.wait;
  plan.planner = new Planner(cfg, { shedDocks, proposedMax: world.proposedStalls.length }, {
    lang: () => lang,
    onChange(state) {
      plan.state = state;
      if (!plan.ready) return;
      plan.paint();
      plan.syncHash();
      renderKpis();
    },
  });
  plan.state = plan.planner.state;
  plan.planner.mount($("planner"));
  /* A scenario lives in the address (#plan=…), so it can be shared or reopened as a link. */
  const encodePlan = (s) => `d${s.demand}.p${s.parking}.x${s.xray}.m${["chem", "oga", "health"].map((c) => Math.round(s.mix[c] * 100)).join("-")}.a${["chem", "oga", "health"].map((c) => s.alloc[c]).join("-")}`;
  const decodePlan = (text) => {
    const out = {};
    for (const part of text.split(".")) {
      const k = part[0];
      const v = part.slice(1);
      if (k === "d") out.demand = Number(v);
      if (k === "p") out.parking = Number(v);
      if (k === "x") out.xray = Number(v);
      if (k === "m") {
        const [a, b, c] = v.split("-").map(Number);
        out.mix = { chem: a / 100, oga: b / 100, health: c / 100 };
      }
      if (k === "a") {
        const [a, b, c] = v.split("-").map(Number);
        out.alloc = { chem: a, oga: b, health: c };
      }
    }
    return out;
  };
  plan.planner.onShare = () => location.href;
  plan.syncHash = () => {
    const url = plan.planner.changed() || plan.state.demand !== cfg.model.demandPerDay ? `#plan=${encodePlan(plan.state)}` : " ";
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
    stations: (k, live) => stationObjects.map(({ st }, index) => ({ index, flow: st.flow, n: st.n, tone: st.tone, name: stationName(st), title: lang === "ar" ? st.ar : st.en, value: stationLive(st, k, live) })),
    cargo: () => [...statics, ...props.values(), ...sim.vehicles].filter((v) => v.type === "truck" && v.cargo).map((v) => v.cargo),
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
    flyTo(camPose(st.x, st.y, focusDistance(st) * 0.9, 64, 100 + (tour.k % 4) * 28), 3.4);
    tour.hold = 9;
    highlightStep(index);
  }
  function stopTour() {
    if (!tour) return;
    tour = null;
    $("tour").classList.remove("on");
  }
  $("tour").addEventListener("click", () => (tour ? stopTour() : startTour()));
  controls.addEventListener("start", () => {
    if (!flight) stopTour();
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
  function renderCard() {
    const v = followed;
    if (!v) return;
    if (v.static) {
      $("vehicle-body").innerHTML = `
        <div class="vc-title">Container truck <span class="tag">${v.where === "yard" ? "Parked" : "At ramp"}</span></div>
        <div class="vc-plate">${v.plate}</div>
        <dl><dt>Cargo</dt><dd>${v.cargo}</dd><dt>Status</dt><dd>${v.where === "yard" ? "Awaiting x-ray" : "Physical inspection"}</dd></dl>`;
      return;
    }
    const d = sim.describe(v);
    const plan = d.plan.map((p) => `<li class="${p.state}" title="${p.label}"></li>`).join("");
    const now = d.plan.find((p) => p.state === "now");
    const inspect = v.type === "truck" && v.route.stops.some((s) => s.kind === "ramp");
    const channel = v.type === "truck" ? `<span class="vc-chan ${inspect ? "red" : "green"}">${inspect ? "Red channel · inspection" : "Green channel"}</span>` : "";
    $("vehicle-body").innerHTML = `
      <div class="vc-title">${d.title} <span class="tag">${d.speed} km/h</span></div>
      <div class="vc-plate">${d.plate}</div>${channel}
      <dl>
        <dt>Route</dt><dd>${d.origin}</dd>
        ${d.declaration ? `<dt>Declaration</dt><dd>${d.declaration}</dd>` : ""}
        ${d.cargo ? `<dt>Cargo</dt><dd>${d.cargo}</dd>` : ""}
        ${v.cat && inspect ? `<dt>Inspection</dt><dd><span class="vc-cat" style="--c:${plan.cats[v.cat].color}">${plan.cats[v.cat].en}</span></dd>` : ""}
        <dt>Status</dt><dd>${d.status}</dd>
        <dt>On site</dt><dd>${d.minutes} min</dd>
      </dl>
      <ol class="plan">${plan}</ol>
      <div class="plan-now">${now ? `Next · <b>${now.label}</b>` : "<b>Leaving the port</b>"}</div>`;
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
    $("k-clear").textContent = k.avgClearance ? `${Math.round(k.avgClearance)}` : "—";
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
    if (exec.open) exec.render(k, live);
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
    flows.uniforms.uTime.value = elapsed;
    zones.uniforms.uTime.value = elapsed;
    beacons.shared.uTime.value = elapsed;
    trace.uniforms.uTime.value = elapsed;
    if (ground) ground.uniforms.uTime.value = elapsed;

    marker.visible = !!followed;
    if (followed) {
      marker.position.set(followed.x, 0.4, -followed.y);
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
  requestAnimationFrame(frame);
  window.__twin = { plan, sim, world, fleet, camera, controls, renderer, flyTo, VIEWS, applyLighting, camPose, atmosphere, ground, select, scene, composer };
}

main().catch((error) => {
  console.error(error);
  status("Could not start: " + error.message);
  $("loader").classList.add("error");
});
