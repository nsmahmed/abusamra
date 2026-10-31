import * as THREE from "three";

function canvas(size, draw) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  draw(c.getContext("2d"), size);
  return c;
}

function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function texture(c, repeat = true, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function noiseTexture() {
  const r = rand(7);
  const c = canvas(256, (ctx, n) => {
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i += 1) {
      const v = 110 + r() * 145;
      const w = 110 + r() * 145;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = w;
      img.data[i * 4 + 2] = (v + w) / 2;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.globalAlpha = 0.6;
    ctx.filter = "blur(1.5px)";
    for (const dx of [-n, 0, n]) for (const dy of [-n, 0, n]) ctx.drawImage(ctx.canvas, dx, dy);
  });
  return texture(c, true, false);
}

export function asphaltTexture() {
  const r = rand(11);
  const c = canvas(512, (ctx, n) => {
    ctx.fillStyle = "#5e6064";
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 26000; i += 1) {
      const g = 62 + r() * 72;
      ctx.fillStyle = `rgba(${g},${g},${g + 4},${0.25 + r() * 0.35})`;
      ctx.fillRect(r() * n, r() * n, 1 + r() * 2, 1 + r() * 2);
    }
    for (let i = 0; i < 40; i += 1) {
      ctx.fillStyle = `rgba(30,30,32,${0.04 + r() * 0.06})`;
      ctx.beginPath();
      ctx.ellipse(r() * n, r() * n, 20 + r() * 70, 10 + r() * 40, r() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  return texture(c);
}

export function dirtTexture() {
  const r = rand(5);
  const c = canvas(256, (ctx, n) => {
    ctx.fillStyle = "#c7a77b";
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 9000; i += 1) {
      const g = r();
      ctx.fillStyle = `rgba(${150 + g * 70},${120 + g * 60},${85 + g * 50},0.5)`;
      ctx.fillRect(r() * n, r() * n, 2, 2);
    }
  });
  return texture(c);
}

export function concreteTexture() {
  const r = rand(3);
  const c = canvas(256, (ctx, n) => {
    ctx.fillStyle = "#d4cfc4";
    ctx.fillRect(0, 0, n, n);
    for (let i = 0; i < 6000; i += 1) {
      const g = 180 + r() * 50;
      ctx.fillStyle = `rgba(${g},${g - 4},${g - 12},0.45)`;
      ctx.fillRect(r() * n, r() * n, 2, 2);
    }
    ctx.strokeStyle = "rgba(120,115,105,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, n, n);
  });
  return texture(c);
}

/** One wall module, 4 m wide and 3.6 m tall: plaster with a glazed window band. */
export function wallTextures() {
  const draw = (lit) => (ctx, n) => {
    ctx.fillStyle = lit ? "#000" : "#e9e0cf";
    ctx.fillRect(0, 0, n, n);
    if (!lit) {
      ctx.fillStyle = "#ddd2bd";
      ctx.fillRect(0, n * 0.9, n, n * 0.1);
    }
    const top = n * 0.28;
    const h = n * 0.42;
    ctx.fillStyle = lit ? "#ffd59a" : "#33495a";
    ctx.fillRect(n * 0.06, top, n * 0.88, h);
    if (!lit) {
      const g = ctx.createLinearGradient(0, top, 0, top + h);
      g.addColorStop(0, "rgba(190,215,235,0.55)");
      g.addColorStop(0.5, "rgba(90,120,145,0.1)");
      g.addColorStop(1, "rgba(40,60,75,0.3)");
      ctx.fillStyle = g;
      ctx.fillRect(n * 0.06, top, n * 0.88, h);
    }
    ctx.fillStyle = lit ? "#000" : "#c9bda5";
    ctx.fillRect(n * 0.49, top, n * 0.02, h);
  };
  const day = texture(canvas(128, draw(false)));
  const night = texture(canvas(128, draw(true)));
  return { day, night };
}

export function stripeTexture(a = "#c0392b", b = "#ffffff", count = 8) {
  const c = canvas(128, (ctx, n) => {
    for (let i = 0; i < count; i += 1) {
      ctx.fillStyle = i % 2 ? b : a;
      ctx.fillRect((i * n) / count, 0, n / count + 1, n);
    }
  });
  return texture(c);
}

export function hazardTexture() {
  const c = canvas(128, (ctx, n) => {
    ctx.fillStyle = "#f2c12e";
    ctx.fillRect(0, 0, n, n);
    ctx.fillStyle = "#1d1d1d";
    for (let i = -n; i < n * 2; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 16, 0);
      ctx.lineTo(i + 16 - n, n);
      ctx.lineTo(i - n, n);
      ctx.closePath();
      ctx.fill();
    }
  });
  return texture(c);
}

export function containerTexture() {
  const c = canvas(128, (ctx, n) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, n, n);
    for (let x = 0; x < n; x += 8) {
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(x, 0, 3, n);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(x + 4, 0, 1, n);
    }
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, n, 4);
    ctx.fillRect(0, n - 4, n, 4);
  });
  return texture(c);
}

export function signTexture(lines, { bg = "#7a1631", fg = "#ffffff", width = 512, height = 128 } = {}) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const size = lines.length > 1 ? height * 0.34 : height * 0.5;
  lines.forEach((line, i) => {
    ctx.font = `700 ${size}px "Segoe UI", "Noto Kufi Arabic", sans-serif`;
    ctx.fillText(line, width / 2, (height / (lines.length + 1)) * (i + 1) + (lines.length > 1 ? (i === 0 ? 4 : -4) : 0));
  });
  return texture(c, false);
}

export function glowTexture(color = "255,214,150") {
  const c = canvas(128, (ctx, n) => {
    const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, `rgba(${color},0.9)`);
    g.addColorStop(0.35, `rgba(${color},0.35)`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, n, n);
  });
  return texture(c, false);
}

export function waterNormalTexture() {
  const r = rand(19);
  const n = 256;
  const heights = new Float32Array(n * n);
  for (let k = 0; k < 40; k += 1) {
    const fx = Math.floor(1 + r() * 7);
    const fy = Math.floor(1 + r() * 7);
    const ph = r() * Math.PI * 2;
    const amp = 1 / (fx + fy);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        heights[y * n + x] += amp * Math.sin(((fx * x + fy * y) / n) * Math.PI * 2 + ph);
      }
    }
  }
  const c = canvas(n, (ctx) => {
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const dx = heights[y * n + ((x + 1) % n)] - heights[y * n + ((x - 1 + n) % n)];
        const dy = heights[((y + 1) % n) * n + x] - heights[((y - 1 + n) % n) * n + x];
        const i = (y * n + x) * 4;
        img.data[i] = 128 + dx * 90;
        img.data[i + 1] = 128 + dy * 90;
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
  return texture(c, true, false);
}

export function frondTexture() {
  const c = canvas(128, (ctx, n) => {
    ctx.clearRect(0, 0, n, n);
    ctx.translate(n / 2, 0);
    ctx.strokeStyle = "#5d6b2c";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, n);
    ctx.stroke();
    for (let y = 4; y < n; y += 5) {
      const len = (n / 2 - 4) * Math.sin((y / n) * Math.PI) + 4;
      ctx.strokeStyle = y % 2 ? "#6f8136" : "#55692a";
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(-len, y + 10);
      ctx.moveTo(0, y);
      ctx.lineTo(len, y + 10);
      ctx.stroke();
    }
  });
  return texture(c, false);
}
