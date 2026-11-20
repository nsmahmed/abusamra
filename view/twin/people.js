/* Customs inspectors at the ramps: two officers at every bay where a truck is being inspected.
   They stand still and work, as inspectors do, rather than wander:
     - one on the dock at the trailer's rear doors, shining a torch inside and leaning in to look;
     - one beside the trailer with a tablet, writing, then looking up to check the load.
   Uniform as worn at the port: light grey short-sleeved shirt, dark trousers and belt, black
   shoes and a dark navy beret. Skin tones vary; some wear glasses. Life size (1.75 m), next to
   trucks 2.5 m wide and 4 m tall. Body, head and each arm are separate instanced meshes so the
   head can turn and the arms can move without the figure sliding about. */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const SKIN = ["#f0c8a0", "#e2b184", "#d29b6c", "#c08552", "#a8693f", "#8d5530", "#6e4024", "#583218"];
const UNIFORM = { shirt: "#b8bec7", trousers: "#262b36", navy: "#1b2131", black: "#121214" };
const NECK = 1.5;
const SHOULDER = { x: 0.2, y: 1.415 };

const at = (g, x, y, z) => g.translate(x, y, z);
const capsule = (r, len, x, y, z) => at(new THREE.CapsuleGeometry(r, len, 4, 10), x, y, z);
const sphere = (r, sx, sy, sz, x, y, z) => at(new THREE.SphereGeometry(r, 14, 10).scale(sx, sy, sz), x, y, z);
const box = (w, h, d, x, y, z) => at(new THREE.BoxGeometry(w, h, d), x, y, z);
const cyl = (r0, r1, h, sz, x, y, z, seg = 14) => at(new THREE.CylinderGeometry(r0, r1, h, seg).scale(1, 1, sz), x, y, z);
/* a limb segment between two points */
function limb(r, a, b) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, d.length() - 2 * r), 4, 10);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  const m = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(m.x, m.y, m.z);
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/* Body, standing at the origin facing +Z, in metres. The head and arms are separate parts. */
function bodyParts() {
  return {
    trousers: mergeGeometries([
      capsule(0.066, 0.7, -0.088, 0.5, 0),
      capsule(0.066, 0.7, 0.088, 0.5, 0),
      cyl(0.168, 0.16, 0.17, 0.66, 0, 0.9, 0),
    ]),
    black: mergeGeometries([
      sphere(0.07, 0.8, 0.55, 1.9, -0.088, 0.04, 0.045),
      sphere(0.07, 0.8, 0.55, 1.9, 0.088, 0.04, 0.045),
      cyl(0.172, 0.172, 0.045, 0.68, 0, 0.995, 0),
    ]),
    shirt: mergeGeometries([
      cyl(0.19, 0.168, 0.44, 0.62, 0, 1.22, 0),
      sphere(0.19, 1, 0.42, 0.62, 0, 1.44, 0),
      sphere(0.075, 1, 0.9, 1, -SHOULDER.x, SHOULDER.y, 0),
      sphere(0.075, 1, 0.9, 1, SHOULDER.x, SHOULDER.y, 0),
      cyl(0.065, 0.075, 0.05, 1, 0, 1.475, 0),
    ]),
    skin: cyl(0.046, 0.05, 0.1, 1, 0, NECK, 0),
  };
}

/* Head, with its pivot at the top of the neck */
function headParts() {
  const beret = new THREE.CylinderGeometry(0.122, 0.112, 0.06, 16).scale(1.06, 1, 1.1);
  beret.rotateZ(-0.16);
  return {
    skin: mergeGeometries([
      sphere(0.1, 0.9, 1.14, 1, 0, 0.115, 0.01),
      box(0.024, 0.038, 0.03, 0, 0.11, 0.105),
      sphere(0.022, 0.6, 1, 0.8, -0.09, 0.115, 0),
      sphere(0.022, 0.6, 1, 0.8, 0.09, 0.115, 0),
    ]),
    navy: at(beret, 0.014, 0.215, -0.004),
    gold: box(0.032, 0.032, 0.008, 0.055, 0.215, 0.112),
    glasses: mergeGeometries([
      box(0.17, 0.012, 0.012, 0, 0.14, 0.098),
      box(0.062, 0.042, 0.008, -0.04, 0.128, 0.1),
      box(0.062, 0.042, 0.008, 0.04, 0.128, 0.1),
    ]),
  };
}

