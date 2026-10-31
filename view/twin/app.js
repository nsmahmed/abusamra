import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { buildWorld, buildFlows } from "./world.js";
import { Fleet, pick } from "./vehicles.js";
import { Simulation } from "./sim.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const wait = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function status(text) {
  $("loader-step").textContent = text;
}

const LIGHTING = {
  day: { elevation: 38, azimuth: 225, exposure: 0.42, sun: 3.0, hemi: 0.45, bloom: 0.15, threshold: 0.95, fog: "#d9e2e8", night: 0, env: 0.55, turbidity: 4, rayleigh: 1.0 },
  sunset: { elevation: 9, azimuth: 258, exposure: 0.5, sun: 3.2, hemi: 0.35, bloom: 0.35, threshold: 0.85, fog: "#e6b48a", night: 0.2, env: 0.5, turbidity: 8, rayleigh: 2.4 },
  night: { elevation: -10, azimuth: 280, exposure: 1.05, sun: 0.0, hemi: 0.32, bloom: 0.9, threshold: 0.5, fog: "#0d1726", night: 1, env: 0.18, turbidity: 2, rayleigh: 0.5 },
};

const TONES = { gold: "#e3a72f", maroon: "#9b1d3f", green: "#1f8a5b", teal: "#1b9aa0" };

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
  sim.reserveDocks(world.rampSlots.map((slot) => [slot.x, slot.y]));
  fleet.commit();

  status("Warming up traffic");
  const prewarm = Number(params.get("prewarm") || 2700);
  for (let t = 0; t < prewarm; t += 300) {
    sim.advance(300);
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
    overview: () => camPose(-60, -60, 1750, 60, 132),
    yard: () => camPose(-420, -470, 520, 50, 150),
    xray: () => {
      const x = data.xrays[0];
      return camPose(x.x, x.y, 150, 58, 120);
    },
    gates: () => {
      const g = data.portals[0] || data.gates[0];
      return camPose(g.x, g.y, 190, 60, 160);
    },
    booths: () => {
      const b = data.booths[0];
      return camPose(b.x, b.y, 70, 74, THREE.MathUtils.radToDeg(b.h) + 35);
    },
    ramps: () => {
      const s = data.stations.find((st) => st.en.startsWith("Inspection ramps"));
      return camPose(s.x, s.y, 230, 55, 160);
    },
  };

  /* ---------- station labels ---------- */
  const stationObjects = [];
  const lineMat = new THREE.LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.75, depthWrite: false });
  data.stations.forEach((st, index) => {
    const el = document.createElement("button");
    el.className = `station tone-${st.tone}`;
    el.innerHTML = `<span class="num">${st.n}</span><span class="txt"><b>${st.en}</b><i>${st.ar}</i></span>`;
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      focusStation(index);
    });
    const obj = new CSS2DObject(el);
    const height = st.flow === "passenger" ? 30 : 24;
    obj.position.copy(v3(st.x, st.y, height));
    obj.center.set(0.5, 1);
    scene.add(obj);
    const geo = new THREE.BufferGeometry().setFromPoints([v3(st.x, st.y, 0.6), v3(st.x, st.y, height)]);
    const line = new THREE.Line(geo, lineMat);
    scene.add(line);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(2.2, 24), new THREE.MeshBasicMaterial({ color: TONES[st.tone], toneMapped: false, transparent: true, opacity: 0.9, depthWrite: false }));
    dot.rotation.x = -Math.PI / 2;
    dot.position.copy(v3(st.x, st.y, 0.6));
    scene.add(dot);
    stationObjects.push({ st, obj, line, dot, el });
  });

  function focusStation(index) {
    const { st } = stationObjects[index];
    stopTour();
    const dist = st.n === 4 || st.en.includes("parking") ? 520 : st.n === 1 ? 420 : 210;
    flyTo(camPose(st.x, st.y, dist, 56, 145));
    highlightStep(index);
  }
  function highlightStep(index) {
    expanded = stationObjects[index].st.flow;
    document.querySelectorAll(".flow").forEach((el) => el.classList.toggle("collapsed", !el.classList.contains(`flow-${expanded}`)));
    document.querySelectorAll(".step").forEach((el) => el.classList.toggle("on", Number(el.dataset.index) === index));
  }

  /* ---------- process panel ---------- */
  const visible = { inbound: true, outbound: true, passenger: true };
  let expanded = "inbound";
  function renderSteps() {
    const host = $("steps");
    host.innerHTML = "";
    const groups = [
      ["inbound", "Inbound cargo · from Saudi Arabia", "الشاحنات القادمة"],
      ["outbound", "Outbound cargo · to Saudi Arabia", "الشاحنات المغادرة"],
      ["passenger", "Passengers · cars and buses", "المسافرون"],
    ];
    for (const [flow, title, ar] of groups) {
      const section = document.createElement("div");
      section.className = `flow flow-${flow}` + (visible[flow] ? "" : " off") + (expanded === flow ? "" : " collapsed");
      section.innerHTML = `<div class="flow-head"><input type="checkbox" title="Show on map" ${visible[flow] ? "checked" : ""}><span>${title}</span><i>${ar}</i><b class="caret"></b></div>`;
      section.querySelector("input").addEventListener("change", (event) => {
        visible[flow] = event.target.checked;
        applyVisibility();
        section.classList.toggle("off", !visible[flow]);
      });
      section.querySelector(".flow-head").addEventListener("click", (event) => {
        if (event.target.tagName === "INPUT") return;
        expanded = expanded === flow ? null : flow;
        host.querySelectorAll(".flow").forEach((el) => el.classList.toggle("collapsed", !el.classList.contains(`flow-${expanded}`)));
      });
      data.stations.forEach((st, index) => {
        if (st.flow !== flow) return;
        const row = document.createElement("button");
        row.className = `step tone-${st.tone}`;
        row.dataset.index = index;
        row.innerHTML = `<span class="num">${st.n}</span><span class="txt"><b>${st.en}</b><i>${st.ar}</i></span>`;
        row.addEventListener("click", () => focusStation(index));
        section.appendChild(row);
      });
      host.appendChild(section);
    }
  }
  function applyVisibility() {
    for (const { st, obj, line, dot } of stationObjects) {
      const on = visible[st.flow] && showLabels;
      obj.visible = on;
      line.visible = on;
      dot.visible = visible[st.flow];
    }
    for (const flow of Object.keys(visible)) flows.setVisible(flow, visible[flow] && showFlows);
  }
  let showLabels = params.get("labels") !== "0";
  let showFlows = params.get("flows") !== "0";
  renderSteps();
  applyVisibility();
  $("toggle-labels").classList.toggle("on", showLabels);
  $("toggle-flows").classList.toggle("on", showFlows);
  $("toggle-labels").addEventListener("click", () => {
    showLabels = !showLabels;
    $("toggle-labels").classList.toggle("on", showLabels);
    applyVisibility();
  });
  $("toggle-flows").addEventListener("click", () => {
    showFlows = !showFlows;
    $("toggle-flows").classList.toggle("on", showFlows);
    applyVisibility();
  });

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
  $("play").addEventListener("click", () => {
    paused = !paused;
    $("play").classList.toggle("paused", paused);
  });
  document.querySelectorAll("[data-light]").forEach((el) => el.addEventListener("click", () => applyLighting(el.dataset.light)));
  document.querySelectorAll("[data-view]").forEach((el) =>
    el.addEventListener("click", () => {
      stopTour();
      flyTo(VIEWS[el.dataset.view]());
    })
  );

  /* ---------- tour ---------- */
  let tour = null;
  function startTour() {
    stopFollow();
    const order = stationObjects.map((s, i) => i).filter((i) => visible[stationObjects[i].st.flow]);
    tour = { order, k: -1, hold: 0 };
    $("tour").classList.add("on");
    nextTourStop();
  }
  function nextTourStop() {
    tour.k = (tour.k + 1) % tour.order.length;
    const index = tour.order[tour.k];
    const { st } = stationObjects[index];
    const dist = st.n === 4 || st.en.includes("parking") ? 520 : st.n === 1 ? 420 : 220;
    flyTo(camPose(st.x, st.y, dist, 58, 120 + (tour.k % 4) * 25), 3.2);
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
    const candidates = sim.vehicles.filter((v) => v.type === "truck" && v.state === "drive" && Math.hypot(v.x, v.y) < 1500 && v.speed > 2);
    if (candidates.length) select(pick(candidates));
  });
  function renderCard() {
    const v = followed;
    if (!v) return;
    if (v.static) {
      $("vehicle-body").innerHTML = `
        <div class="vc-title">Container truck <span class="tag">${v.where === "yard" ? "Holding yard" : "Inspection ramp"}</span></div>
        <div class="vc-plate">${v.plate}</div>
        <dl><dt>Cargo</dt><dd>${v.cargo}</dd><dt>Status</dt><dd>${v.where === "yard" ? "Parked, awaiting x-ray slot" : "Under physical inspection"}</dd></dl>`;
      return;
    }
    const d = sim.describe(v);
    const plan = d.plan.map((p) => `<li class="${p.state}">${p.label}</li>`).join("");
    $("vehicle-body").innerHTML = `
      <div class="vc-title">${d.title} <span class="tag">${d.speed} km/h</span></div>
      <div class="vc-plate">${d.plate}</div>
      <dl>
        <dt>Route</dt><dd>${d.origin}</dd>
        ${d.cargo ? `<dt>Cargo</dt><dd>${d.cargo}</dd>` : ""}
        ${d.declaration ? `<dt>Declaration</dt><dd>${d.declaration}</dd>` : ""}
        <dt>Status</dt><dd>${d.status}</dd>
        <dt>Time on site</dt><dd>${d.minutes} min</dd>
      </dl>
      <ol class="plan">${plan}</ol>`;
  }

  /* ---------- KPIs ---------- */
  const rampStatic = statics.filter((v) => v.where === "ramp").length;
  const yardStatic = statics.filter((v) => v.where === "yard").length;
  function renderKpis() {
    const k = sim.kpis(yardStatic, world.yardCapacity, rampStatic);
    $("k-trucks").textContent = k.trucksIn;
    $("k-yard").textContent = `${k.yard}`;
    $("k-yard-cap").textContent = `/ ${k.yardCapacity} bays`;
    $("k-yard-bar").style.width = `${Math.min(100, (k.yard / Math.max(1, k.yardCapacity)) * 100)}%`;
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
  }

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
  const intro = params.get("intro") !== "0" && !startView;
  const initial = startView && VIEWS[startView] ? VIEWS[startView]() : VIEWS.overview();
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
    labels.domElement.classList.toggle("far", distance > 1500);
    labels.domElement.classList.toggle("near", distance < 450);

    kpiTimer -= dt;
    if (kpiTimer <= 0) {
      renderKpis();
      renderCard();
      kpiTimer = 0.4;
    }
    composer.render();
    labels.render(scene, camera);
    requestAnimationFrame(frame);
  }
  renderKpis();
  requestAnimationFrame(frame);
  window.__twin = { sim, world, fleet, camera, controls, renderer, flyTo, VIEWS, applyLighting };
}

main().catch((error) => {
  console.error(error);
  status("Could not start: " + error.message);
  $("loader").classList.add("error");
});
