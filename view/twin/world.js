import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as T from "./textures.js";

/* Local frame from the dataset: x east, y north (meters). Three.js: X = x, Y = up, Z = -y.
   Headings h are clockwise from north; a group with rotation.y = PI - h faces along h,
   and its local +X points to the left of travel. */

const H = {
  dirt: 0.03,
  pad: 0.055,
  road: 0.06,
  mark: 0.085,
};
const MAROON = "#7a1631";

const norm = (x, y) => {
  const n = Math.hypot(x, y);
  return n < 1e-9 ? null : [x / n, y / n];
};

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) out.push(p);
  }
  return out;
}

function offsetLine(points, off) {
  const out = [];
  for (let k = 0; k < points.length; k += 1) {
    const a = k > 0 ? norm(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]) : null;
    const b = k < points.length - 1 ? norm(points[k + 1][0] - points[k][0], points[k + 1][1] - points[k][1]) : null;
    let t = a || b;
    let sc = 1;
    if (a && b) {
      const m = norm(a[0] + b[0], a[1] + b[1]);
      if (m) {
        t = m;
        sc = 1 / Math.max(0.4, m[0] * a[0] + m[1] * a[1]);
      }
    }
    out.push([points[k][0] - t[1] * off * sc, points[k][1] + t[0] * off * sc]);
  }
  return out;
}

function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return cum;
}

function pointAt(points, cum, s) {
  let i = 1;
  while (i < points.length - 1 && cum[i] < s) i += 1;
  const span = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / span));
  const a = points[i - 1];
  const b = points[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, Math.atan2(b[0] - a[0], b[1] - a[1])];
}

function subline(points, cum, s0, s1) {
  const out = [pointAt(points, cum, s0).slice(0, 2)];
  for (let i = 0; i < points.length; i += 1) if (cum[i] > s0 && cum[i] < s1) out.push(points[i]);
  out.push(pointAt(points, cum, s1).slice(0, 2));
  return out;
}

function inside(x, y, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function openRing(ring) {
  const r = ring.slice();
  const a = r[0];
  const b = r[r.length - 1];
  if (r.length > 1 && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) r.pop();
  return r;
}

function signedArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}

/* Local (lx left, lz forward) around an anchor to dataset x/y. */
export function local(anchor, lx, lz) {
  const s = Math.sin(anchor.h);
  const c = Math.cos(anchor.h);
  return [anchor.x - lx * c + lz * s, anchor.y + lx * s + lz * c];
}

/* Flat surfaces in the ground plane with world-scaled UVs. */
class Flat {
  constructor(uvScale = 10) {
    this.p = [];
    this.u = [];
    this.i = [];
    this.scale = uvScale;
  }

  v(x, y, h) {
    this.p.push(x, h, -y);
    this.u.push(x / this.scale, y / this.scale);
    return this.p.length / 3 - 1;
  }

  ribbon(points, width, h) {
    const P = dedupe(points);
    if (P.length < 2) return;
    const L = offsetLine(P, width / 2);
    const R = offsetLine(P, -width / 2);
    const base = this.p.length / 3;
    for (let k = 0; k < P.length; k += 1) {
      this.v(L[k][0], L[k][1], h);
      this.v(R[k][0], R[k][1], h);
    }
    for (let k = 0; k < P.length - 1; k += 1) {
      const a = base + k * 2;
      this.i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  line(points, off, width, h, trimA = 0, trimB = 0, dash = 0, gap = 0) {
    const P = offsetLine(dedupe(points), off);
    if (P.length < 2) return;
    const cum = cumulative(P);
    const start = trimA;
    const end = cum[cum.length - 1] - trimB;
    if (end - start < 1.5) return;
    if (!dash) {
      this.ribbon(subline(P, cum, start, end), width, h);
      return;
    }
    for (let s = start; s < end; s += dash + gap) this.ribbon(subline(P, cum, s, Math.min(end, s + dash)), width, h);
  }

  disc(x, y, r, h, seg = 22) {
    const c = this.v(x, y, h);
    const first = this.p.length / 3;
    for (let k = 0; k < seg; k += 1) {
      const a = (k / seg) * Math.PI * 2;
      this.v(x + Math.cos(a) * r, y + Math.sin(a) * r, h);
    }
    for (let k = 0; k < seg; k += 1) this.i.push(c, first + k, first + ((k + 1) % seg));
  }

  ring(x, y, r0, r1, h, seg = 48) {
    const base = this.p.length / 3;
    for (let k = 0; k <= seg; k += 1) {
      const a = (k / seg) * Math.PI * 2;
      this.v(x + Math.cos(a) * r0, y + Math.sin(a) * r0, h);
      this.v(x + Math.cos(a) * r1, y + Math.sin(a) * r1, h);
    }
    for (let k = 0; k < seg; k += 1) {
      const a = base + k * 2;
      this.i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  poly(ring, h) {
    const r = openRing(ring);
    if (r.length < 3) return;
    const contour = r.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = this.p.length / 3;
    for (const p of r) this.v(p[0], p[1], h);
    for (const t of tris) this.i.push(base + t[0], base + t[1], base + t[2]);
  }

  quad(a, b, c, d, h) {
    const base = this.p.length / 3;
    for (const p of [a, b, c, d]) this.v(p[0], p[1], h);
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  rect(anchor, x0, x1, z0, z1, h) {
    this.quad(local(anchor, x0, z0), local(anchor, x1, z0), local(anchor, x1, z1), local(anchor, x0, z1), h);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.u, 2));
    const n = new Float32Array(this.p.length);
    for (let k = 1; k < n.length; k += 3) n[k] = 1;
    g.setAttribute("normal", new THREE.BufferAttribute(n, 3));
    g.setIndex(this.i);
    return g;
  }

  mesh(material, { shadow = true } = {}) {
    const m = new THREE.Mesh(this.geometry(), material);
    m.receiveShadow = shadow;
    return m;
  }
}

/* Vertical strips along a ring (walls, fascias, fences). */
class Walls {
  constructor() {
    this.p = [];
    this.u = [];
  }

  strip(ring, z0, z1, { module = 4, floor = 3.6, out = 0, closed = true } = {}) {
    const r = closed ? openRing(ring) : ring;
    if (r.length < 2) return;
    const orient = closed ? Math.sign(signedArea(r)) || 1 : 1;
    let u = 0;
    const count = closed ? r.length : r.length - 1;
    for (let i = 0; i < count; i += 1) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.05) continue;
      const nx = ((b[1] - a[1]) / len) * orient * out;
      const ny = (-(b[0] - a[0]) / len) * orient * out;
      const ax = a[0] + nx;
      const ay = a[1] + ny;
      const bx = b[0] + nx;
      const by = b[1] + ny;
      const u0 = u / module;
      const u1 = (u + len) / module;
      const v0 = z0 / floor;
      const v1 = z1 / floor;
      this.p.push(ax, z0, -ay, bx, z0, -by, bx, z1, -by, ax, z0, -ay, bx, z1, -by, ax, z1, -ay);
      this.u.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      u += len;
    }
  }

  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.u, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }
}

