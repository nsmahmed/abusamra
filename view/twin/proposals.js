import * as THREE from "three";

/* What a scenario proposes is drawn apart from what stands today: proposed or closed parking
   stalls as glowing outlines on the ground, proposed structures as translucent blueprints with
   crisp edges. Nothing here casts shadows or takes part in the simulation. */

let stallTexture = null;
function outlineTexture() {
  if (stallTexture) return stallTexture;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(255,255,255,0.22)";
  g.fillRect(6, 6, 52, 244);
  g.strokeStyle = "#fff";
  g.lineWidth = 6;
  g.beginPath();
  g.roundRect(6, 6, 52, 244, 10);
  g.stroke();
  stallTexture = new THREE.CanvasTexture(c);
  stallTexture.colorSpace = THREE.SRGBColorSpace;
  stallTexture.anisotropy = 4;
  return stallTexture;
}

/* One flat outline per stall ({x, y, h} truck centre and heading, local metres). set(i, colour)
   shows stall i in that colour; set(i, null) hides it. */
export function stallOverlay(scene, stalls, { width = 2.9, length = 17.6, height = 0.42, opacity = 0.9, fill = false } = {}) {
  const geo = new THREE.PlaneGeometry(width, length);
  geo.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: fill ? null : outlineTexture(),
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, stalls.length));
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();
  const shown = new Array(stalls.length).fill(null);
  stalls.forEach((s, i) => {
    mesh.setMatrixAt(i, zero);
    mesh.setColorAt(i, color.set("#ffffff"));
  });
  scene.add(mesh);
  return {
    mesh,
    material,
    set(i, hex) {
      if (shown[i] === hex) return;
      shown[i] = hex;
      const s = stalls[i];
      if (!hex) {
        mesh.setMatrixAt(i, zero);
      } else {
        const yaw = Math.atan2(Math.sin(s.h), -Math.cos(s.h));
        q.setFromAxisAngle(up, yaw);
        m.compose(new THREE.Vector3(s.x, height, -s.y), q, one);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, color.set(hex));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}

/* Turn a built structure into a blueprint: translucent faces and bright edges. */
export function ghostify(group, hex = "#5fe0d8") {
  const faces = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const edges = new THREE.LineBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(1.3), transparent: true, opacity: 0.95, toneMapped: false });
  const meshes = [];
  group.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  for (const o of meshes) {
    o.material = faces;
    o.castShadow = false;
    o.receiveShadow = false;
    o.renderOrder = 5;
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 25), edges);
    line.position.copy(o.position);
    line.rotation.copy(o.rotation);
    line.scale.copy(o.scale);
    line.renderOrder = 6;
    o.parent.add(line);
  }
  return { faces, edges };
}
