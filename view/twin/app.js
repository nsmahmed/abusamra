import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { buildWorld, buildFlows, buildZones } from "./world.js";
import { Fleet, pick } from "./vehicles.js";
import { Simulation } from "./sim.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const wait = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function status(text) {
  $("loader-step").textContent = text;
}

const LIGHTING = {
  day: { elevation: 38, azimuth: 225, exposure: 0.42, sun: 3.0, hemi: 0.5, bloom: 0.1, threshold: 0.97, fog: "#e7dccb", night: 0, env: 0.55, turbidity: 4, rayleigh: 1.0 },
  sunset: { elevation: 9, azimuth: 258, exposure: 0.5, sun: 3.2, hemi: 0.35, bloom: 0.35, threshold: 0.85, fog: "#e6b48a", night: 0.2, env: 0.5, turbidity: 8, rayleigh: 2.4 },
  night: { elevation: -10, azimuth: 280, exposure: 1.05, sun: 0.0, hemi: 0.32, bloom: 0.9, threshold: 0.5, fog: "#0d1726", night: 1, env: 0.18, turbidity: 2, rayleigh: 0.5 },
};

const TONES = { gold: "#d6b47a", maroon: "#d8577b", green: "#3fbf8a", teal: "#4cc3c0", proposal: "#f0c9c4" };