/* Arms, with the pivot at the shoulder. A short sleeve over the upper arm, bare forearm, hand. */
function armParts(bent) {
  const elbow = V(0, -0.29, 0.01);
  const wrist = bent ? V(0, -0.31, 0.26) : V(0, -0.54, 0.02);
  const hand = bent ? V(0, -0.305, 0.315) : V(0, -0.6, 0.025);
  return {
    shirt: limb(0.062, V(0, 0.01, 0), V(0, -0.16, 0.003)),
    skin: mergeGeometries([limb(0.046, V(0, -0.12, 0.002), elbow), limb(0.04, elbow, wrist), sphere(0.042, 0.8, 1.15, 1, hand.x, hand.y, hand.z)]),
  };
}

export function buildInspectors(scene, bays) {
  const rnd = (() => {
    let s = 20261120;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  })();
  const people = [];
  for (const bay of bays) {
    for (let role = 0; role < 2; role += 1) {
      people.push({
        bay,
        role,
        side: rnd() < 0.5 ? -1 : 1,
        along: -6.2 + (rnd() - 0.5) * 3,
        phase: rnd() * 100,
        rate: 0.8 + rnd() * 0.4,
        skin: SKIN[Math.floor(rnd() * SKIN.length)],
        glasses: rnd() < 0.4,
      });
    }
  }
  const n = people.length;
  const mats = {
    shirt: new THREE.MeshStandardMaterial({ color: UNIFORM.shirt, roughness: 0.85 }),
    trousers: new THREE.MeshStandardMaterial({ color: UNIFORM.trousers, roughness: 0.85 }),
    navy: new THREE.MeshStandardMaterial({ color: UNIFORM.navy, roughness: 0.9 }),
    black: new THREE.MeshStandardMaterial({ color: UNIFORM.black, roughness: 0.5 }),
    gold: new THREE.MeshStandardMaterial({ color: "#c9a44a", roughness: 0.35, metalness: 0.8 }),
    skin: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.65 }),
    glasses: new THREE.MeshStandardMaterial({ color: "#0d0d10", roughness: 0.3 }),
    tablet: new THREE.MeshStandardMaterial({ color: "#1d232c", roughness: 0.4, emissive: "#3a6f8f", emissiveIntensity: 0.35 }),
  };
  const color = new THREE.Color();
  /* one instanced mesh per (part, material); `who` lists the person behind each instance */
  function group(geos, who, skinned = true) {
    const out = [];
    for (const key in geos) {
      const m = new THREE.InstancedMesh(geos[key], mats[key], who.length);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      if (key === "skin" && skinned) {
        who.forEach((p, i) => m.setColorAt(i, color.set(p.skin)));
        m.instanceColor.needsUpdate = true;
      }
      scene.add(m);
      out.push(m);
    }
    return { meshes: out, who };
  }
  const head = headParts();
  const { glasses: glassesGeo, ...headRest } = head;
  const torch = mergeGeometries([cyl(0.018, 0.022, 0.17, 1, 0, 0, 0).rotateX(Math.PI / 2).translate(0, -0.29, 0.36)]);
  const tablet = box(0.2, 0.012, 0.15, 0, 0, 0).rotateX(-0.5).translate(0.075, -0.27, 0.34);
  const role0 = people.filter((p) => p.role === 0);
  const role1 = people.filter((p) => p.role === 1);
  /* each part: its meshes and how to place it (which joint) for a given person */
  const parts = [
    { ...group(bodyParts(), people), joint: "body" },
    { ...group(headRest, people), joint: "head" },
    { ...group({ glasses: glassesGeo }, people.filter((p) => p.glasses)), joint: "head" },
    /* torch-holder: left arm hangs, right arm holds the torch up into the trailer */
    { ...group(armParts(false), role0), joint: "armL" },
    { ...group({ ...armParts(true), black: torch }, role0), joint: "armR" },
    /* tablet-holder: both forearms forward, the tablet in the left hand */
    { ...group({ ...armParts(true), tablet }, role1), joint: "armL" },
    { ...group(armParts(true), role1), joint: "armR" },
  ];
  parts.forEach((part) => part.meshes.forEach((m) => (m.userData.person = true)));

  const root = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, "YXZ");
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const smooth = (x) => x * x * (3 - 2 * x);
  /* a slow back-and-forth between 0 and 1 that dwells at each end */
  const dwell = (t) => smooth(Math.min(1, Math.max(0, Math.sin(t) * 1.4 * 0.5 + 0.5)));
  const joint = (out, x, y, z, yaw, pitch, roll = 0) => {
    e.set(pitch, yaw, roll);
    return out.multiplyMatrices(root, tmp.compose(pos.set(x, y, z), q.setFromEuler(e), one));
  };
  /* the matrices of one person's joints at time t */
  const J = { body: new THREE.Matrix4(), head: new THREE.Matrix4(), armL: new THREE.Matrix4(), armR: new THREE.Matrix4() };
  function pose(p, t) {
    const b = p.bay;
    const fx = Math.sin(b.h);
    const fy = Math.cos(b.h);
    const lx = -fy;
    const ly = fx;
    const k = t * p.rate + p.phase;
    let a;
    let s;
    let z = 0;
    let face;
    if (p.role === 0) {
      a = -10.2;
      s = p.side * 0.5;
      z = 1.3;
      face = Math.atan2(fx, -fy);
    } else {
      a = p.along;
      s = p.side * 2.05;
      face = Math.atan2(-lx * p.side, ly * p.side);
    }
    /* world (x, y) on the map is (x, height, -y) in the scene; a slight breathing sway only */
    pos.set(b.x + fx * a + lx * s, z, -(b.y + fy * a + ly * s));
    e.set(0, face + Math.sin(k * 0.23) * 0.03, Math.sin(k * 0.41) * 0.012);
    root.compose(pos, q.setFromEuler(e), one);
    J.body.copy(root);
    if (p.role === 0) {
      /* leaning in a little, sweeping the torch over the load, head following the beam */
      const sweep = Math.sin(k * 0.55);
      const lift = Math.sin(k * 0.37);
      joint(J.armR, -SHOULDER.x, SHOULDER.y, 0, 0.12 + sweep * 0.32, -0.55 + lift * 0.18);
      joint(J.armL, SHOULDER.x, SHOULDER.y, 0, 0, 0.04, 0.05);
      joint(J.head, 0, NECK + 0.04, 0.01, sweep * 0.32, 0.08 - lift * 0.14);
    } else {
      /* writing on the tablet, then looking up at the trailer, then back down */
      const look = dwell(k * 0.3);
      const write = Math.sin(k * 6) * 0.04 * (1 - look);
      joint(J.armL, SHOULDER.x, SHOULDER.y, 0, -0.42, -0.42 + look * 0.12);
      joint(J.armR, -SHOULDER.x, SHOULDER.y, 0, 0.5 + write, -0.36 + look * 0.16);
      joint(J.head, 0, NECK + 0.04, 0.01, look * Math.sin(k * 0.11) * 0.45, 0.42 - look * 0.6);
    }
    return J;
  }
  const index = new Map(people.map((p, i) => [p, i]));
  const mats4 = people.map(() => ({ body: new THREE.Matrix4(), head: new THREE.Matrix4(), armL: new THREE.Matrix4(), armR: new THREE.Matrix4(), on: false }));
  return {
    meshes: parts.flatMap((part) => part.meshes),
    update(t) {
      for (let i = 0; i < n; i += 1) {
        const p = people[i];
        const slot = mats4[i];
        slot.on = !!p.bay.v;
        if (!slot.on) continue;
        const j = pose(p, t);
        slot.body.copy(j.body);
        slot.head.copy(j.head);
        slot.armL.copy(j.armL);
        slot.armR.copy(j.armR);
      }
      for (const part of parts) {
        part.who.forEach((p, i) => {
          const slot = mats4[index.get(p)];
          const m = slot.on ? slot[part.joint] : hidden;
          for (const mesh of part.meshes) mesh.setMatrixAt(i, m);
        });
        for (const mesh of part.meshes) mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