class RoadIndex {
  constructor(roads) {
    this.cell = 20;
    this.grid = new Map();
    for (const road of roads) {
      if (road.c === "dirt") continue;
      const hw = road.w / 2;
      for (let i = 1; i < road.p.length; i += 1) {
        const a = road.p[i - 1];
        const b = road.p[i];
        const seg = [a, b, hw];
        for (let gx = Math.floor((Math.min(a[0], b[0]) - hw) / 20); gx <= Math.floor((Math.max(a[0], b[0]) + hw) / 20); gx += 1) {
          for (let gy = Math.floor((Math.min(a[1], b[1]) - hw) / 20); gy <= Math.floor((Math.max(a[1], b[1]) + hw) / 20); gy += 1) {
            const key = gx * 100003 + gy;
            if (!this.grid.has(key)) this.grid.set(key, []);
            this.grid.get(key).push(seg);
          }
        }
      }
    }
  }

  clearance(x, y) {
    const list = this.grid.get(Math.floor(x / 20) * 100003 + Math.floor(y / 20));
    if (!list) return Infinity;
    let best = Infinity;
    for (const [a, b, hw] of list) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const span = dx * dx + dy * dy;
      const t = span ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / span)) : 0;
      const d = Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t) - hw;
      if (d < best) best = d;
    }
    return best;
  }
}

