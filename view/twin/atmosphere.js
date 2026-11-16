import * as THREE from "three";

/* Sky, sun and air. Each preset is a flat set of numbers and colours; switching presets blends
   every value over a couple of seconds, so the port slides from afternoon into night instead of
   cutting. One directional light serves as sun by day and moon by night. */

export const PRESETS = {
  day: {
    clock: 10.5,
    elevation: 46, azimuth: 222, disc: 1, glow: 0.55, stars: 0,
    zenith: "#2a66bd", horizon: "#c4d6e4", below: "#d9cdb6",
    sunColor: "#fff0d6", sun: 3.5, hemiSky: "#e4e6ea", hemiGround: "#cfa877", hemi: 0.72,
    fog: "#d5dadb", fogNear: 3800, fogFar: 24000,
    exposure: 0.72, env: 0.6, bloom: 0.14, threshold: 1.0, radius: 0.5,
    night: 0, saturation: 1.12, contrast: 1.06, vignette: 0.28, tint: "#fff8ec",
  },
  sunset: {
    clock: 17.2,
    elevation: 13, azimuth: 262, disc: 1, glow: 1.15, stars: 0,
    zenith: "#27447f", horizon: "#f3a86b", below: "#c98f62",
    sunColor: "#ffbe85", sun: 5.6, hemiSky: "#a9bdf0", hemiGround: "#c08e60", hemi: 1.1,
    fog: "#e3a777", fogNear: 2600, fogFar: 21000,
    exposure: 0.7, env: 0.7, bloom: 0.26, threshold: 1.0, radius: 0.6,
    night: 0.2, saturation: 1.1, contrast: 1.06, vignette: 0.34, tint: "#fff6ea",
  },
  night: {
    clock: 21.7,
    elevation: 52, azimuth: 150, disc: 0.5, glow: 0.2, stars: 1,
    zenith: "#02050c", horizon: "#16264a", below: "#070b14",
    sunColor: "#9db7ee", sun: 0.62, hemiSky: "#3c5391", hemiGround: "#1a1a26", hemi: 0.55,
    fog: "#0c1528", fogNear: 2200, fogFar: 17000,
    exposure: 0.95, env: 0.2, bloom: 0.78, threshold: 0.6, radius: 0.72,
    night: 1, saturation: 1.12, contrast: 1.1, vignette: 0.48, tint: "#eef3ff",
  },
};

const COLOR_KEYS = ["zenith", "horizon", "below", "sunColor", "hemiSky", "hemiGround", "fog", "tint"];

