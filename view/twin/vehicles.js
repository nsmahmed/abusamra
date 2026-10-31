import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { containerTexture } from "./textures.js";

/* Vehicle frame: +Z forward, +X left, Y up, origin at the center on the ground. */

function tint(geometry, hex) {
  const color = new THREE.Color(hex);
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function box(w, h, d, x, y, z, hex, rounded = 0) {
  const g = rounded > 0 ? new RoundedBoxGeometry(w, h, d, 1, rounded) : new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tint(g, hex);
}

function axle(width, radius, z, hex = "#161616") {
  const g = new THREE.CylinderGeometry(radius, radius, width, 12);
  g.rotateZ(Math.PI / 2);
  g.translate(0, radius, z);
  return tint(g, hex);
}

function merge(parts) {
  return mergeGeometries(parts.map((p) => {
    for (const key of Object.keys(p.attributes)) if (!["position", "normal", "color", "uv"].includes(key)) p.deleteAttribute(key);
    return p;
  }));
}

const GLASS = "#1b2631";
const DARK = "#202326";
const WHITE = "#ffffff";

function carGeometry() {
  return merge([
    box(1.84, 0.7, 4.5, 0, 0.62, 0, WHITE, 0.16),
    box(1.6, 0.58, 2.4, 0, 1.2, -0.25, GLASS, 0.18),
    box(1.5, 0.08, 2.0, 0, 1.5, -0.3, WHITE),
    box(1.9, 0.18, 0.3, 0, 0.42, 2.18, DARK),
    box(1.9, 0.18, 0.3, 0, 0.42, -2.18, DARK),
    axle(1.86, 0.34, 1.45),
    axle(1.86, 0.34, -1.4),
  ]);
}

function carLights() {
  return merge([
    box(0.38, 0.12, 0.05, 0.62, 0.78, 2.27, "#fff4d6"),
    box(0.38, 0.12, 0.05, -0.62, 0.78, 2.27, "#fff4d6"),
    box(0.36, 0.12, 0.05, 0.64, 0.8, -2.27, "#ff2b2b"),
    box(0.36, 0.12, 0.05, -0.64, 0.8, -2.27, "#ff2b2b"),
  ]);
}

function busGeometry() {
  return merge([
    box(2.5, 2.7, 11.8, 0, 1.75, 0, WHITE, 0.25),
    box(2.54, 0.9, 10.6, 0, 2.15, -0.3, GLASS),
    box(2.2, 1.0, 0.06, 0, 2.2, 5.9, GLASS),
    axle(2.4, 0.5, 3.8),
    axle(2.4, 0.5, -3.4),
  ]);
}

function busLights() {
  return merge([
    box(0.4, 0.15, 0.05, 0.85, 0.75, 5.92, "#fff4d6"),
    box(0.4, 0.15, 0.05, -0.85, 0.75, 5.92, "#fff4d6"),
    box(0.3, 0.3, 0.05, 1.0, 0.9, -5.92, "#ff2b2b"),
    box(0.3, 0.3, 0.05, -1.0, 0.9, -5.92, "#ff2b2b"),
  ]);
}

/* Tractor unit, 6 m long, centered on its own midpoint. */
function tractorGeometry() {
  return merge([
    box(2.5, 2.7, 2.3, 0, 2.15, 1.75, WHITE, 0.12),
    box(2.3, 1.0, 0.05, 0, 2.6, 2.92, GLASS),
    box(0.05, 0.8, 1.0, 1.26, 2.6, 2.1, GLASS),
    box(0.05, 0.8, 1.0, -1.26, 2.6, 2.1, GLASS),
    box(2.45, 0.35, 0.25, 0, 0.75, 2.95, DARK),
    box(1.1, 0.4, 5.8, 0, 0.95, -0.1, DARK),
    box(0.6, 0.55, 1.2, 1.0, 0.95, 0.3, "#9aa3a8"),
    box(1.8, 0.12, 1.4, 0, 1.25, -1.8, "#3a3f44"),
    axle(2.4, 0.52, 2.0),
    axle(2.4, 0.52, -1.5),
    axle(2.4, 0.52, -2.6),
  ]);
}

function tractorLights() {
  return merge([
    box(0.4, 0.16, 0.05, 0.85, 0.95, 3.08, "#fff4d6"),
    box(0.4, 0.16, 0.05, -0.85, 0.95, 3.08, "#fff4d6"),
    box(1.8, 0.08, 0.06, 0, 3.55, 2.88, "#ffb347"),
  ]);
}

/* Trailer, 12.2 m long, centered. */
function trailerChassis() {
  return merge([
    box(1.2, 0.35, 12.0, 0, 1.15, 0, DARK),
    box(2.5, 0.2, 12.1, 0, 1.32, 0, "#2c3034"),
    axle(2.4, 0.52, -3.6),
    axle(2.4, 0.52, -4.9),
    axle(2.4, 0.52, -6.0 + 0.15),
  ]);
}

function containerGeometry() {
  const g = new THREE.BoxGeometry(2.48, 2.6, 12.0);
  g.translate(0, 2.72, 0);
  return g;
}

function tankGeometry() {
  const g = new THREE.CylinderGeometry(1.15, 1.15, 11.4, 18, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 2.65, 0);
  const caps = [new THREE.SphereGeometry(1.15, 16, 8), new THREE.SphereGeometry(1.15, 16, 8)];
  caps[0].scale(1, 1, 0.3).translate(0, 2.65, 5.7);
  caps[1].scale(1, 1, 0.3).translate(0, 2.65, -5.7);
  return mergeGeometries([g, ...caps].map((p) => {
    p.deleteAttribute("uv");
    return p;
  }));
}

function trailerLights() {
  return merge([
    box(0.3, 0.3, 0.05, 1.0, 1.0, -6.08, "#ff2b2b"),
    box(0.3, 0.3, 0.05, -1.0, 1.0, -6.08, "#ff2b2b"),
  ]);
}

const CONTAINER_COLORS = ["#1f5f99", "#b03a2e", "#2e7d4f", "#d35400", "#7f8c8d", "#f4f6f7", "#8e44ad", "#16a085", "#c0392b", "#2c3e50", "#a04000", "#1a5276"];
const CAB_COLORS = ["#f4f6f7", "#f4f6f7", "#d0d3d4", "#c0392b", "#1f618d", "#f39c12", "#1e8449", "#7b241c"];
const CAR_COLORS = ["#f4f6f7", "#f4f6f7", "#f4f6f7", "#d0d3d4", "#17202a", "#5d6d7e", "#a6acaf", "#7b241c", "#1a5276", "#b9770e"];

export const pick = (list) => list[Math.floor(Math.random() * list.length)];

class Pool {
  constructor(scene, geometry, material, capacity, { shadow = true } = {}) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i += 1) this.mesh.setMatrixAt(i, zero);
    scene.add(this.mesh);
  }
}

