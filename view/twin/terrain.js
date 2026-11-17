import * as THREE from "three";

/* The desert floor. Nothing is streamed and no photograph is shown: two small tone maps in
   assets/ (a heavily smoothed colour reference of the real terrain, near and far) say where the
   ground is pale sand, rusty sabkha or sea, and the shader builds the surface itself on top of
   that: sharp procedural grain at every zoom, and animated water where the Gulf of Salwa is.
   One mesh, four small textures, loaded once before the scene opens. */

const load = (loader, url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));

export async function buildGround(scene, { noise, waterNormal, anisotropy = 4 } = {}) {
  const base = new URL("./assets/", import.meta.url).href;
  const meta = await (await fetch(base + "ground.json")).json();
  const loader = new THREE.TextureLoader();
  const [near, far, nearWater, farWater] = await Promise.all([
    load(loader, base + "ground-near.jpg"),
    load(loader, base + "ground-far.jpg"),
    load(loader, base + "ground-near-water.png"),
    load(loader, base + "ground-far-water.png"),
  ]);
  for (const t of [near, far]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = anisotropy;
  }
  const rect = (m) => new THREE.Vector4(m.minX, m.minY, m.maxX - m.minX, m.maxY - m.minY);
  const sand = new THREE.Color().setRGB(meta.far.sand[0] / 255, meta.far.sand[1] / 255, meta.far.sand[2] / 255, THREE.SRGBColorSpace);
  const uniforms = {
    tNear: { value: near },
    tFar: { value: far },
    tNearWater: { value: nearWater },
    tFarWater: { value: farWater },
    tGrain: { value: noise },
    tWaves: { value: waterNormal },
    uNear: { value: rect(meta.near) },
    uFar: { value: rect(meta.far) },
    uSand: { value: sand },
    /* The reference tones are already sunlit, so as a surface colour they need lifting. */
    uGain: { value: new THREE.Vector3(1.58, 1.48, 1.34) },
    uTime: { value: 0 },
  };

  const material = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGroundPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(position, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vGroundPos;
        uniform sampler2D tNear, tFar, tNearWater, tFarWater, tGrain, tWaves;
        uniform vec4 uNear, uFar;
        uniform vec3 uSand, uGain;
        uniform float uTime;
        float groundWater = 0.0;`
      )
      .replace(
        "#include <map_fragment>",
        `vec2 gp = vec2(vGroundPos.x, -vGroundPos.z);
        float dist = length(vViewPosition);
        /* The colour reference is soft by design. Pushing the lookup around with noise gives
           its patches ragged, natural edges, and the unsharp step below restores local contrast. */
        vec2 warp = (texture2D(tGrain, gp / 2600.0).rg - 0.71) * 170.0 + (texture2D(tGrain, gp.yx / 430.0).gr - 0.71) * 34.0;
        vec2 uvN = (gp + warp - uNear.xy) / uNear.zw;
        vec2 uvF = (gp + warp * 2.0 - uFar.xy) / uFar.zw;
        vec2 eN = min(uvN, 1.0 - uvN);
        vec2 eF = min(uvF, 1.0 - uvF);
        float inNear = smoothstep(0.0, 0.07, min(eN.x, eN.y));
        float inFar = smoothstep(0.0, 0.1, min(eF.x, eF.y));
        vec3 nearC = texture2D(tNear, uvN).rgb;
        nearC += (nearC - texture2D(tNear, uvN, 3.5).rgb) * 0.9;
        vec3 farC = texture2D(tFar, uvF).rgb;
        farC += (farC - texture2D(tFar, uvF, 2.5).rgb) * 0.6;
        vec3 tone = mix(uSand, max(farC, 0.0), inFar);
        tone = mix(tone, max(nearC, 0.0), inNear);
        /* Keep the murkiest patches from going muddy: everything leans a little toward sand. */
        tone = mix(tone, uSand, 0.2);
        groundWater = mix(texture2D(tFarWater, uvF).r * inFar, texture2D(tNearWater, uvN).r, inNear);
        groundWater = smoothstep(0.35, 0.65, groundWater);

        /* Sand grain in four octaves, from pebbles to dune-sized mottling. Each octave is sized
           to stay a few pixels wide over the range where it shows, then fades before it could
           shimmer, so the ground reads crisp from the roadside to the high overview. */
        float nA = texture2D(tGrain, gp / 21.0).r - 0.71;
        float nB = texture2D(tGrain, gp.yx / 137.0).g - 0.71;
        float nC = texture2D(tGrain, gp / 830.0 + 0.37).r - 0.71;
        float nD = texture2D(tGrain, gp.yx / 5200.0 + 0.61).g - 0.71;
        float grain = 1.0
          + nA * 1.5 * (1.0 - smoothstep(20.0, 170.0, dist))
          + nB * 1.5 * (1.0 - smoothstep(140.0, 1000.0, dist)) * smoothstep(4.0, 30.0, dist)
          + nC * 1.3 * (1.0 - smoothstep(900.0, 6000.0, dist))
          + nD * 1.0;
        vec3 land = tone * uGain * clamp(grain, 0.55, 1.5);
        /* Wind-drift: a faint warm and cool streaking across the open desert. */
        land *= mix(vec3(0.97, 1.0, 1.04), vec3(1.03, 1.0, 0.95), clamp(0.5 + nD * 3.0, 0.0, 1.0));

        vec3 sea = vec3(0.012, 0.105, 0.16) + tone * 1.3;
        diffuseColor.rgb *= mix(land, sea, groundWater);`
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.17, groundWater);")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        if (groundWater > 0.01) {
          vec2 wp = vec2(vGroundPos.x, vGroundPos.z);
          vec2 w1 = texture2D(tWaves, wp / 95.0 + uTime * vec2(0.006, 0.004)).xy * 2.0 - 1.0;
          vec2 w2 = texture2D(tWaves, wp / 41.0 - uTime * vec2(0.005, 0.008)).xy * 2.0 - 1.0;
          float calm = 1.0 - smoothstep(500.0, 3500.0, length(vViewPosition));
          vec3 wn = normalize(vec3((w1.x + w2.x) * 0.1 * calm, 1.0, (w1.y + w2.y) * 0.1 * calm));
          normal = normalize(mix(normal, normalize((viewMatrix * vec4(wn, 0.0)).xyz), groundWater));
        }`
      );
  };
  material.customProgramCacheKey = () => "abu-samra-ground";

  const size = 110000;
  const geo = new THREE.PlaneGeometry(size, size);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set((meta.far.minX + meta.far.maxX) / 2, 0, -(meta.far.minY + meta.far.maxY) / 2);
  mesh.receiveShadow = true;
  mesh.renderOrder = -2;
  scene.add(mesh);
  return { mesh, uniforms };
}
