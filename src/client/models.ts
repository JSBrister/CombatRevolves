// Placeholder models built from primitives: floating guns and item pickups.
// Guns point along +X (local "forward"), with +Y up.

import * as THREE from 'three';
import { WEAPON_IDS, type ItemKind, type WeaponId } from '../sim';

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

/**
 * A flag on a pole (the pole along +Y from the origin), in a team's colour, glowing a little.
 * The cloth is the child named 'cloth' (wave it by turning it about the pole).
 */
export function makeFlag(color: number, poleH = 2.6, clothW = 1.3): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, poleH, 10), mat(0xe0e4ea, 0x202020, 0.8));
  pole.position.y = poleH / 2;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), mat(0xffe680, 0x6a5a10, 0.9));
  knob.position.y = poleH + 0.06;
  // the cloth, hinged at the pole: a few segments so it can ripple
  const cloth = new THREE.Group();
  cloth.name = 'cloth';
  cloth.position.y = poleH - 0.4;
  const geo = new THREE.PlaneGeometry(clothW, clothW * 0.62, 8, 1);
  geo.translate(clothW / 2, 0, 0);
  const sheet = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, side: THREE.DoubleSide, roughness: 0.6 }));
  sheet.name = 'sheet';
  cloth.add(sheet);
  g.add(pole, knob, cloth);
  return g;
}

/** Ripple a flag made by makeFlag (t in seconds). */
export function waveFlag(flag: THREE.Object3D, t: number, amount = 1) {
  const cloth = flag.getObjectByName('cloth');
  const sheet = flag.getObjectByName('sheet') as THREE.Mesh | undefined;
  if (!cloth || !sheet) return;
  cloth.rotation.y = 0.25 * amount * Math.sin(t * 2.1);
  const pa = sheet.geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pa.count; i++) { const x = pa.getX(i); pa.setZ(i, 0.12 * amount * x * Math.sin(t * 6 - x * 4)); }
  pa.needsUpdate = true;
}

/** Gun model for weapon slot index (see WEAPON_IDS); `flagColor`: the flag's colour when the weapon is the flag. */
export function makeGun(weapon: number, flagColor = 0xffffff): THREE.Group {
  const g = new THREE.Group();
  const dark = mat(0x2a2f3a);
  switch (WEAPON_IDS[weapon] as WeaponId) {
    case 'rifle': { // plasma rifle: blue
      const body = mat(0x3a6fd0, 0x0a1a40);
      g.add(box(0.55, 0.12, 0.1, body, 0.05), box(0.18, 0.16, 0.06, dark, -0.1, -0.1), tube(0.035, 0.25, mat(0x9fe6ff, 0x3aa0ff), 0.38));
      break;
    }
    case 'pistol': { // plasma pistol: green, stubby
      const body = mat(0x4fa84a, 0x0c2a0a);
      g.add(box(0.28, 0.12, 0.09, body, 0.04), box(0.1, 0.16, 0.06, dark, -0.04, -0.1), tube(0.04, 0.08, mat(0xc8ff9a, 0x60ff40), 0.21));
      break;
    }
    case 'redRifle': { // red plasma rifle
      const body = mat(0xc8382a, 0x400a05);
      g.add(box(0.6, 0.11, 0.1, body, 0.05), box(0.18, 0.16, 0.06, dark, -0.1, -0.1), tube(0.03, 0.3, mat(0xffb0a0, 0xff3a20), 0.42));
      break;
    }
    case 'launcher': { // fuel rod launcher: big green tube
      const body = mat(0x3c6b2a, 0x0a2008, 0.4);
      g.add(tube(0.12, 0.95, body, 0.1), tube(0.09, 0.08, mat(0xb8ff7a, 0x6aff2a), 0.6), box(0.2, 0.18, 0.08, dark, -0.05, -0.17));
      break;
    }
    case 'cannon': { // plasma bolt cannon: heavy magenta barrel
      const body = mat(0x6a2a6a, 0x200a20);
      g.add(box(0.65, 0.14, 0.12, body, 0.1), tube(0.07, 0.35, mat(0xff9af0, 0xff3df0), 0.55),
        box(0.16, 0.1, 0.1, mat(0xff3df0, 0x801a70), 0.0, 0.11), box(0.16, 0.16, 0.07, dark, -0.12, -0.11));
      break;
    }
    case 'laconic': { // Laconic Laser: absurdly big, red
      const body = mat(0x3a3a44, 0x0a0a0a, 0.8);
      const glow = mat(0xff5a4a, 0xff1a0a);
      g.add(box(1.0, 0.22, 0.2, body, 0.15), tube(0.12, 0.5, glow, 0.8), tube(0.05, 0.9, glow, 0.2, 0.16),
        box(0.2, 0.2, 0.08, dark, -0.15, -0.18));
      break;
    }
    case 'flag': { // the flag, held up and leaning forward over your shoulder
      const f = makeFlag(flagColor, 2.2, 1.1);
      f.scale.setScalar(0.5);
      f.rotation.z = -0.5;
      f.position.set(-0.05, -0.3, 0.08);
      g.add(f);
      break;
    }
    case 'hammer': { // Grav Mallet: a long handle and a heavy glowing head
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
    case 'rocket': { // Torch Rocket: a fat tube with a rocket's nose poking out
      const body = mat(0x6a6a5a, 0x101008, 0.5);
      g.add(tube(0.1, 0.85, body, 0.05), tube(0.115, 0.06, mat(0xffa03a, 0x803a00), 0.45),
        tube(0.06, 0.1, mat(0xd8d0c0), 0.52), box(0.16, 0.18, 0.07, dark, -0.05, -0.16), box(0.12, 0.08, 0.05, dark, 0.15, 0.13));
      break;
    }
    case 'seeker': { // Seeker Swarm: a spiky pink pod of little rockets
      const body = mat(0x7a2a6a, 0x200818, 0.5);
      const tip = mat(0xff9ae8, 0xff3ad8, 0.3);
      g.add(box(0.42, 0.16, 0.14, body, 0.05), box(0.12, 0.16, 0.06, dark, -0.08, -0.13));
      for (let i = 0; i < 5; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.16, 6), tip);
        const a = (i / 5) * Math.PI;
        sp.position.set(0.0 + i * 0.07, 0.1 + 0.02 * Math.sin(a * 2), (i % 2 ? 1 : -1) * 0.03);
        sp.rotation.z = -0.5;
        g.add(sp);
      }
      break;
    }
    case 'scatter': { // Scattergun: a stubby, wide double barrel
      const body = mat(0x6a5a48, 0x140e08, 0.5);
      const glow = mat(0xffc070, 0xff8a20, 0.3);
      g.add(box(0.5, 0.14, 0.16, body, 0.05), tube(0.05, 0.22, glow, 0.38, 0.03, -0.04), tube(0.05, 0.22, glow, 0.38, 0.03, 0.04),
        box(0.16, 0.16, 0.07, dark, -0.12, -0.12), box(0.14, 0.05, 0.14, mat(0x8a7a60), 0.18, -0.09));
      break;
    }
    case 'chaos': { // Roulette Repeater: a drum of mismatched coloured cells
      const body = mat(0x2a2f3a, 0x0a0a10, 0.7);
      g.add(box(0.5, 0.11, 0.1, body, 0.05), tube(0.03, 0.3, mat(0xffffff, 0x8888ff), 0.4), box(0.14, 0.16, 0.06, dark, -0.1, -0.1));
      const cols = [0xff3a3a, 0xffa03a, 0xffe03a, 0x5aff5a, 0x3ab0ff, 0xb05aff];
      cols.forEach((c, i) => {
        const a = (i / cols.length) * Math.PI * 2;
        const cell = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.14, 8), mat(c, c, 0.3));
        cell.rotation.z = -Math.PI / 2;
        cell.position.set(0.08, 0.02 + 0.075 * Math.cos(a), 0.075 * Math.sin(a));
        g.add(cell);
      });
      break;
    }
    case 'revolver': { // a plain old revolver: gunmetal, a fat cylinder, a long barrel
      const steel = mat(0x50555e, 0x050608, 0.85);
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 6), steel);
      cyl.rotation.z = -Math.PI / 2;
      g.add(tube(0.025, 0.32, steel, 0.24, 0.03), cyl, box(0.1, 0.08, 0.06, steel, -0.01, 0.01),
        box(0.07, 0.16, 0.05, mat(0x5a3a22, 0x000000, 0.1), -0.09, -0.08), box(0.03, 0.03, 0.02, steel, 0.38, 0.065));
      break;
    }
    default: { // hover gun (debug)
      g.add(box(0.3, 0.12, 0.1, mat(0xb03aa0, 0x400a3a)), tube(0.05, 0.1, mat(0xffa8f0, 0xff5ee8), 0.2));
    }
  }
  return g;
}

