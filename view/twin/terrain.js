import * as THREE from "three";

/* Satellite ground. Three nested rings of imagery tiles (port core, study area, far desert) are
   composited into one canvas each and draped on meshes whose vertices sit at the true tile
   corners in the local frame, so the imagery lines up with the surveyed roads and footprints.
   Tiles come through view/serve.py, which caches them on disk; if none can be loaded the
   procedural ground underneath simply stays visible. */

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const rad = (d) => (d * Math.PI) / 180;

function utm(latDeg, lonDeg, zone) {
  const lat = rad(latDeg);
  const dl = rad(lonDeg) - rad(zone * 6 - 183);
  const s = Math.sin(lat);
  const c = Math.cos(lat);
  const t = Math.tan(lat);
  const N = A / Math.sqrt(1 - E2 * s * s);
  const T = t * t;
  const C = EP2 * c * c;
  const a = c * dl;
  const M =
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * lat -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * lat) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * lat) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * lat));
  const x = 500000 + K0 * N * (a + ((1 - T + C) * a ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * a ** 5) / 120);
  const y = K0 * (M + N * t * ((a * a) / 2 + ((5 - T + 9 * C + 4 * C * C) * a ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * a ** 6) / 720));
  return [x, y];
}

const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const lonTile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const latTile = (lat, z) => ((1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2) * 2 ** z;

/* Zoom, and half-size in tiles around the port; each ring is snapped so it nests in the next. */
const RINGS = [
  { z: 17, half: 6 },
  { z: 15, half: 4 },
  { z: 13, half: 4 },
];

export function buildSatellite(scene, origin, { anisotropy = 8, base = "#cdb892", detail = null, onReady } = {}) {
  /* Imagery arrives already sunlit, so as a surface colour it reads dark; lift and warm it. Up
     close, where one pixel covers a metre, a fine grain keeps the sand from looking smeared. */
  const uniforms = { uGain: { value: new THREE.Vector3(1.62, 1.5, 1.36) }, detailMap: { value: detail } };
  const tune = (material) => {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGain = uniforms.uGain;
      shader.uniforms.detailMap = uniforms.detailMap;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSatPos;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSatPos = (modelMatrix * vec4(position, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSatPos;\nuniform vec3 uGain;\nuniform sampler2D detailMap;\nfloat satWater = 0.0;")
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.2, satWater);")
        .replace(
          "#include <map_fragment>",
          `float satNear = 1.0 - smoothstep(90.0, 560.0, length(vViewPosition));
          /* Near the camera the magnified pixels are swapped for a smoothed read of the same
             imagery, and the grain below puts the fine texture back. */
          vec4 satColor = mix(texture2D(map, vMapUv), texture2D(map, vMapUv, 2.6), satNear * 0.9);
          /* Open water is dark and blue in the imagery: give it a clean sea colour and a
             glossy surface so it picks up the sky and the sun. */
          float satLum = dot(satColor.rgb, vec3(0.3, 0.5, 0.2));
          satWater = smoothstep(1.25, 1.9, satColor.b / max(satColor.r, 0.003)) * smoothstep(0.16, 0.05, satLum);
          /* Deep water reads as plain black; anything that dark on the seaward side of the
             coast (the Gulf of Salwa lies north-west of the port) is sea as well. */
          float seaward = dot(vec2(vSatPos.x + 2300.0, -vSatPos.z - 650.0), vec2(-0.526, 0.85));
          satWater = max(satWater, smoothstep(-420.0, -300.0, seaward) * smoothstep(0.04, 0.014, satLum));
          diffuseColor *= satColor;
          diffuseColor.rgb *= uGain;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.13, 0.19) + satColor.rgb * 1.6, satWater);
          #ifdef SAT_DETAIL
            float g1 = texture2D(detailMap, vSatPos.xz / 1.7).r;
            float g2 = texture2D(detailMap, vSatPos.xz / 9.0).g;
            float g3 = texture2D(detailMap, vSatPos.xz / 41.0).r;
            diffuseColor.rgb *= mix(1.0, (0.74 + 0.5 * g1) * (0.8 + 0.4 * g2) * (0.88 + 0.24 * g3), satNear * (1.0 - satWater));
          #endif`
        );
    };
    if (detail) material.defines = { SAT_DETAIL: "" };
    material.customProgramCacheKey = () => "sat" + (detail ? "d" : "");
  };
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const toLocal = (lat, lon) => {
    const [e, n] = utm(lat, lon, origin.utm_zone);
    return [e - origin.easting, n - origin.northing];
  };

  let inner = null;
  const layers = [];
  for (const ring of RINGS) {
    const { z, half } = ring;
    /* Snap to multiples of 4 so this ring's edge is a tile edge two zooms out. */
    const cx = Math.round(lonTile(origin.longitude, z) / 4) * 4;
    const cy = Math.round(latTile(origin.latitude, z) / 4) * 4;
    const x0 = cx - half;
    const y0 = cy - half;
    const n = half * 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n * 256;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = anisotropy;

    const pos = [];
    const uv = [];
    const idx = [];
    for (let j = 0; j <= n; j += 1) {
      for (let i = 0; i <= n; i += 1) {
        const [lx, ly] = toLocal(tileLat(y0 + j, z), tileLon(x0 + i, z));
        pos.push(lx, 0, -ly);
        uv.push(i / n, 1 - j / n);
      }
    }
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        if (inner) {
          const k = 2 ** (inner.z - z);
          const tx = (x0 + i) * k;
          const ty = (y0 + j) * k;
          if (tx >= inner.x0 && tx + k <= inner.x0 + inner.n && ty >= inner.y0 && ty + k <= inner.y0 + inner.n) continue;
        }
        const a = j * (n + 1) + i;
        idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    const normals = new Float32Array(pos.length);
    for (let k = 1; k < normals.length; k += 3) normals[k] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setIndex(idx);
    const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
    tune(material);
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.renderOrder = -2;
    group.add(mesh);
    const layer = { z, x0, y0, n, ctx, texture, dirty: false, pending: n * n };
    layers.push(layer);
    inner = layer;
  }
  /* A skirt far below the horizon tiles keeps the world from ending at the last tile. */
  const far = layers[layers.length - 1];

  const state = { loaded: 0, failed: 0, total: layers.reduce((s, l) => s + l.n * l.n, 0), active: false, done: false };
  const queue = [];
  /* The study-area ring first for quick coverage, then the sharp core, then the far desert. */
  for (const layer of [layers[1], layers[0], layers[2]]) {
    const c = layer.n / 2 - 0.5;
    const cells = [];
    for (let j = 0; j < layer.n; j += 1) for (let i = 0; i < layer.n; i += 1) cells.push([i, j, Math.hypot(i - c, j - c)]);
    cells.sort((p, q) => p[2] - q[2]);
    for (const [i, j] of cells) queue.push([layer, i, j]);
  }
  let cursor = 0;
  const next = () => {
    if (cursor >= queue.length) return;
    if (!state.active && state.failed >= 8 && state.loaded === 0) return;
    const [layer, i, j] = queue[cursor++];
    const img = new Image();
    const settle = (ok) => {
      if (ok) {
        layer.ctx.drawImage(img, i * 256, j * 256, 256, 256);
        layer.dirty = true;
        state.loaded += 1;
        if (!state.active && state.loaded >= 12) {
          state.active = true;
          group.visible = true;
          if (onReady) onReady();
        }
      } else {
        state.failed += 1;
      }
      if (state.loaded + state.failed >= state.total) state.done = true;
      next();
    };
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = `/tiles/sat/${layer.z}/${layer.x0 + i}/${layer.y0 + j}.jpg`;
  };
  for (let k = 0; k < 10; k += 1) next();

  let timer = 0;
  return {
    group,
    state,
    materials: group.children.map((m) => m.material),
    extent: far.n,
    /* Upload freshly drawn tiles a couple of times a second rather than on every arrival. */
    update(dt) {
      timer -= dt;
      if (timer > 0) return;
      timer = state.done ? 1e9 : 0.5;
      for (const layer of layers) {
        if (!layer.dirty) continue;
        layer.dirty = false;
        layer.texture.needsUpdate = true;
      }
    },
  };
}
