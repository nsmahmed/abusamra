import * as THREE from "three";
import { dedupe, offsetLine } from "./world.js";

/* Data overlays that sit on top of the physical model: station beacons and the route trace of
   the selected vehicle. All of them write no depth and include the log-depth chunks so they
   sort correctly against the scene. */

const VERT = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying float vDist;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const frag = (body) => `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uTime, uNight, uBoost, uSeed;
  varying vec2 vUv;
  varying float vDist;
  void main() {
    #include <logdepthbuf_fragment>
    ${body}
  }`;

const overlayMaterial = (uniforms, body, extra = {}) =>
  new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag(body),
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    ...extra,
  });

/* A soft column of light over each station with slow rings spreading on the ground. */
export function buildBeacons(scene, stations, tones) {
  const shared = { uTime: { value: 0 }, uNight: { value: 0 } };
  const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
  pillarGeo.translate(0, 0.5, 0);
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  ringGeo.rotateX(-Math.PI / 2);
  const items = stations.map((st, index) => {
    const uniforms = { ...shared, uColor: { value: new THREE.Color(tones[st.tone] || "#ffffff") }, uBoost: { value: 0 }, uSeed: { value: index * 0.37 } };
    const pillar = new THREE.Mesh(
      pillarGeo,
      overlayMaterial(
        uniforms,
        `float rise = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 2.2);
         float a = rise * (0.2 + 0.22 * uNight + 0.3 * uBoost);
         a *= smoothstep(60.0, 260.0, vDist);
         gl_FragColor = vec4(uColor * (1.25 + 0.6 * uNight), a);`
      )
    );
    const height = st.flow === "passenger" ? 30 : 24;
    pillar.scale.set(1.3, height, 1.3);
    pillar.position.set(st.x, 0.5, -st.y);
    pillar.renderOrder = 7;
    const ring = new THREE.Mesh(
      ringGeo,
      overlayMaterial(
        uniforms,
        `float d = length(vUv - 0.5) * 2.0;
         float t = fract(uTime * 0.32 + uSeed);
         float wave = smoothstep(0.07, 0.0, abs(d - t)) * (1.0 - t);
         float core = smoothstep(0.2, 0.17, d) * smoothstep(0.1, 0.13, d);
         float disc = smoothstep(0.1, 0.0, d) * 0.9;
         float a = (wave * 0.75 + core + disc) * step(d, 1.0);
         gl_FragColor = vec4(uColor * 1.35, a * (0.85 + 0.15 * uBoost));`
      )
    );
    const r = 15;
    ring.scale.set(r, 1, r);
    ring.position.set(st.x, 0.62, -st.y);
    ring.renderOrder = 6;
    scene.add(pillar, ring);
    return { pillar, ring, uniforms, height };
  });
  return {
    items,
    shared,
    setVisible(index, on) {
      items[index].pillar.visible = on;
      items[index].ring.visible = on;
    },
    setActive(index) {
      items.forEach((item, i) => (item.uniforms.uBoost.value = i === index ? 1 : 0));
    },
  };
}

/* The road still ahead of the selected vehicle, drawn as a marching dashed ribbon. */
export function buildRouteTrace(scene) {
  const uniforms = { uTime: { value: 0 }, uNight: { value: 0 }, uBoost: { value: 0 }, uSeed: { value: 0 }, uColor: { value: new THREE.Color("#ffd27a") } };
  const material = overlayMaterial(
    uniforms,
    `float s = vUv.x;
     if (s < uBoost) discard;
     float across = abs(vUv.y * 2.0 - 1.0);
     float edge = 1.0 - smoothstep(0.55, 1.0, across);
     float dash = step(0.5, fract((s - uTime * 9.0) / 9.0));
     float near = 1.0 - smoothstep(0.0, 900.0, s - uBoost);
     float a = edge * (0.35 + 0.65 * dash) * (0.25 + 0.75 * near);
     gl_FragColor = vec4(uColor * 1.5, a * 0.95);`
  );
  let mesh = null;
  return {
    uniforms,
    show(route) {
      this.hide();
      const pts = [];
      let last = -1e9;
      for (let i = 0; i < route.x.length; i += 1) {
        if (route.cum[i] - last < 2 && i < route.x.length - 1) continue;
        last = route.cum[i];
        pts.push([route.x[i], route.y[i], route.cum[i]]);
      }
      const P = dedupe(pts);
      const L = offsetLine(P, 0.9);
      const R = offsetLine(P, -0.9);
      const pos = [];
      const uv = [];
      const idx = [];
      for (let k = 0; k < P.length; k += 1) {
        pos.push(L[k][0], 0.58, -L[k][1], R[k][0], 0.58, -R[k][1]);
        uv.push(P[k][2], 0, P[k][2], 1);
        if (k < P.length - 1) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      mesh = new THREE.Mesh(g, material);
      mesh.renderOrder = 8;
      mesh.frustumCulled = false;
      scene.add(mesh);
    },
    progress(s) {
      uniforms.uBoost.value = s;
    },
    hide() {
      if (!mesh) return;
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    },
  };
}