async function main() {
  status("Loading port geometry");
  const response = await fetch("../../data/processed/scene.json", { cache: "no-store" });
  if (!response.ok) throw new Error("scene.json returned " + response.status);
  const data = await response.json();
  if (!Array.isArray(data.roads) || !Array.isArray(data.routes)) {
    throw new Error("scene.json is outdated; run python -m abu_samra.scene and reload");
  }
  await wait();

  const stage = $("stage");
  const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
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
  controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
  controls.minDistance = 12;
  controls.maxDistance = 7000;
  controls.zoomToCursor = true;

  const sky = new Sky();
  sky.scale.setScalar(45000);
  scene.add(sky);
  const skyScene = new THREE.Scene();
  const skyEnv = new Sky();
  skyEnv.scale.setScalar(1000);
  skyScene.add(skyEnv);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = null;

  const sun = new THREE.DirectionalLight("#fff4e0", 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0003;
  scene.add(sun, sun.target);
  const moon = new THREE.DirectionalLight("#9fb6e6", 0);
  scene.add(moon, moon.target);
  const hemi = new THREE.HemisphereLight("#cfe3ff", "#c9a87a", 0.7);
  scene.add(hemi);
  scene.fog = new THREE.Fog("#dfe3e4", 5000, 26000);
  const sunDir = new THREE.Vector3();

  status("Building roads, yards and customs structures");
  await wait();
  const world = buildWorld(scene, data, renderer);
  const flows = buildFlows(scene, data);
  const zones = buildZones(scene, data);
  const fleet = new Fleet(scene);
  let followed = null;
  const sim = new Simulation(data, fleet, {
    onRemove(v) {
      if (followed === v) stopFollow();
    },
  });

  const statics = [];
  const placeStatic = (slot, where) => {
    const v = {
      type: "truck",
      static: true,
      where,
      plate: Math.random() < 0.6 ? `${Math.floor(1000 + Math.random() * 8999)} ${pick(["أ ب ج", "ر س ط", "ك ل م", "ن هـ و"])}` : `${Math.floor(100000 + Math.random() * 899999)}`,
      cargo: pick(["Foodstuffs", "Construction steel", "Electronics", "Animal feed", "Auto parts", "Furniture", "Textiles", "Machinery"]),
    };
    if (!fleet.allocate(v)) return;
    const dx = Math.sin(slot.h);
    const dy = Math.cos(slot.h);
    const yaw = Math.atan2(dx, -dy);
    v.x = slot.x;
    v.y = slot.y;
    fleet.place(v, { cx: slot.x + dx * 5.5, cz: -(slot.y + dy * 5.5), cyaw: yaw, tx: slot.x - dx * 2.05, tz: -(slot.y - dy * 2.05), tyaw: yaw });
    statics.push(v);
  };
  world.yardSlots.forEach((slot) => placeStatic(slot, "yard"));
  world.rampSlots.forEach((slot) => placeStatic(slot, "ramp"));
  sim.setBays(world.rampBays);
  sim.reserveParked(world.yardSlots);
  fleet.commit();

  status("Warming up traffic");
  const prewarm = Number(params.get("prewarm") || 2700);
  /* Seed the dashboard trend with the warm-up so it opens with a line, not an empty chart. */
  const staticCount = statics.length;
  const seedHistory = [];
  for (let t = 0; t < prewarm; t += 300) {
    sim.advance(300);
    seedHistory.push(sim.kpis(0, 0, 0).trucksIn + staticCount);
    $("loader-bar").style.width = `${Math.round((t / prewarm) * 100)}%`;
    await wait();
  }
  sim.clock0 = 9 * 3600 - sim.time;
  sim.render();
  fleet.commit();

  /* ---------- post-processing ---------- */
  const target = new THREE.WebGLRenderTarget(stage.clientWidth, stage.clientHeight, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(stage.clientWidth, stage.clientHeight);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(stage.clientWidth, stage.clientHeight), 0.2, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ---------- lighting presets ---------- */
  let lighting = params.get("light") || "day";
  function applyLighting(name) {
    lighting = name;
    const L = LIGHTING[name];
    const phi = THREE.MathUtils.degToRad(90 - L.elevation);
    const theta = THREE.MathUtils.degToRad(180 - L.azimuth);
    sunDir.setFromSphericalCoords(1, phi, theta);
    for (const s of [sky, skyEnv]) {
      const u = s.material.uniforms;
      u.sunPosition.value.copy(sunDir);
      u.turbidity.value = L.turbidity;
      u.rayleigh.value = L.rayleigh;
      u.mieCoefficient.value = 0.005;
      u.mieDirectionalG.value = 0.82;
    }
    sky.visible = L.elevation > -5;
    scene.background = L.elevation > -5 ? null : new THREE.Color("#070d18");
    renderer.toneMappingExposure = L.exposure;
    sun.intensity = L.sun;
    sun.color.set(L.elevation < 12 ? "#ffcf9a" : "#fff4e0");
    moon.intensity = L.night ? 0.35 * L.night : 0;
    hemi.intensity = L.hemi;
    hemi.color.set(L.night > 0.5 ? "#6d82b8" : "#cfe3ff");
    hemi.groundColor.set(L.night > 0.5 ? "#2a2433" : "#c9a87a");
    scene.fog.color.set(L.fog);
    bloom.strength = L.bloom;
    bloom.threshold = L.threshold;
    if (envTarget) envTarget.dispose();
    envTarget = pmrem.fromScene(skyScene, 0.02);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = L.env;
    world.setNight(L.night);
    zones.setNight(L.night);
    fleet.lightMaterial.color.setScalar(1 + L.night * 3);
    document.querySelectorAll("[data-light]").forEach((el) => el.classList.toggle("on", el.dataset.light === name));
    document.body.classList.toggle("is-night", L.night > 0.5);
  }

  /* ---------- camera helpers ---------- */
  const v3 = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
  function camPose(x, y, distance, polar, bearing) {
    const t = v3(x, y);
    const offset = new THREE.Vector3().setFromSphericalCoords(distance, THREE.MathUtils.degToRad(polar), THREE.MathUtils.degToRad(180 - bearing));
    return { target: t, position: t.clone().add(offset) };
  }
  let flight = null;
  function flyTo(pose, duration = 2.6) {
    flight = { from: { p: camera.position.clone(), t: controls.target.clone() }, to: pose, t: 0, duration };
    controls.enabled = false;
  }
  function stepFlight(dt) {
    if (!flight) return;
    flight.t += dt / flight.duration;
    const k = flight.t >= 1 ? 1 : flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    const lift = Math.sin(Math.PI * Math.min(1, flight.t)) * flight.from.p.distanceTo(flight.to.position) * 0.12;
    camera.position.lerpVectors(flight.from.p, flight.to.position, k);
    camera.position.y += lift;
    controls.target.lerpVectors(flight.from.t, flight.to.target, k);
    if (flight.t >= 1) {
      flight = null;
      controls.enabled = true;
    }
  }

  const VIEWS = {
    overview: () => camPose(110, -130, 1800, 57, 148),
    yard: () => {
      const s = data.stations.find((st) => st.flow === "inbound" && st.n === 4);
      return camPose(s.x, s.y, 560, 52, 145);
    },
    xray: () => {
      const x = data.xrays[0];
      return camPose(x.x, x.y, 170, 56, 120);
    },
    gates: () => {
      const p = data.portals[0] || data.gates[0];
      const g = data.gates.find((item) => item.ref === "inbound-gate") || p;
      return camPose((p.x + g.x) / 2, (p.y + g.y) / 2, 260, 58, 160);
    },
    booths: () => {
      const b = data.booths[0];
      return camPose(b.x, b.y, 70, 74, THREE.MathUtils.radToDeg(b.h) + 35);
    },
    ramps: () => {
      const s = data.stations.find((st) => st.flow === "inbound" && st.n === 6);
      return camPose(s.x, s.y, 260, 52, 150);
    },
  };

  /* ---------- language ---------- */
  const I18N = {
    en: {
      subtitle: "Digital twin · Customs operations", import: "Import", export: "Export", passengers: "Passengers",
      layers: "Layers", labels: "Labels", paths: "Flow paths", zones: "Zones", process: "Process steps",
      operations: "Operations", simulated: "Simulated", trucksOnSite: "Trucks on site", parking: "Main parking", bays: "bays",
      scans: "X-ray / hr", clearance: "Avg clearance", atRamps: "At ramps", released: "Released",
      cleared: "cleared", booths: "booths active", queue: "on approach", min: "min",
      vOverview: "Overview", vGates: "Gates", vParking: "Parking", vXray: "X-ray", vRamps: "Ramps", vBooths: "Booths", tour: "Tour",
    },
    ar: {
      subtitle: "التوأم الرقمي · العمليات الجمركية", import: "الوارد", export: "الصادر", passengers: "المسافرون",
      layers: "الطبقات", labels: "التسميات", paths: "مسارات الحركة", zones: "المناطق", process: "خطوات الإجراء",
      operations: "العمليات", simulated: "محاكاة", trucksOnSite: "الشاحنات في المنفذ", parking: "المواقف الرئيسية", bays: "موقف",
      scans: "مسح / ساعة", clearance: "متوسط التخليص", atRamps: "في الرمبات", released: "تم الإفراج",
      cleared: "مسافر", booths: "أكشاك عاملة", queue: "في الطريق", min: "دقيقة",
      vOverview: "عام", vGates: "البوابات", vParking: "المواقف", vXray: "الأشعة", vRamps: "الرمبات", vBooths: "الأكشاك", tour: "جولة",
    },
  };
  const FLOWS = {
    inbound: { en: ["Import", "Saudi Arabia → Qatar"], ar: ["الوارد", "من السعودية إلى قطر"] },
    outbound: { en: ["Export", "Qatar → Saudi Arabia"], ar: ["الصادر", "من قطر إلى السعودية"] },
    passenger: { en: ["Passengers", "Cars and buses"], ar: ["المسافرون", "السيارات والحافلات"] },
  };
  let lang = params.get("lang") === "ar" ? "ar" : "en";
  const stationName = (st) => (lang === "ar" ? st.ar_short || st.ar : st.short || st.en);
  const META_AR = { "2 lanes": "مساران", "3 lanes": "3 مسارات", "4 lanes": "4 مسارات", unused: "غير مستغلة" };
  const stationMeta = (st) => (lang === "ar" ? META_AR[st.meta] || st.meta : st.meta);

  /* ---------- station pins ---------- */
  const stationObjects = [];
  const lineMat = new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.45, depthWrite: false });
  data.stations.forEach((st, index) => {
    const el = document.createElement("button");
    el.className = `station tone-${st.tone}`;
    el.title = `${st.en} · ${st.ar}`;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      focusStation(index);
    });
    const obj = new CSS2DObject(el);
    const height = st.flow === "passenger" ? 26 : 20;
    obj.position.copy(v3(st.x, st.y, height));
    obj.center.set(0.5, 1);
    scene.add(obj);
    const geo = new THREE.BufferGeometry().setFromPoints([v3(st.x, st.y, 0.6), v3(st.x, st.y, height)]);
    const line = new THREE.Line(geo, lineMat);
    scene.add(line);
    const dot = new THREE.Mesh(new THREE.RingGeometry(1.4, 2.4, 32), new THREE.MeshBasicMaterial({ color: TONES[st.tone], toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false }));
    dot.rotation.x = -Math.PI / 2;
    dot.position.copy(v3(st.x, st.y, 0.6));
    scene.add(dot);
    stationObjects.push({ st, obj, line, dot, el });
  });
  function paintPins() {
    for (const { st, el } of stationObjects) {
      el.innerHTML = `<span class="dotn">${st.n}</span><span class="nm">${stationName(st)}</span>${st.meta ? `<span class="mt">${stationMeta(st)}</span>` : ""}`;
    }
  }

  const focusDistance = (st) => (/parking/i.test(st.en) ? 560 : st.n === 1 ? 420 : st.n === 6 ? 280 : 220);
  function focusStation(index) {
    const { st } = stationObjects[index];
    stopTour();
    if (st.flow !== activeFlow) setFlow(st.flow);
    flyTo(camPose(st.x, st.y, focusDistance(st), 56, 145));
    highlightStep(index);
  }
  function highlightStep(index) {
    document.querySelectorAll(".step").forEach((el) => el.classList.toggle("on", Number(el.dataset.index) === index));
    stationObjects.forEach((s, i) => s.el.classList.toggle("on", i === index));
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
    data.stations.forEach((st, index) => {
      if (st.flow !== activeFlow) return;
      const li = document.createElement("li");
      li.innerHTML = `<button type="button" class="step tone-${st.tone}" data-index="${index}" title="${st.en}"><span class="dotn">${st.n}</span><span class="nm">${stationName(st)}</span>${st.meta ? `<span class="mt">${stationMeta(st)}</span>` : ""}</button>`;
      li.firstChild.addEventListener("click", () => focusStation(index));
      host.appendChild(li);
    });
  }
  function applyVisibility() {
    for (const { st, obj, line, dot } of stationObjects) {
      const mine = st.flow === activeFlow;
      obj.visible = mine && showLabels;
      line.visible = mine && showLabels;
      dot.visible = mine;
    }
    for (const flow of ["inbound", "outbound", "passenger"]) {
      flows.setVisible(flow, flow === activeFlow && showFlows);
      zones.setVisible(flow, flow === activeFlow && showZones);
    }
    $("rail").classList.toggle("hidden", !showRail);
  }
  function setFlow(flow) {
    activeFlow = flow;
    document.querySelectorAll("[data-flow]").forEach((b) => b.classList.toggle("on", b.dataset.flow === flow));
    renderRail();
    applyVisibility();
  }
  document.querySelectorAll("[data-flow]").forEach((b) =>
    b.addEventListener("click", () => {
      stopTour();
      setFlow(b.dataset.flow);
      const first = data.stations.filter((st) => st.flow === b.dataset.flow && st.n !== 1);
      if (b.dataset.flow === "inbound") flyTo(VIEWS.overview());
      else if (first.length) {
        const cx = first.reduce((s, st) => s + st.x, 0) / first.length;
        const cy = first.reduce((s, st) => s + st.y, 0) / first.length;
        flyTo(camPose(cx, cy, b.dataset.flow === "passenger" ? 1100 : 1400, 56, 145));
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
  }
  $("lang").addEventListener("click", () => {
    lang = lang === "ar" ? "en" : "ar";
    applyLanguage();
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
      flyTo(VIEWS[el.dataset.view]());
      document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b === el));
    })
  );
  controls.addEventListener("start", () => {
    if (!flight) document.querySelectorAll("[data-view]").forEach((b) => b.classList.remove("on"));
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "d") $("toggle-dash").click();
    else if (k === "p") togglePresent();
    else if (k === "escape") togglePresent(false);
    else if (k === " ") {
      e.preventDefault();
      togglePause();
    } else if (k === "l") $("toggle-labels").click();
    else if (k === "1" || k === "2" || k === "3") document.querySelectorAll("[data-flow]")[Number(k) - 1].click();
  });

  /* ---------- tour ---------- */
  let tour = null;
  function startTour() {
    stopFollow();
    const order = stationObjects.map((s, i) => i).filter((i) => stationObjects[i].st.flow === activeFlow);
    tour = { order, k: -1, hold: 0 };
    $("tour").classList.add("on");
    nextTourStop();
  }
  function nextTourStop() {
    tour.k = (tour.k + 1) % tour.order.length;
    const index = tour.order[tour.k];
    const { st } = stationObjects[index];
    flyTo(camPose(st.x, st.y, focusDistance(st), 58, 120 + (tour.k % 4) * 25), 3.2);
    tour.hold = 9;
    highlightStep(index);
  }
  function stopTour() {
    if (!tour) return;
    tour = null;
    controls.autoRotate = false;
    $("tour").classList.remove("on");
  }
  $("tour").addEventListener("click", () => (tour ? stopTour() : startTour()));
  controls.addEventListener("start", () => {
    if (!flight) stopTour();
  });

  /* ---------- vehicle picking and following ---------- */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;
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
  function select(v) {
    stopTour();
    followed = v;
    $("vehicle").classList.add("open");
    if (!v.static) {
      const p = v3(v.x, v.y);
      const offset = camera.position.clone().sub(controls.target);
      const want = Math.min(offset.length(), 140);
      offset.setLength(Math.max(want, 60));
      flyTo({ target: p, position: p.clone().add(offset) }, 1.4);
    }
    renderCard();
  }
  function stopFollow() {
    followed = null;
    $("vehicle").classList.remove("open");
  }
  $("vehicle-close").addEventListener("click", stopFollow);
  $("follow").addEventListener("click", () => {
    const flowOf = { inbound: "inbound", outbound: "outbound" };
    const candidates = sim.vehicles.filter((v) => v.type === "truck" && v.state === "drive" && Math.hypot(v.x, v.y) < 1500 && v.speed > 2 && (!flowOf[activeFlow] || v.route.flow === activeFlow));
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
    $("vehicle-body").innerHTML = `
      <div class="vc-title">${d.title} <span class="tag">${d.speed} km/h</span></div>
      <div class="vc-plate">${d.plate}</div>
      <dl>
        <dt>Route</dt><dd>${d.origin}</dd>
        ${d.cargo ? `<dt>Cargo</dt><dd>${d.cargo}</dd>` : ""}
        <dt>Status</dt><dd>${d.status}</dd>
        <dt>On site</dt><dd>${d.minutes} min</dd>
      </dl>
      <ol class="plan">${plan}</ol>
      <div class="plan-now">${now ? `Next · <b>${now.label}</b>` : "<b>Leaving the port</b>"}</div>`;
  }

  /* ---------- dashboard metrics ---------- */
  const rampStatic = statics.filter((v) => v.where === "ramp").length;
  const yardStatic = statics.filter((v) => v.where === "yard").length;
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
    const k = sim.kpis(yardStatic, world.yardCapacity, rampStatic);
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
    const c = sim.clock;
    const hh = String(Math.floor(c / 3600) % 24).padStart(2, "0");
    const mm = String(Math.floor(c / 60) % 60).padStart(2, "0");
    $("clock").textContent = `${hh}:${mm}`;
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

  /* ---------- resize and loop ---------- */
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);

  applyLighting(lighting);
  const startView = params.get("view");
  /* ?cam=x,y,distance,polar,bearing frames an exact shot (deep links, screenshots). */
  const camParam = (params.get("cam") || "").split(",").map(Number);
  const camShot = camParam.length === 5 && camParam.every(Number.isFinite) ? camPose(...camParam) : null;
  const intro = params.get("intro") !== "0" && !startView && !camShot;
  const initial = camShot || (startView && VIEWS[startView] ? VIEWS[startView]() : VIEWS.overview());
  if (intro) {
    const far = camPose(-40, 40, 6200, 70, 200);
    camera.position.copy(far.position);
    controls.target.copy(far.target);
    flyTo(initial, 5.5);
  } else {
    camera.position.copy(initial.position);
    controls.target.copy(initial.target);
  }
  controls.update();

  $("loader").classList.add("done");
  setTimeout(() => $("loader").remove(), 900);

  const markerGeo = new THREE.RingGeometry(9, 10.5, 48);
  markerGeo.rotateX(-Math.PI / 2);
  const marker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color("#f3c56b").multiplyScalar(2), toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }));
  marker.renderOrder = 6;
  marker.visible = false;
  scene.add(marker);

  const clock = new THREE.Clock();
  let kpiTimer = 0;
  let elapsed = 0;
  const lastTarget = new THREE.Vector3();
  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    elapsed += dt;
    if (!paused) sim.advance(dt * speed);
    sim.render();
    fleet.commit();
    world.update(elapsed, dt, sim);
    flows.uniforms.uTime.value = elapsed;
    zones.uniforms.uTime.value = elapsed;

    marker.visible = !!followed;
    if (followed) {
      marker.position.set(followed.x, 0.3, -followed.y);
      const pulse = 1 + 0.18 * Math.sin(elapsed * 5);
      marker.scale.set(pulse, 1, pulse);
    }
    if (followed && !followed.static && !flight) {
      lastTarget.copy(controls.target);
      const want = v3(followed.x, followed.y);
      controls.target.lerp(want, Math.min(1, dt * 4));
      camera.position.add(controls.target.clone().sub(lastTarget));
    }
    if (tour && !flight) {
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.55;
      tour.hold -= dt;
      if (tour.hold <= 0) {
        controls.autoRotate = false;
        nextTourStop();
      }
    }
    stepFlight(dt);
    controls.update();

    const distance = camera.position.distanceTo(controls.target);
    const size = THREE.MathUtils.clamp(distance * 0.75, 90, 1700);
    sun.target.position.copy(controls.target);
    sun.position.copy(controls.target).addScaledVector(sunDir, 2500);
    moon.position.copy(controls.target).add(new THREE.Vector3(600, 1400, -400));
    moon.target.position.copy(controls.target);
    const cam = sun.shadow.camera;
    if (Math.abs(cam.right - size) > 1) {
      cam.left = -size;
      cam.right = size;
      cam.top = size;
      cam.bottom = -size;
      cam.near = 100;
      cam.far = 5200;
      cam.updateProjectionMatrix();
      sun.shadow.normalBias = size / 900;
    }
    sun.castShadow = LIGHTING[lighting].sun > 0;
    labels.domElement.classList.toggle("far", distance > 2400);
    labels.domElement.classList.toggle("near", distance < 2000);

    kpiTimer -= dt;
    if (kpiTimer <= 0) {
      renderKpis(0.4);
      renderCard();
      kpiTimer = 0.4;
    }
    composer.render();
    labels.render(scene, camera);
    requestAnimationFrame(frame);
  }
  renderKpis();
  requestAnimationFrame(frame);
  window.__twin = { sim, world, fleet, camera, controls, renderer, flyTo, VIEWS, applyLighting, camPose };
}

main().catch((error) => {
  console.error(error);
  status("Could not start: " + error.message);
  $("loader").classList.add("error");
});