export class Fleet {
  constructor(scene, { trucks = 1100, cars = 360, buses = 40 } = {}) {
    this.scene = scene;
    const tex = containerTexture();
    tex.repeat.set(4, 1);
    const paint = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
    const chassis = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    const container = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.3 });
    const tank = new THREE.MeshStandardMaterial({ color: "#d5d8dc", roughness: 0.25, metalness: 0.85 });
    this.lightMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

    this.tractor = new Pool(scene, tractorGeometry(), paint, trucks);
    this.tractorLights = new Pool(scene, tractorLights(), this.lightMaterial, trucks, { shadow: false });
    this.chassis = new Pool(scene, trailerChassis(), chassis, trucks);
    this.container = new Pool(scene, containerGeometry(), container, trucks);
    this.tank = new Pool(scene, tankGeometry(), tank, trucks);
    this.trailerLights = new Pool(scene, trailerLights(), this.lightMaterial, trucks, { shadow: false });
    this.car = new Pool(scene, carGeometry(), paint, cars);
    this.carLights = new Pool(scene, carLights(), this.lightMaterial, cars, { shadow: false });
    this.bus = new Pool(scene, busGeometry(), paint, buses);
    this.busLights = new Pool(scene, busLights(), this.lightMaterial, buses, { shadow: false });

    this.free = { truck: [...Array(trucks).keys()].reverse(), car: [...Array(cars).keys()].reverse(), bus: [...Array(buses).keys()].reverse() };
    this.owner = { truck: new Array(trucks), car: new Array(cars), bus: new Array(buses) };
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3(1, 1, 1);
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
  }

  allocate(vehicle) {
    const type = vehicle.type;
    const slot = this.free[type].pop();
    if (slot === undefined) return false;
    vehicle.slot = slot;
    this.owner[type][slot] = vehicle;
    const color = new THREE.Color();
    if (type === "truck") {
      this.tractor.mesh.setColorAt(slot, color.set(vehicle.cab || (vehicle.cab = pick(CAB_COLORS))));
      this.container.mesh.setColorAt(slot, color.set(vehicle.box || (vehicle.box = pick(CONTAINER_COLORS))));
      if (vehicle.tanker === undefined) vehicle.tanker = Math.random() < 0.14;
      this.tractor.mesh.instanceColor.needsUpdate = true;
      this.container.mesh.instanceColor.needsUpdate = true;
    } else if (type === "car") {
      this.car.mesh.setColorAt(slot, color.set(vehicle.color || (vehicle.color = pick(CAR_COLORS))));
      this.car.mesh.instanceColor.needsUpdate = true;
    } else {
      this.bus.mesh.setColorAt(slot, color.set(vehicle.color || (vehicle.color = Math.random() < 0.5 ? "#f4f6f7" : "#7a1631")));
      this.bus.mesh.instanceColor.needsUpdate = true;
    }
    return true;
  }

  release(vehicle) {
    const type = vehicle.type;
    if (vehicle.slot === undefined) return;
    const slot = vehicle.slot;
    const pools = type === "truck" ? [this.tractor, this.tractorLights, this.chassis, this.container, this.tank, this.trailerLights] : type === "car" ? [this.car, this.carLights] : [this.bus, this.busLights];
    for (const pool of pools) pool.mesh.setMatrixAt(slot, this.zero);
    this.owner[type][slot] = undefined;
    this.free[type].push(slot);
    vehicle.slot = undefined;
  }

  compose(x, z, yaw, scale = 1) {
    this.p.set(x, 0.17, z);
    this.q.setFromAxisAngle(this.up, yaw);
    this.s.setScalar(scale);
    return this.m.compose(this.p, this.q, this.s);
  }

  /* Place a vehicle. Poses are world X/Z and yaw (rotation about Y). */
  place(vehicle, pose) {
    const slot = vehicle.slot;
    if (slot === undefined) return;
    if (vehicle.type === "truck") {
      const tm = this.compose(pose.cx, pose.cz, pose.cyaw);
      this.tractor.mesh.setMatrixAt(slot, tm);
      this.tractorLights.mesh.setMatrixAt(slot, tm);
      const rm = this.compose(pose.tx, pose.tz, pose.tyaw);
      this.chassis.mesh.setMatrixAt(slot, rm);
      this.trailerLights.mesh.setMatrixAt(slot, rm);
      this.container.mesh.setMatrixAt(slot, vehicle.tanker ? this.zero : rm);
      this.tank.mesh.setMatrixAt(slot, vehicle.tanker ? rm : this.zero);
    } else if (vehicle.type === "car") {
      const m = this.compose(pose.cx, pose.cz, pose.cyaw, vehicle.scale || 1);
      this.car.mesh.setMatrixAt(slot, m);
      this.carLights.mesh.setMatrixAt(slot, m);
    } else {
      const m = this.compose(pose.cx, pose.cz, pose.cyaw);
      this.bus.mesh.setMatrixAt(slot, m);
      this.busLights.mesh.setMatrixAt(slot, m);
    }
  }

  commit() {
    for (const pool of [this.tractor, this.tractorLights, this.chassis, this.container, this.tank, this.trailerLights, this.car, this.carLights, this.bus, this.busLights]) {
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  pickables() {
    return [this.tractor.mesh, this.container.mesh, this.tank.mesh, this.chassis.mesh, this.car.mesh, this.bus.mesh];
  }

  ownerOf(mesh, instanceId) {
    if (mesh === this.car.mesh) return this.owner.car[instanceId];
    if (mesh === this.bus.mesh) return this.owner.bus[instanceId];
    return this.owner.truck[instanceId];
  }
}

export const VEHICLE_SPECS = {
  car: { length: 4.6, width: 1.9, front: 2.3, vmax: [7, 11, 22], accel: 2.6 },
  bus: { length: 11.8, width: 2.55, front: 5.9, vmax: [5, 9, 18], accel: 1.4 },
  truck: { length: 17.0, width: 2.55, front: 8.6, vmax: [4.5, 8.5, 16], accel: 1.1 },
};