function addDetail(material, noise, scales = [9, 97, 611]) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: noise };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;\nuniform sampler2D detailMap;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float d1 = texture2D(detailMap, vWPos.xz / ${scales[0].toFixed(1)}).r;
        float d2 = texture2D(detailMap, vWPos.xz / ${scales[1].toFixed(1)}).g;
        float d3 = texture2D(detailMap, vWPos.xz / ${scales[2].toFixed(1)}).r;
        diffuseColor.rgb *= (0.78 + 0.32 * d1) * (0.86 + 0.22 * d2) * (0.9 + 0.16 * d3);`
      );
  };
  material.customProgramCacheKey = () => "detail" + scales.join("_");
}

function paintGround(data) {
  const b = data.bounds;
  const W = b.max_x - b.min_x;
  const Hh = b.max_y - b.min_y;
  const cw = 2048;
  const ch = Math.round((cw * Hh) / W);
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d");
  const k = cw / W;
  const P = (p) => [(p[0] - b.min_x) * k, (b.max_y - p[1]) * k];
  const path = (ring) => {
    ctx.beginPath();
    ring.forEach((p, i) => {
      const [x, y] = P(p);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.closePath();
  };
  ctx.fillStyle = "#cfae80";
  ctx.fillRect(0, 0, cw, ch);
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 220; i += 1) {
    const rgb = i % 2 ? "236,214,174" : "196,166,122";
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(${rgb},0.24)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.save();
    ctx.translate(r() * cw, r() * ch);
    ctx.rotate(r() * Math.PI);
    ctx.scale(40 + r() * 180, 20 + r() * 90);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.filter = "blur(6px)";
  for (const ring of data.ground.flats) {
    ctx.fillStyle = "rgba(205,190,160,0.4)";
    path(ring);
    ctx.fill();
  }
  if (data.ground.sea) {
    ctx.strokeStyle = "rgba(226,206,168,0.95)";
    ctx.lineWidth = 34 * k;
    path(data.ground.sea);
    ctx.stroke();
    ctx.fillStyle = "#6d8d8a";
    path(data.ground.sea);
    ctx.fill();
  }
  ctx.filter = "blur(2px)";
  ctx.fillStyle = "rgba(196,180,152,0.9)";
  path(data.ground.port);
  ctx.fill();
  ctx.filter = "none";
  const edge = cw * 0.06;
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
    [0, 0, edge, 0, 0, 0, edge, ch],
    [cw, 0, cw - edge, 0, cw - edge, 0, edge, ch],
    [0, 0, 0, edge, 0, 0, cw, edge],
    [0, ch, 0, ch - edge, 0, ch - edge, cw, edge],
  ]) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(207,174,128,1)");
    g.addColorStop(1, "rgba(207,174,128,0)");
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shapeFrom(ring) {
  const r = openRing(ring);
  return new THREE.Shape(r.map((p) => new THREE.Vector2(p[0], p[1])));
}

function placeGroup(group, anchor) {
  group.position.set(anchor.x, 0, -anchor.y);
  group.rotation.y = Math.PI - anchor.h;
  return group;
}

export function buildWorld(scene, data, renderer) {
  const noise = T.noiseTexture();
  const asphaltTex = T.asphaltTexture();
  const dirtTex = T.dirtTexture();
  const concreteTex = T.concreteTexture();
  const wall = T.wallTextures();
  const stripe = T.stripeTexture();
  const hazard = T.hazardTexture();
  const glow = T.glowTexture();
  const roads = new RoadIndex(data.roads);
  const animated = [];
  const nightMaterials = [];

  const mat = {
    ground: new THREE.MeshStandardMaterial({ map: paintGround(data), roughness: 1 }),
    outer: new THREE.MeshStandardMaterial({ color: "#cfae80", roughness: 1 }),
    asphalt: new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.93, side: THREE.DoubleSide }),
    dirt: new THREE.MeshStandardMaterial({ map: dirtTex, roughness: 1, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
    white: new THREE.MeshStandardMaterial({ color: "#f3f2ec", roughness: 0.6, side: THREE.DoubleSide }),
    yellow: new THREE.MeshStandardMaterial({ color: "#f0b81c", roughness: 0.6, side: THREE.DoubleSide }),
    concrete: new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.85, side: THREE.DoubleSide }),
    yard: new THREE.MeshStandardMaterial({ map: concreteTex, color: "#c9c5bc", roughness: 0.9, side: THREE.DoubleSide }),
    wall: new THREE.MeshStandardMaterial({ map: wall.day, emissiveMap: wall.night, emissive: "#ffffff", emissiveIntensity: 0, roughness: 0.82, side: THREE.DoubleSide }),
    roof: new THREE.MeshStandardMaterial({ map: concreteTex, color: "#e7e3dc", roughness: 0.9, side: THREE.DoubleSide }),
    maroon: new THREE.MeshStandardMaterial({ color: MAROON, roughness: 0.55, side: THREE.DoubleSide }),
    canopy: new THREE.MeshStandardMaterial({ color: "#f5f4f0", roughness: 0.5, metalness: 0.1 }),
    canopyGlow: new THREE.MeshStandardMaterial({ color: "#f2efe8", emissive: "#fff1d2", emissiveIntensity: 0, roughness: 0.7, side: THREE.DoubleSide }),
    steel: new THREE.MeshStandardMaterial({ color: "#c9ced2", roughness: 0.45, metalness: 0.6 }),
    darkSteel: new THREE.MeshStandardMaterial({ color: "#4a5056", roughness: 0.5, metalness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: "#7fb3c4", roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.6, emissive: "#ffe2a8", emissiveIntensity: 0 }),
    hazard: new THREE.MeshStandardMaterial({ map: hazard, roughness: 0.6 }),
    gantry: new THREE.MeshStandardMaterial({ color: "#f1f1ec", roughness: 0.45, metalness: 0.2 }),
    gantryYellow: new THREE.MeshStandardMaterial({ color: "#f2c12e", roughness: 0.5, metalness: 0.2 }),
    portal: new THREE.MeshStandardMaterial({ color: "#f4f6f7", roughness: 0.4 }),
    portalBand: new THREE.MeshStandardMaterial({ color: "#1f6fb2", roughness: 0.4 }),
    stripe: new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.5 }),
    fence: null,
  };
  addDetail(mat.ground, noise);
  addDetail(mat.outer, noise);
  addDetail(mat.concrete, noise, [3, 37, 211]);
  addDetail(mat.yard, noise, [5, 61, 307]);
  nightMaterials.push(mat.wall, mat.canopyGlow, mat.glass);

  /* ---------- ground, sea ---------- */
  const b = data.bounds;
  const W = b.max_x - b.min_x;
  const Hh = b.max_y - b.min_y;
  const groundGeo = new THREE.PlaneGeometry(W, Hh);
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate((b.min_x + b.max_x) / 2, 0, -(b.min_y + b.max_y) / 2);
  const ground = new THREE.Mesh(groundGeo, mat.ground);
  ground.receiveShadow = true;
  scene.add(ground);
  const outerGeo = new THREE.PlaneGeometry(80000, 80000);
  outerGeo.rotateX(-Math.PI / 2);
  outerGeo.translate(0, -0.25, 0);
  const outer = new THREE.Mesh(outerGeo, mat.outer);
  outer.receiveShadow = true;
  scene.add(outer);

  let water = null;
  if (data.ground.sea) {
    const normal = T.waterNormalTexture();
    normal.repeat.set(1 / 70, 1 / 70);
    const seaGeo = new THREE.ShapeGeometry(shapeFrom(data.ground.sea));
    seaGeo.rotateX(-Math.PI / 2);
    seaGeo.translate(0, 0.12, 0);
    water = new THREE.MeshStandardMaterial({ color: "#2a7a8c", roughness: 0.06, metalness: 0.05, normalMap: normal, normalScale: new THREE.Vector2(0.35, 0.35), transparent: true, opacity: 0.93 });
    const sea = new THREE.Mesh(seaGeo, water);
    sea.receiveShadow = true;
    scene.add(sea);
  }

  /* ---------- roads, junctions, markings ---------- */
  const asphalt = new Flat(9);
  const dirt = new Flat(6);
  const white = new Flat(1);
  const yellow = new Flat(1);
  const concrete = new Flat(4);
  const yardPads = new Flat(8);
  for (const road of data.roads) {
    if (road.c === "dirt") dirt.ribbon(road.p, road.w, H.dirt);
    else if (road.c === "aisle") yardPads.ribbon(road.p, road.w, H.road);
    else asphalt.ribbon(road.p, road.w, H.road);
  }
  for (const [x, y, r] of data.joints) asphalt.disc(x, y, r, H.road);

  for (const road of data.roads) {
    if (road.c === "dirt" || road.c === "aisle") continue;
    const pts = road.p;
    let length = 0;
    for (let i = 1; i < pts.length; i += 1) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (length < 18) continue;
    const ta = road.ja ? 11 : 1;
    const tb = road.jb ? 11 : 1;
    const w = road.w;
    if (road.o) {
      if (w >= 6.4) {
        yellow.line(pts, w / 2 - 0.45, 0.22, H.mark, ta, tb);
        white.line(pts, -(w / 2 - 0.45), 0.22, H.mark, ta, tb);
      }
      const lanes = road.l || Math.max(1, Math.round(w / 3.6));
      for (let i = 1; i < lanes; i += 1) white.line(pts, w / 2 - (i * w) / lanes, 0.16, H.mark, ta, tb, 3, 6);
    } else if (w >= 5.5) {
      if (road.c === "major" || road.c === "motorway") {
        yellow.line(pts, 0.18, 0.15, H.mark, ta, tb);
        yellow.line(pts, -0.18, 0.15, H.mark, ta, tb);
        white.line(pts, w / 2 - 0.4, 0.2, H.mark, ta, tb);
        white.line(pts, -(w / 2 - 0.4), 0.2, H.mark, ta, tb);
      } else {
        white.line(pts, 0, 0.15, H.mark, ta, tb, 3, 5);
      }
    }
  }

  /* ---------- yards: pads, lane lines, bay ticks ---------- */
  for (const yard of data.yards) {
    for (const pad of yard.pads) {
      yardPads.poly(pad, H.pad);
      concrete.ribbon([...pad, pad[0]], 0.6, H.pad + 0.02);
    }
    for (const lane of yard.lanes) {
      white.line(lane.p, 3.9, 0.14, H.mark, 2, 2);
      white.line(lane.p, -3.9, 0.14, H.mark, 2, 2);
      const P = dedupe(lane.p);
      const cum = cumulative(P);
      const L = cum[cum.length - 1];
      for (let s = 9; s < L - 4; s += 18.5) {
        const [x, y, h] = pointAt(P, cum, s);
        const a = { x, y, h };
        white.rect(a, -3.9, 3.9, -0.07, 0.07, H.mark);
      }
    }
  }

  /* ---------- helipad ---------- */
  for (const ring of data.ground.helipad) {
    concrete.poly(ring, H.pad + 0.01);
    const r = openRing(ring);
    const cx = r.reduce((s, p) => s + p[0], 0) / r.length;
    const cy = r.reduce((s, p) => s + p[1], 0) / r.length;
    white.ring(cx, cy, 10, 10.8, H.mark + 0.01);
    const a = { x: cx, y: cy, h: 0 };
    white.rect(a, -3, -1.8, -4.5, 4.5, H.mark + 0.01);
    white.rect(a, 1.8, 3, -4.5, 4.5, H.mark + 0.01);
    white.rect(a, -1.8, 1.8, -0.6, 0.6, H.mark + 0.01);
  }

  /* ---------- buildings ---------- */
  const walls = new Walls();
  const fascia = new Walls();
  const hazardWalls = new Walls();
  const roofs = new Flat(6);
  const rooftop = [];
  for (const bld of data.buildings) {
    const ring = bld.ring;
    const floors = Math.max(1, Math.round(bld.h / 3.6));
    const floor = bld.h / floors;
    walls.strip(ring, 0, bld.h + 0.9, { floor });
    roofs.poly(ring, bld.h + 0.25);
    if (bld.role === "terminal") fascia.strip(ring, bld.h + 0.3, bld.h + 0.95, { out: 0.04 });
    if (bld.role === "scanner_hall") hazardWalls.strip(ring, bld.h + 0.1, bld.h + 0.9, { out: 0.04, module: 2, floor: 0.8 });
    const r = openRing(ring);
    const area = Math.abs(signedArea(r));
    if (area > 600) {
      const xs = r.map((p) => p[0]);
      const ys = r.map((p) => p[1]);
      const n = Math.min(10, Math.floor(area / 400));
      for (let k = 0, tries = 0; k < n && tries < 60; tries += 1) {
        const x = Math.min(...xs) + Math.random() * (Math.max(...xs) - Math.min(...xs));
        const y = Math.min(...ys) + Math.random() * (Math.max(...ys) - Math.min(...ys));
        if (!inside(x, y, r)) continue;
        rooftop.push([x, y, bld.h + 0.25]);
        k += 1;
      }
    }
  }
  scene.add(walls.mesh(mat.wall));
  scene.add(fascia.mesh(mat.maroon));
  scene.add(hazardWalls.mesh(mat.hazard));
  const roofMesh = roofs.mesh(mat.roof);
  roofMesh.castShadow = true;
  scene.add(roofMesh);
  if (rooftop.length) {
    const unit = new THREE.BoxGeometry(2.4, 1.3, 1.8);
    unit.translate(0, 0.65, 0);
    const units = new THREE.InstancedMesh(unit, mat.steel, rooftop.length);
    const m = new THREE.Matrix4();
    rooftop.forEach(([x, y, z], i) => {
      m.makeRotationY(Math.random() * Math.PI);
      m.setPosition(x, z, -y);
      units.setMatrixAt(i, m);
    });
    units.castShadow = true;
    scene.add(units);
  }

  /* ---------- canopies, inspection platforms, columns ---------- */
  const columns = [];
  const canopyParts = [];
  const canopyFascia = new Walls();
  const canopyUnder = new Flat(4);
  const docks = [];
  const platformInfo = [];
  for (const cp of data.canopies) {
    const shape = shapeFrom(cp.ring);
    const slab = new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false });
    slab.rotateX(-Math.PI / 2);
    slab.translate(0, cp.h, 0);
    canopyParts.push(slab);
    canopyFascia.strip(cp.ring, cp.h - 0.35, cp.h + 1.15, { out: 0.06, module: 6, floor: 1.5 });
    canopyUnder.poly(cp.ring, cp.h - 0.02);
    const r = openRing(cp.ring);
    if (cp.role === "platform") {
      const dock = new THREE.ExtrudeGeometry(shape, { depth: 1.3, bevelEnabled: false });
      dock.rotateX(-Math.PI / 2);
      docks.push(dock);
      platformInfo.push({ id: cp.id, ring: r });
    }
    const spacing = cp.role === "platform" ? 12 : 10;
    const perimeter = [...r, r[0]];
    const P = dedupe(perimeter);
    const cum = cumulative(P);
    const inset = offsetLine(P, 0);
    for (let s = 0; s < cum[cum.length - 1]; s += spacing) {
      const [x, y] = pointAt(inset, cum, s);
      const cx = r.reduce((a, p) => a + p[0], 0) / r.length;
      const cy = r.reduce((a, p) => a + p[1], 0) / r.length;
      const k = 0.6 / Math.max(1, Math.hypot(cx - x, cy - y));
      const px = x + (cx - x) * k;
      const py = y + (cy - y) * k;
      if (cp.role === "platform" || roads.clearance(px, py) > 0.6) columns.push([px, py, cp.h]);
    }
    if (cp.role !== "platform") {
      const xs = r.map((p) => p[0]);
      const ys = r.map((p) => p[1]);
      for (let x = Math.min(...xs) + 8; x < Math.max(...xs); x += 16) {
        for (let y = Math.min(...ys) + 8; y < Math.max(...ys); y += 16) {
          if (inside(x, y, r) && roads.clearance(x, y) > 0.8) columns.push([x, y, cp.h]);
        }
      }
    }
  }
  if (canopyParts.length) {
    const roof = new THREE.Mesh(mergeGeometries(canopyParts), mat.canopy);
    roof.castShadow = true;
    roof.receiveShadow = true;
    scene.add(roof);
  }
  scene.add(canopyFascia.mesh(mat.maroon));
  const under = canopyUnder.mesh(mat.canopyGlow, { shadow: false });
  scene.add(under);
  if (docks.length) {
    const dockMesh = new THREE.Mesh(mergeGeometries(docks), mat.concrete);
    dockMesh.castShadow = true;
    dockMesh.receiveShadow = true;
    scene.add(dockMesh);
  }
  if (columns.length) {
    const col = new THREE.CylinderGeometry(0.32, 0.32, 1, 10);
    col.translate(0, 0.5, 0);
    const cols = new THREE.InstancedMesh(col, mat.steel, columns.length);
    const m = new THREE.Matrix4();
    columns.forEach(([x, y, h], i) => {
      m.makeScale(1, h, 1);
      m.setPosition(x, 0, -y);
      cols.setMatrixAt(i, m);
    });
    cols.castShadow = true;
    scene.add(cols);
  }

  /* ---------- shared booth parts ---------- */
  const G = {
    island: new THREE.BoxGeometry(1.3, 0.22, 9),
    cabinBase: new THREE.BoxGeometry(1.25, 1.0, 2.1),
    cabinGlass: new THREE.BoxGeometry(1.2, 1.35, 2.05),
    cabinRoof: new THREE.BoxGeometry(1.7, 0.22, 2.6),
    lamp: new THREE.BoxGeometry(0.28, 0.28, 0.28),
    post: new THREE.BoxGeometry(0.34, 1.05, 0.34),
  };
  const signal = {
    green: new THREE.MeshBasicMaterial({ color: new THREE.Color("#2ecc71").multiplyScalar(2.2), toneMapped: false }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color("#ff3b30").multiplyScalar(2.2), toneMapped: false }),
    amber: new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffb020").multiplyScalar(2.4), toneMapped: false }),
  };

  function mesh(geo, material, x, y, z, shadow = true) {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    return m;
  }

  /* A booth on the left of a lane centered at X = cx. front is the vehicle front from its center. */
  function booth(group, cx, laneHalf, front) {
    const ix = cx + laneHalf + 0.75;
    group.add(mesh(G.island, mat.concrete, ix, 0.11, front - 3));
    group.add(mesh(G.cabinBase, mat.gantry, ix, 0.72, front - 1.6));
    const glass = mesh(G.cabinGlass, mat.glass, ix, 1.9, front - 1.6, false);
    group.add(glass);
    group.add(mesh(G.cabinRoof, mat.maroon, ix, 2.69, front - 1.6));
    const light = mesh(G.lamp, signal.green, ix, 2.95, front - 1.6, false);
    group.add(light);
    const pivot = new THREE.Group();
    pivot.position.set(cx + laneHalf + 0.2, 0.95, front + 1.1);
    const armLen = laneHalf * 2 - 0.1;
    const armGeo = new THREE.BoxGeometry(armLen, 0.12, 0.12);
    armGeo.translate(-armLen / 2, 0, 0);
    const arm = new THREE.Mesh(armGeo, mat.stripe);
    arm.castShadow = true;
    pivot.add(arm);
    group.add(pivot);
    group.add(mesh(G.post, mat.gantryYellow, cx + laneHalf + 0.2, 0.52, front + 1.1));
    return { light, pivot, lift: 0 };
  }

  function stopLine(anchor, cx, laneHalf, front) {
    white.rect(anchor, cx - laneHalf + 0.15, cx + laneHalf - 0.15, front + 0.15, front + 0.55, H.mark + 0.005);
  }

  /* ---------- passenger booths ---------- */
  const boothCtl = new Map();
  for (const bt of data.booths) {
    const g = placeGroup(new THREE.Group(), bt);
    const ctl = booth(g, 0, 1.8, 2.3);
    stopLine(bt, 0, 1.8, 2.3);
    scene.add(g);
    boothCtl.set(bt.lane, ctl);
  }
  const staticBooths = [];
  const hall = data.canopies.find((c) => c.role === "customs");
  if (hall) {
    const ring = openRing(hall.ring);
    const placed = [];
    for (const road of data.roads) {
      if (road.c === "dirt" || road.c === "aisle") continue;
      const P = dedupe(road.p);
      const cum = cumulative(P);
      const L = cum[cum.length - 1];
      const hits = [];
      for (let s = 0; s <= L; s += 2) {
        const [x, y, h] = pointAt(P, cum, s);
        if (inside(x, y, ring)) hits.push([x, y, h]);
      }
      if (hits.length < 3) continue;
      const [x, y, h] = hits[Math.floor(hits.length / 2)];
      if (placed.some((p) => Math.hypot(p[0] - x, p[1] - y) < 3.5)) continue;
      placed.push([x, y]);
      const anchor = { x, y, h };
      const g = placeGroup(new THREE.Group(), anchor);
      const half = Math.min(1.8, road.w / 2);
      const ctl = booth(g, 0, half, 2.3);
      stopLine(anchor, 0, half, 2.3);
      scene.add(g);
      staticBooths.push(ctl);
    }
  }

  /* ---------- truck gates (appointment, entrance, release) ---------- */
  const gateCtl = new Map();
  const signs = {
    "inbound-gate": ["بوابات التحقق من الموعد", "APPOINTMENT CHECK"],
    "inbound-release": ["بوابة الإفراج", "RELEASE GATE"],
    "outbound-gate": ["مدخل منطقة الصادر", "OUTBOUND ENTRANCE"],
    "outbound-release": ["بوابة الإفراج", "RELEASE GATE"],
  };
  function canopyOver(g, x0, x1, z0, z1, h, sign) {
    const width = x1 - x0;
    const depth = z1 - z0;
    const slab = mesh(new THREE.BoxGeometry(width, 0.5, depth), mat.canopy, (x0 + x1) / 2, h, (z0 + z1) / 2);
    g.add(slab);
    const band = mesh(new THREE.BoxGeometry(width + 0.3, 1.3, depth + 0.3), mat.maroon, (x0 + x1) / 2, h + 0.65, (z0 + z1) / 2);
    g.add(band);
    if (sign) {
      const tex = T.signTexture(sign, { width: 1024, height: 160 });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(width - 0.4, 14), 1.1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      plane.position.set((x0 + x1) / 2, h + 0.65, z0 - 0.17);
      plane.rotation.y = Math.PI;
      g.add(plane);
    }
    const lightPlane = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.6, depth - 0.6), mat.canopyGlow);
    lightPlane.rotation.x = Math.PI / 2;
    lightPlane.position.set((x0 + x1) / 2, h - 0.26, (z0 + z1) / 2);
    g.add(lightPlane);
  }
  for (const gate of data.gates) {
    const lanes = gate.lanes === 3 ? [0, 4.6, -4.6] : [0, 4.6];
    const g = placeGroup(new THREE.Group(), gate);
    const front = 8.6;
    const x0 = Math.min(...lanes) - 2.6;
    const x1 = Math.max(...lanes) + 3.4;
    asphalt.rect(gate, x0, x1, -16, 16, H.pad);
    const ctl = lanes.map((cx) => {
      stopLine(gate, cx, 1.8, front);
      return booth(g, cx, 1.8, front);
    });
    const cols = [];
    for (const cx of lanes) cols.push(cx + 2.55);
    for (const cx of cols) {
      for (const z of [front - 6.5, front + 2.5]) g.add(mesh(new THREE.CylinderGeometry(0.28, 0.28, 6.2, 10), mat.steel, cx, 3.1, z));
    }
    canopyOver(g, x0 + 0.4, x1 - 0.4, front - 8, front + 4, 6.4, signs[gate.ref]);
    scene.add(g);
    gateCtl.set(gate.ref, ctl);
  }

  /* ---------- radiation portal monitors ---------- */
  const portalCtl = new Map();
  for (const portal of data.portals) {
    const g = placeGroup(new THREE.Group(), portal);
    const lanes = [0, 4.6];
    asphalt.rect(portal, -3.4, 8.2, -14, 14, H.pad);
    const pillar = new THREE.BoxGeometry(0.7, 4.6, 0.55);
    const band = new THREE.BoxGeometry(0.72, 0.5, 0.57);
    const lights = [];
    for (const px of [-2.3, 2.3, 6.9]) {
      g.add(mesh(pillar, mat.portal, px, 2.3, 0));
      g.add(mesh(band, mat.portalBand, px, 3.6, 0));
      g.add(mesh(new THREE.BoxGeometry(1.0, 0.25, 1.2), mat.concrete, px, 0.12, 0));
    }
    for (const cx of lanes) {
      const light = mesh(G.lamp, signal.green, cx + 2.3, 4.85, 0, false);
      g.add(light);
      lights.push(light);
      stopLine(portal, cx, 1.8, 8.9);
    }
    canopyOver(g, -3.0, 7.6, -5, 5, 5.6, ["بوابات كشف المواد المشعة", "RADIATION PORTAL MONITORS"]);
    scene.add(g);
    portalCtl.set(portal.ref, { lights });
  }

  /* ---------- x-ray gantries ---------- */
  const xrayCtl = new Map();
  for (const xr of data.xrays) {
    const g = placeGroup(new THREE.Group(), xr);
    asphalt.rect(xr, -6, 6, -40, 40, H.pad);
    yellow.rect(xr, -5.6, -5.3, -30, 30, H.mark);
    yellow.rect(xr, 5.3, 5.6, -30, 30, H.mark);
    yellow.rect(xr, -5.6, 5.6, -30, -29.7, H.mark);
    yellow.rect(xr, -5.6, 5.6, 29.7, 30, H.mark);
    for (let z = -27; z < 28; z += 4) yellow.rect(xr, -5.3, -4.2, z, z + 0.3, H.mark);
    for (const side of [-1, 1]) {
      g.add(mesh(new THREE.BoxGeometry(1.2, 7.2, 2.0), mat.gantry, side * 3.5, 3.6, 0));
      g.add(mesh(new THREE.BoxGeometry(1.22, 1.3, 2.02), mat.hazard, side * 3.5, 0.65, 0));
      g.add(mesh(new THREE.BoxGeometry(1.4, 0.3, 2.3), mat.concrete, side * 3.5, 0.15, 0));
    }
    g.add(mesh(new THREE.BoxGeometry(8.4, 1.7, 2.2), mat.gantryYellow, 0, 8.05, 0));
    for (const z of [-1.12, 1.12]) {
      const tex = T.signTexture(["فحص بالأشعة السينية", "X-RAY CARGO SCANNER"], { bg: "#1d1d1d", fg: "#f2c12e", width: 1024, height: 200 });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.3), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      sign.position.set(0, 8.05, z);
      if (z < 0) sign.rotation.y = Math.PI;
      g.add(sign);
    }
    const beamMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#ff2d2d").multiplyScalar(2), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 7.0), beamMat);
    beam.position.set(0, 3.6, 0);
    g.add(beam);
    const beacons = [];
    for (const side of [-1, 1]) {
      const beacon = mesh(new THREE.SphereGeometry(0.28, 12, 8), signal.amber, side * 3.5, 9.1, 0, false);
      g.add(beacon);
      beacons.push(beacon);
    }
    g.add(mesh(new THREE.BoxGeometry(2.6, 2.7, 6.2), mat.gantry, 9.5, 1.35, -4));
    g.add(mesh(new THREE.BoxGeometry(2.62, 0.9, 4.5), mat.glass, 9.5, 1.8, -4, false));
    g.add(mesh(new THREE.BoxGeometry(2.9, 0.25, 6.6), mat.maroon, 9.5, 2.82, -4));
    scene.add(g);
    xrayCtl.set(xr.id, { beam, beacons, active: 0 });
  }

  /* ---------- finalize flat layers ---------- */
  const asphaltMesh = asphalt.mesh(mat.asphalt);
  scene.add(asphaltMesh);
  const dirtMesh = dirt.mesh(mat.dirt);
  dirtMesh.renderOrder = -1;
  scene.add(dirtMesh);
  scene.add(white.mesh(mat.white));
  scene.add(yellow.mesh(mat.yellow));
  scene.add(concrete.mesh(mat.concrete));
  scene.add(yardPads.mesh(mat.yard));

  /* ---------- street lights ---------- */
  const lamp = { heads: null, pools: null };
  if (data.lights.length) {
    const pole = new THREE.CylinderGeometry(0.1, 0.16, 11, 6);
    pole.translate(0, 5.5, 0);
    const arm = new THREE.BoxGeometry(2.4, 0.12, 0.12);
    arm.translate(1.2, 10.9, 0);
    const head = new THREE.BoxGeometry(0.95, 0.2, 0.45);
    head.translate(2.25, 10.78, 0);
    const poleMesh = new THREE.InstancedMesh(mergeGeometries([pole, arm]), mat.darkSteel, data.lights.length);
    lamp.headMat = new THREE.MeshBasicMaterial({ color: "#cfd3d6", toneMapped: false });
    lamp.heads = new THREE.InstancedMesh(head, lamp.headMat, data.lights.length);
    const poolGeo = new THREE.PlaneGeometry(20, 20);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate(2.25, 0.16, 0);
    lamp.poolMat = new THREE.MeshBasicMaterial({ map: glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    lamp.pools = new THREE.InstancedMesh(poolGeo, lamp.poolMat, data.lights.length);
    const m = new THREE.Matrix4();
    data.lights.forEach(([x, y, h], i) => {
      m.makeRotationY(Math.PI - h);
      m.setPosition(x, 0, -y);
      poleMesh.setMatrixAt(i, m);
      lamp.heads.setMatrixAt(i, m);
      lamp.pools.setMatrixAt(i, m);
    });
    poleMesh.castShadow = true;
    lamp.pools.visible = false;
    scene.add(poleMesh, lamp.heads, lamp.pools);
  }

  /* ---------- palms ---------- */
  if (data.palms.length) {
    const trunk = new THREE.CylinderGeometry(0.17, 0.26, 1, 7);
    trunk.translate(0, 0.5, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: "#7a6247", roughness: 1 });
    const frond = T.frondTexture();
    const leaves = [];
    for (let k = 0; k < 11; k += 1) {
      const a = (k / 11) * Math.PI * 2 + (k % 2) * 0.2;
      const len = 3.2 + (k % 3) * 0.35;
      const seg = 6;
      const pos = [];
      const uv = [];
      const idx = [];
      for (let i = 0; i <= seg; i += 1) {
        const t = i / seg;
        const r = t * len;
        const y = 0.9 * r * (1 - t) - 0.6 * t * t * len * 0.35;
        const cx = Math.cos(a) * r;
        const cz = Math.sin(a) * r;
        const w = 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
        const sx = -Math.sin(a) * w;
        const sz = Math.cos(a) * w;
        pos.push(cx + sx, y - w * 0.15, cz + sz, cx - sx, y - w * 0.15, cz - sz);
        uv.push(0, t, 1, t);
        if (i < seg) {
          const o = i * 2;
          idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      leaves.push(g);
    }
    const crown = mergeGeometries(leaves);
    const leafMat = new THREE.MeshStandardMaterial({ map: frond, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 });
    const trunks = new THREE.InstancedMesh(trunk, trunkMat, data.palms.length);
    const crowns = new THREE.InstancedMesh(crown, leafMat, data.palms.length);
    crowns.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: frond, alphaTest: 0.45 });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    data.palms.forEach(([x, y], i) => {
      const h = 5.5 + Math.random() * 4.5;
      s.set(1, h, 1);
      p.set(x, 0, -y);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0);
      m.compose(p, q, s);
      trunks.setMatrixAt(i, m);
      const sc = 0.85 + Math.random() * 0.4;
      s.set(sc, sc, sc);
      p.set(x, h, -y);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
      m.compose(p, q, s);
      crowns.setMatrixAt(i, m);
    });
    trunks.castShadow = true;
    crowns.castShadow = true;
    crowns.receiveShadow = true;
    scene.add(trunks, crowns);
  }

  /* ---------- perimeter fence ---------- */
  {
    const fc = document.createElement("canvas");
    fc.width = 64;
    fc.height = 64;
    const fx = fc.getContext("2d");
    fx.strokeStyle = "rgba(200,205,210,1)";
    fx.lineWidth = 3;
    fx.beginPath();
    fx.moveTo(0, 0);
    fx.lineTo(64, 64);
    fx.moveTo(64, 0);
    fx.lineTo(0, 64);
    fx.stroke();
    const ft = new THREE.CanvasTexture(fc);
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping;
    const fenceMat = new THREE.MeshStandardMaterial({ map: ft, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.4, color: "#b6bcc2" });
    const fence = new Walls();
    const posts = [];
    const ring = dedupe([...openRing(data.ground.port), data.ground.port[0]]);
    const cum = cumulative(ring);
    let run = [];
    const flush = () => {
      if (run.length > 1) fence.strip(run, 0, 2.6, { module: 0.35, floor: 0.35, closed: false });
      run = [];
    };
    for (let s = 0; s < cum[cum.length - 1]; s += 3.5) {
      const [x, y] = pointAt(ring, cum, s);
      if (roads.clearance(x, y) < 3) {
        flush();
        continue;
      }
      run.push([x, y]);
      posts.push([x, y]);
    }
    flush();
    const fenceMesh = fence.mesh(fenceMat);
    fenceMesh.castShadow = false;
    scene.add(fenceMesh);
    const post = new THREE.CylinderGeometry(0.05, 0.05, 2.8, 5);
    post.translate(0, 1.4, 0);
    const postMesh = new THREE.InstancedMesh(post, mat.darkSteel, posts.length);
    const m = new THREE.Matrix4();
    posts.forEach(([x, y], i) => {
      m.makeTranslation(x, 0, -y);
      postMesh.setMatrixAt(i, m);
    });
    scene.add(postMesh);
  }

  /* ---------- parked trucks in yards and at the inspection ramps ---------- */
  const activeAisles = new Set();
  for (const route of data.routes) for (const stop of route.stops) if (stop.kind === "yard") activeAisles.add(String(stop.ref));
  const yardSlots = [];
  let yardCapacity = 0;
  for (const yard of data.yards) {
    for (const lane of yard.lanes) {
      const P = dedupe(lane.p);
      const cum = cumulative(P);
      const L = cum[cum.length - 1];
      for (let s = 9.5; s < L - 8; s += 18.5) {
        yardCapacity += 1;
        if (activeAisles.has(String(lane.way))) continue;
        if (Math.random() > 0.64) continue;
        const [x, y, h] = pointAt(P, cum, s);
        yardSlots.push({ x, y, h });
      }
    }
  }
  const rampSlots = [];
  const rampStops = [];
  for (const route of data.routes) {
    const P = route.p;
    const cum = cumulative(P);
    for (const stop of route.stops) if (stop.kind === "ramp") rampStops.push(pointAt(P, cum, stop.s));
  }
  for (const info of platformInfo) {
    const r = info.ring;
    const cx = r.reduce((a, p) => a + p[0], 0) / r.length;
    const cy = r.reduce((a, p) => a + p[1], 0) / r.length;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const [x, y] of r) {
      sxx += (x - cx) ** 2;
      sxy += (x - cx) * (y - cy);
      syy += (y - cy) ** 2;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const along = r.map(([x, y]) => (x - cx) * ux + (y - cy) * uy);
    const across = r.map(([x, y]) => -(x - cx) * uy + (y - cy) * ux);
    const half = (Math.max(...across) - Math.min(...across)) / 2;
    const a0 = Math.min(...along) + 9;
    const a1 = Math.max(...along) - 9;
    const h = Math.atan2(ux, uy);
    for (const side of [-1, 1]) {
      for (let a = a0; a <= a1; a += 18.5) {
        const off = side * (half + 2.1);
        const x = cx + ux * a - uy * off;
        const y = cy + uy * a + ux * off;
        if (rampStops.some((p) => Math.hypot(p[0] - x, p[1] - y) < 14)) continue;
        if (roads.clearance(x, y) < -1.5 && Math.random() < 0.5) continue;
        if (Math.random() > 0.6) continue;
        rampSlots.push({ x, y, h: side > 0 ? h : h + Math.PI });
      }
    }
  }

  return {
    roads,
    boothCtl,
    staticBooths,
    gateCtl,
    portalCtl,
    xrayCtl,
    yardSlots,
    rampSlots,
    yardCapacity,
    water,
    lamp,
    nightMaterials,
    setNight(f) {
      mat.wall.emissiveIntensity = 0.95 * f;
      mat.canopyGlow.emissiveIntensity = 1.1 * f;
      mat.glass.emissiveIntensity = 0.9 * f;
      if (lamp.heads) {
        lamp.headMat.color.set(f > 0.05 ? "#ffd9a0" : "#cfd3d6").multiplyScalar(1 + 5 * f);
        lamp.poolMat.opacity = 0.42 * f;
        lamp.pools.visible = f > 0.02;
      }
    },
    update(t, dt, sim) {
      if (water) water.normalMap.offset.set((t * 0.004) % 1, (t * 0.0025) % 1);
      const now = performance.now();
      for (const [ref, ctl] of boothCtl) {
        const st = sim.station(ref);
        const busy = st && st.busy > 0;
        ctl.light.material = busy ? signal.red : signal.green;
        const target = st && st.openUntil > now ? 1 : 0;
        ctl.lift += (target - ctl.lift) * Math.min(1, dt * 5);
        ctl.pivot.rotation.z = -ctl.lift * 1.35;
      }
      for (const [ref, ctls] of gateCtl) {
        const st = sim.station(ref);
        ctls.forEach((ctl, i) => {
          const busy = st && st.laneBusy && st.laneBusy[i] > 0;
          ctl.light.material = busy ? signal.red : signal.green;
          const target = st && st.laneOpen && st.laneOpen[i] > now ? 1 : 0;
          ctl.lift += (target - ctl.lift) * Math.min(1, dt * 5);
          ctl.pivot.rotation.z = -ctl.lift * 1.35;
        });
      }
      for (const [ref, ctl] of portalCtl) {
        const st = sim.station(ref);
        ctl.lights.forEach((light, i) => {
          light.material = st && st.laneBusy && st.laneBusy[i] > 0 ? (Math.floor(t * 4) % 2 ? signal.amber : signal.red) : signal.green;
        });
      }
      for (const [id, ctl] of xrayCtl) {
        const st = sim.station(id);
        const on = st && st.active > 0;
        const pulse = on ? 0.35 + 0.25 * Math.sin(t * 9) : 0;
        ctl.beam.material.opacity += (pulse - ctl.beam.material.opacity) * Math.min(1, dt * 6);
        ctl.beacons.forEach((b, i) => {
          b.visible = !on || Math.floor(t * 3 + i) % 2 === 0;
        });
      }
    },
  };
}

/* Animated flow ribbons: gold outside the operational zone, green inside, like the GAC route maps. */
export function buildFlows(scene, data) {
  const uniforms = { uTime: { value: 0 } };
  const groups = { inbound: [], outbound: [], passenger: [] };
  const pick = [
    ["inbound", data.routes.find((r) => r.flow === "inbound" && r.stops.some((s) => s.kind === "ramp")) || data.routes.find((r) => r.flow === "inbound")],
    ["outbound", data.routes.find((r) => r.flow === "outbound")],
    ["passenger", data.routes.find((r) => r.flow === "arrival")],
    ["passenger", data.routes.find((r) => r.flow === "departure")],
  ];
  for (const [group, route] of pick) {
    if (!route) continue;
    const P = dedupe(route.p);
    const cum = cumulative(P);
    const gate = route.stops.find((s) => s.kind === "gate" && !String(s.ref).endsWith("release"));
    const release = route.stops.find((s) => String(s.ref).endsWith("release"));
    const L = cum[cum.length - 1];
    let s0 = 0;
    let s1 = L;
    for (let i = 0; i < P.length; i += 1) {
      if (Math.hypot(P[i][0], P[i][1]) < 2000) {
        s0 = Math.max(0, cum[i] - 50);
        break;
      }
    }
    for (let i = P.length - 1; i >= 0; i -= 1) {
      if (Math.hypot(P[i][0], P[i][1]) < 2000) {
        s1 = Math.min(L, cum[i] + 50);
        break;
      }
    }
    const pts = subline(P, cumulative(P), s0, s1);
    const L2 = offsetLine(pts, 1.1);
    const R2 = offsetLine(pts, -1.1);
    const c2 = cumulative(pts);
    const pos = [];
    const uv = [];
    const idx = [];
    for (let k = 0; k < pts.length; k += 1) {
      pos.push(L2[k][0], 0.5, -L2[k][1], R2[k][0], 0.5, -R2[k][1]);
      uv.push(c2[k] + s0, 0, c2[k] + s0, 1);
      if (k < pts.length - 1) {
        const a = k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const passenger = group === "passenger";
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: uniforms.uTime,
        uGate: { value: gate ? gate.s - 20 : -1 },
        uRelease: { value: release ? release.s + 20 : 1e9 },
        uGold: { value: new THREE.Color(passenger ? "#3fd0c9" : "#f5b82e") },
        uGreen: { value: new THREE.Color(passenger ? "#3fd0c9" : "#2fd17a") },
      },
      vertexShader: `
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
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uTime, uGate, uRelease;
        uniform vec3 uGold, uGreen;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          #include <logdepthbuf_fragment>
          float s = vUv.x;
          float across = abs(vUv.y * 2.0 - 1.0);
          float phase = fract((s - uTime * 22.0) / 26.0);
          float chevron = fract(phase + across * 0.12);
          float dash = smoothstep(0.0, 0.08, chevron) * (1.0 - smoothstep(0.42, 0.55, chevron));
          float edge = 1.0 - smoothstep(0.7, 1.0, across);
          vec3 col = (s > uGate && s < uRelease) ? uGreen : uGold;
          float a = edge * (0.12 + 0.88 * dash) * mix(0.18, 1.0, smoothstep(120.0, 700.0, vDist));
          gl_FragColor = vec4(col * (1.1 + 0.8 * dash), a * 0.85);
        }`,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(g, material);
    mesh.renderOrder = 5;
    scene.add(mesh);
    groups[group].push(mesh);
  }
  return {
    uniforms,
    setVisible(group, on) {
      for (const m of groups[group]) m.visible = on;
    },
  };
}