/** Hover-bike, nose along +X, about 2.4 m long; its centre is the collision sphere's. */
export function makeBike(): THREE.Group {
  const g = new THREE.Group();
  const hull = mat(0x3a2a5a, 0x0a0618, 0.7);
  const trim = mat(0x6ad8ff, 0x2a88ff, 0.4);
  const dark = mat(0x22252e);
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.32, 0.8), hull);
  body.position.set(0, 0.05, 0);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.7, 4), hull);
  nose.rotation.z = -Math.PI / 2;
  nose.rotation.x = Math.PI / 4;
  nose.position.set(1.32, 0.05, 0);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.45), dark);
  seat.position.set(-0.2, 0.3, 0);
  g.add(body, nose, seat);
  for (const z of [-0.55, 0.55]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 1.6, 12), hull);
    pod.rotation.z = Math.PI / 2;
    pod.position.set(-0.1, -0.12, z);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 12), trim);
    glow.rotation.z = Math.PI / 2;
    glow.position.set(-0.92, -0.12, z);
    g.add(pod, glow);
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

const ITEM_WEAPON = (item: ItemKind): number | undefined => { const i = WEAPON_IDS.indexOf(item as WeaponId); return i >= 0 ? i : undefined; };

/** Floating pickup model (about 0.6 m across). */
export function makePickup(item: ItemKind): THREE.Group {
  const g = new THREE.Group();
  const w = ITEM_WEAPON(item);
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
    case 'grapple': { // a coil of rope and a three-pronged hook
      const steel = mat(0xc8ccd4, 0x202428, 0.9);
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 8, 20), mat(0xb08a4a, 0x201408, 0.1));
      coil.rotation.x = Math.PI / 2;
      const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 8), steel);
      shank.position.y = 0.25;
      g.add(coil, shank);
      for (let i = 0; i < 3; i++) {
        const prong = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 6, 12, Math.PI), steel);
        prong.position.y = 0.52;
        prong.rotation.y = (i * 2 * Math.PI) / 3;
        g.add(prong);
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
  health: 'Health', sticky: 'Sticky grenades', bounce: 'Bouncing grenades', redRifle: 'Overclocked Plasma Rifle',
  launcher: 'Fuel Rod Launcher', cannon: 'Plasma Bolt Cannon', laconic: 'Laconic Laser', hammer: 'Grav Mallet', rocket: 'Torch Rocket', seeker: 'Seeker Swarm', scatter: 'Scattergun', chaos: 'Roulette Repeater', revolver: 'Revolver', rifle: 'Plasma Rifle', pistol: 'Plasma Pistol', jetpack: 'Jetpack', grapple: 'Grappling Hook',
};