const SKY_VERTEX = `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const SKY_FRAGMENT = `
  uniform vec3 uZenith, uHorizon, uBelow, uSunDir, uSunColor;
  uniform float uStars, uGlow, uDisc, uTime;
  varying vec3 vDir;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.4));
    col = mix(col, uBelow, smoothstep(0.0, -0.12, h));
    float sd = max(dot(d, normalize(uSunDir)), 0.0);
    /* Warm scattering around the sun, strongest along the horizon. */
    float low = exp(-abs(h) * 5.0);
    col += uSunColor * uGlow * (pow(sd, 6.0) * 0.26 * (0.4 + low) + pow(sd, 80.0) * 0.6);
    col += uSunColor * uDisc * smoothstep(0.99955, 0.9998, sd) * 28.0;
    if (uStars > 0.01 && h > 0.0) {
      vec3 p = d * 170.0;
      vec3 c = floor(p);
      float s = hash(c);
      vec3 o = (vec3(hash(c + 1.3), hash(c + 2.7), hash(c + 4.1)) - 0.5) * 0.6;
      float star = step(0.9, s) * smoothstep(0.11, 0.0, length(fract(p) - 0.5 - o));
      float twinkle = 0.65 + 0.35 * sin(uTime * 2.2 + s * 80.0);
      col += vec3(0.85, 0.92, 1.0) * star * twinkle * uStars * smoothstep(0.02, 0.3, h) * (0.6 + 2.4 * fract(s * 37.0));
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.uniforms = {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uBelow: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uStars: { value: 0 },
      uGlow: { value: 0 },
      uDisc: { value: 0 },
      uTime: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    const geo = new THREE.SphereGeometry(1, 48, 24);
    this.dome = new THREE.Mesh(geo, material);
    this.dome.scale.setScalar(30000);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.envScene = new THREE.Scene();
    const envDome = new THREE.Mesh(geo, material);
    envDome.scale.setScalar(100);
    this.envScene.add(envDome);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = null;

    this.sun = new THREE.DirectionalLight("#ffffff", 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0003;
    this.hemi = new THREE.HemisphereLight("#ffffff", "#ffffff", 0.6);
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.Fog("#dfe3e4", 4000, 24000);

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.name = "day";
    this.now = this.resolve(PRESETS.day);
    this.from = null;
    this.to = null;
    this.t = 1;
    this.duration = 2.4;
    this.envTimer = 0;
    this.shadowSize = 0;
  }

  resolve(preset) {
    const out = {};
    for (const [key, value] of Object.entries(preset)) out[key] = COLOR_KEYS.includes(key) ? new THREE.Color(value) : value;
    return out;
  }

  set(name, instant = false) {
    this.name = name;
    this.to = this.resolve(PRESETS[name]);
    if (instant) {
      this.now = this.to;
      this.t = 1;
      this.apply();
      this.bakeEnvironment();
      return;
    }
    this.from = { ...this.now };
    for (const key of COLOR_KEYS) this.from[key] = this.now[key].clone();
    /* Swing the light the short way round the compass. */
    let turn = this.to.azimuth - this.from.azimuth;
    turn = ((turn + 540) % 360) - 180;
    this.to.azimuth = this.from.azimuth + turn;
    this.t = 0;
  }

  apply() {
    const v = this.now;
    const u = this.uniforms;
    const phi = THREE.MathUtils.degToRad(90 - v.elevation);
    const theta = THREE.MathUtils.degToRad(180 - v.azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.uSunDir.value.copy(this.sunDir);
    u.uZenith.value.copy(v.zenith);
    u.uHorizon.value.copy(v.horizon);
    u.uBelow.value.copy(v.below);
    u.uSunColor.value.copy(v.sunColor);
    u.uStars.value = v.stars;
    u.uGlow.value = v.glow;
    u.uDisc.value = v.disc;
    this.sun.color.copy(v.sunColor);
    this.sun.intensity = v.sun;
    this.hemi.color.copy(v.hemiSky);
    this.hemi.groundColor.copy(v.hemiGround);
    this.hemi.intensity = v.hemi;
    this.scene.fog.color.copy(v.fog);
    this.scene.fog.near = v.fogNear;
    this.scene.fog.far = v.fogFar;
    this.scene.environmentIntensity = v.env;
    this.renderer.toneMappingExposure = v.exposure;
  }

  bakeEnvironment() {
    const next = this.pmrem.fromScene(this.envScene, 0.03);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = next;
    this.scene.environment = next.texture;
  }

  /* Returns true while a blend is running, so the caller can push values that depend on it. */
  update(dt, time, camera, focus, distance) {
    this.uniforms.uTime.value = time;
    this.dome.position.copy(camera.position);
    let changed = false;
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.duration);
      const k = this.t * this.t * (3 - 2 * this.t);
      const out = {};
      for (const key of Object.keys(this.to)) {
        if (COLOR_KEYS.includes(key)) out[key] = this.from[key].clone().lerp(this.to[key], k);
        else out[key] = this.from[key] + (this.to[key] - this.from[key]) * k;
      }
      this.now = out;
      this.apply();
      this.envTimer -= dt;
      if (this.envTimer <= 0 || this.t >= 1) {
        this.bakeEnvironment();
        this.envTimer = 0.3;
      }
      changed = true;
    }
    /* The shadow frustum follows the camera focus and widens with the view. */
    const size = THREE.MathUtils.clamp(distance * 0.75, 90, 1700);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 2500);
    if (Math.abs(this.shadowSize - size) > 1) {
      this.shadowSize = size;
      const cam = this.sun.shadow.camera;
      cam.left = -size;
      cam.right = size;
      cam.top = size;
      cam.bottom = -size;
      cam.near = 100;
      cam.far = 5200;
      cam.updateProjectionMatrix();
      this.sun.shadow.normalBias = size / 900;
    }
    return changed;
  }
}
