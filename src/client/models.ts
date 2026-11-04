// Placeholder models built from primitives: floating guns and item pickups.
// Guns point along +X (local "forward"), with +Y up.

import * as THREE from 'three';
import type { ItemKind } from '../sim';

const mat = (color: number, emissive = 0x000000, metal = 0.6) =>
  new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.35, metalness: metal });

const box = (x: number, y: number, z: number, m: THREE.Material, px = 0, py = 0, pz = 0) => {
  const b = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), m);
  b.position.set(px, py, pz);
  return b;
};

const tube = (r: number, length: number, m: THREE.Material, px = 0, py = 0, pz = 0) => {
  const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, length, 14), m);
  c.rotation.z = -Math.PI / 2; // along +X
  c.position.set(px, py, pz);
  return c;
};

/** Gun model for weapon slot index (see WEAPON_IDS). */
export function makeGun(weapon: number): THREE.Group {
  const g = new THREE.Group();
  const dark = mat(0x2a2f3a);
  switch (weapon) {
    case 0: { // plasma rifle: blue
      const body = mat(0x3a6fd0, 0x0a1a40);
      g.add(box(0.55, 0.12, 0.1, body, 0.05), box(0.18, 0.16, 0.06, dark, -0.1, -0.1), tube(0.035, 0.25, mat(0x9fe6ff, 0x3aa0ff), 0.38));
      break;
    }
    case 1: { // plasma pistol: green, stubby
      const body = mat(0x4fa84a, 0x0c2a0a);
      g.add(box(0.28, 0.12, 0.09, body, 0.04), box(0.1, 0.16, 0.06, dark, -0.04, -0.1), tube(0.04, 0.08, mat(0xc8ff9a, 0x60ff40), 0.21));
      break;
    }
    case 2: { // red plasma rifle
      const body = mat(0xc8382a, 0x400a05);
      g.add(box(0.6, 0.11, 0.1, body, 0.05), box(0.18, 0.16, 0.06, dark, -0.1, -0.1), tube(0.03, 0.3, mat(0xffb0a0, 0xff3a20), 0.42));
      break;
    }
    case 3: { // fuel rod launcher: big green tube
      const body = mat(0x3c6b2a, 0x0a2008, 0.4);
      g.add(tube(0.12, 0.95, body, 0.1), tube(0.09, 0.08, mat(0xb8ff7a, 0x6aff2a), 0.6), box(0.2, 0.18, 0.08, dark, -0.05, -0.17));
      break;
    }
    case 4: { // plasma bolt cannon: heavy magenta barrel
      const body = mat(0x6a2a6a, 0x200a20);
      g.add(box(0.65, 0.14, 0.12, body, 0.1), tube(0.07, 0.35, mat(0xff9af0, 0xff3df0), 0.55),
        box(0.16, 0.1, 0.1, mat(0xff3df0, 0x801a70), 0.0, 0.11), box(0.16, 0.16, 0.07, dark, -0.12, -0.11));
      break;
    }
    case 5: { // Laconic Laser: absurdly big, red
      const body = mat(0x3a3a44, 0x0a0a0a, 0.8);
      const glow = mat(0xff5a4a, 0xff1a0a);
      g.add(box(1.0, 0.22, 0.2, body, 0.15), tube(0.12, 0.5, glow, 0.8), tube(0.05, 0.9, glow, 0.2, 0.16),
        box(0.2, 0.2, 0.08, dark, -0.15, -0.18));
      break;
    }
    case 6: { // Grav Mallet: a long handle and a heavy glowing head
      const head = mat(0x5a5f6e, 0x0a0a14, 0.8);
      const glow = mat(0x9ad0ff, 0x3a8aff);
      g.add(tube(0.035, 0.9, mat(0x3a2a1a, 0x000000, 0.2), 0.1));
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.36, 0.3), head);
      h.position.set(0.6, 0, 0);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.03, 8, 20), glow);
      ring.position.set(0.72, 0, 0);
      ring.rotation.y = Math.PI / 2;
      g.add(h, ring);
      break;
    }
    default: { // hover gun (debug)
      g.add(box(0.3, 0.12, 0.1, mat(0xb03aa0, 0x400a3a)), tube(0.05, 0.1, mat(0xffa8f0, 0xff5ee8), 0.2));
    }
  }
  return g;
}

const ITEM_WEAPON: Partial<Record<ItemKind, number>> = { rifle: 0, pistol: 1, redRifle: 2, launcher: 3, cannon: 4, laconic: 5, hammer: 6 };

/** Floating pickup model (about 0.6 m across). */
export function makePickup(item: ItemKind): THREE.Group {
  const g = new THREE.Group();
  const w = ITEM_WEAPON[item];
  if (w !== undefined) {
    const gun = makeGun(w);
    gun.scale.setScalar(1.3);
    g.add(gun);
    return g;
  }
  switch (item) {
    case 'health': {
      const red = mat(0xe03030, 0x601010, 0.2);
      g.add(box(0.45, 0.45, 0.45, mat(0xf2f2f2, 0x222222, 0.1)), box(0.47, 0.1, 0.3, red), box(0.47, 0.3, 0.1, red),
        box(0.3, 0.1, 0.47, red), box(0.1, 0.3, 0.47, red));
      break;
    }
    case 'sticky':
    case 'bounce': {
      const c = item === 'sticky' ? 0x7fb6ff : 0xffd23a;
      const m = mat(c, c, 0.3);
      m.emissiveIntensity = 0.5;
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), m);
        s.position.set(Math.cos((i * 2 * Math.PI) / 3) * 0.17, 0, Math.sin((i * 2 * Math.PI) / 3) * 0.17);
        g.add(s);
      }
      break;
    }
    case 'jetpack': {
      const grey = mat(0x8a909c);
      const flame = mat(0xff9a3a, 0xff5a10, 0.2);
      g.add(box(0.2, 0.45, 0.4, grey));
      for (const z of [-0.14, 0.14]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 12), grey);
        t.position.set(-0.12, 0, z);
        const n = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.12, 12), flame);
        n.position.set(-0.12, -0.3, z);
        n.rotation.x = Math.PI;
        g.add(t, n);
      }
      break;
    }
  }
  return g;
}

export const ITEM_NAMES: Record<ItemKind, string> = {
  health: 'Health', sticky: 'Sticky grenades', bounce: 'Bouncing grenades', redRifle: 'Red Plasma Rifle',
  launcher: 'Fuel Rod Launcher', cannon: 'Plasma Bolt Cannon', laconic: 'Laconic Laser', hammer: 'Grav Mallet', rifle: 'Plasma Rifle', pistol: 'Plasma Pistol', jetpack: 'Jetpack',
};
