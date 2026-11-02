import * as THREE from 'three';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

/** Floor deck panel: one tile = 5 m. */
export function deckTexture(): THREE.Texture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#3d4a45';
  g.fillRect(0, 0, 256, 256);
  // subtle noise
  for (let i = 0; i < 1600; i++) {
    const v = 50 + Math.random() * 30;
    g.fillStyle = `rgba(${v},${v + 12},${v + 6},0.25)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  g.strokeStyle = '#26302d';
  g.lineWidth = 6;
  g.strokeRect(0, 0, 256, 256);
  g.strokeStyle = '#56645e';
  g.lineWidth = 2;
  g.strokeRect(8, 8, 240, 240);
  g.fillStyle = '#6d7d76';
  for (const [x, y] of [[20, 20], [236, 20], [20, 236], [236, 236]]) {
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function wallTexture(): THREE.Texture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#56606e';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#4a5360';
  for (let y = 0; y < 256; y += 32) g.fillRect(0, y, 256, 3);
  g.fillStyle = '#c9a43a';
  g.fillRect(0, 240, 256, 16);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function crateTexture(): THREE.Texture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#7a6d5a';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#4b4134';
  g.lineWidth = 8;
  g.strokeRect(4, 4, 120, 120);
  g.strokeStyle = '#d0a040';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(0, 64); g.lineTo(128, 64);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function ballTexture(): THREE.Texture {
  const [c, g] = canvas(128, 64);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? '#d8d8d0' : '#d05030';
    g.fillRect(i * 16, 0, 16, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft radial glow for plasma sprites. */
export function glowTexture(): THREE.Texture {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.25)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Banded gas giant (original, procedural). */
export function planetTexture(): THREE.Texture {
  const [c, g] = canvas(512, 256);
  const bands = ['#c9b08a', '#a8865e', '#e0cfa8', '#8f6c4c', '#d4bc94', '#b39470', '#efe2c4', '#9c7a58'];
  let y = 0;
  let i = 0;
  while (y < 256) {
    const h = 8 + Math.random() * 26;
    g.fillStyle = bands[i++ % bands.length];
    g.fillRect(0, y, 512, h);
    y += h;
  }
  g.globalAlpha = 0.25;
  for (let k = 0; k < 300; k++) {
    g.fillStyle = Math.random() < 0.5 ? '#fff4dc' : '#6b4d33';
    g.fillRect(Math.random() * 512, Math.random() * 256, 20 + Math.random() * 60, 1 + Math.random() * 3);
  }
  g.globalAlpha = 1;
  g.fillStyle = '#b0563a';
  g.beginPath();
  g.ellipse(330, 150, 26, 12, 0, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
