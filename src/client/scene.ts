// Static world rendering. Everything here is drawn in the ROTATING frame
// (the level never moves), except `inertial`, a group whose rotation is set
// to -frameAngle every frame so its children (stars, sun, planet, inertial
// trails) are fixed in the non-rotating frame.

import * as THREE from 'three';
import type { Level, SimConfig } from '../sim';
import { ballTexture, crateTexture, deckTexture, glowTexture, planetTexture, wallTexture } from './textures';

export const LAYER_ROT_TRAILS = 1;
export const LAYER_INERTIAL_ONLY = 2;
export const LAYER_SELF = 3;

export class RingScene {
  scene = new THREE.Scene();
  inertial = new THREE.Group(); // fixed in the inertial frame
  level = new THREE.Group();
  glow = glowTexture();
  textures = { deck: deckTexture(), wall: wallTexture(), crate: crateTexture(), ball: ballTexture(), planet: planetTexture() };
  starRadius = 4000;

  constructor() {
    this.scene.background = new THREE.Color(0x02030a);
    this.scene.add(this.inertial, this.level);
    this.scene.add(new THREE.AmbientLight(0x9aa8c0, 0.9));
    // Light from the axis: the "sky" of a ring habitat.
    const axisLight = new THREE.PointLight(0xfff2dd, 1.6, 0, 0);
    this.scene.add(axisLight);
  }

  build(cfg: SimConfig, level: Level) {
    this.level.clear();
    this.inertial.clear();
    const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
    const segs = Math.min(720, Math.max(192, Math.round(R * 2.4)));
    this.starRadius = Math.max(4000, R * 12);
    this.scene.fog = new THREE.Fog(0x0b1020, R * 1.5, R * 7);

    // Floor: inside of a cylinder about Z.
    const deck = this.textures.deck.clone();
    deck.needsUpdate = true;
    deck.repeat.set((2 * Math.PI * R) / 5, (2 * W) / 5);
    const floorGeo = new THREE.CylinderGeometry(R, R, 2 * W, segs, 1, true);
    floorGeo.rotateX(Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ map: deck, side: THREE.BackSide, roughness: 0.85, metalness: 0.2 }));
    this.level.add(floor);

    // Center stripe + edge stripes (painted on, slightly above the floor).
    const stripe = (z: number, w: number, color: number) => {
      const g = new THREE.CylinderGeometry(R - 0.02, R - 0.02, w, segs, 1, true);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, z);
      this.level.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, side: THREE.BackSide, roughness: 0.6 })));
    };
    stripe(0, 0.6, 0xc9a43a);
    stripe(W - 1.5, 0.4, 0x8a96a8);
    stripe(-W + 1.5, 0.4, 0x8a96a8);

    // Spinward chevrons (instanced) every 10 m, pointing in the omega x r direction.
    const chev = new THREE.BufferGeometry();
    chev.setAttribute('position', new THREE.Float32BufferAttribute([1.4, 0, 0, -0.4, 0, -0.9, 0, 0, 0, 1.4, 0, 0, 0, 0, 0, -0.4, 0, 0.9], 3));
    chev.computeVertexNormals();
    const nPer = Math.round((2 * Math.PI * R) / 10);
    const lanes = [-12, 12];
    const inst = new THREE.InstancedMesh(chev, new THREE.MeshBasicMaterial({ color: 0xf2c94c, side: THREE.DoubleSide, fog: true }), nPer * lanes.length);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < nPer; i++) {
      const a = (i / nPer) * Math.PI * 2;
      for (const z of lanes) {
        basisMatrix(m, a, R - 0.03, z);
        inst.setMatrixAt(k++, m);
      }
    }
    this.level.add(inst);

    // Rim walls, one piece per sector so heights can vary (low curbs = you can fall off).
    this.buildWalls(cfg, level.wallPos, 1, segs);
    this.buildWalls(cfg, level.wallNeg, -1, segs);
    const hullGeo = new THREE.CylinderGeometry(R + hull, R + hull, 2 * (W + T), segs, 1, true);
    hullGeo.rotateX(Math.PI / 2);
    this.level.add(new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.9, metalness: 0.5 })));
    // Hull ribs so the spin is visible from outside.
    const ribGeo = new THREE.BoxGeometry(1.2, hull * 1.2, 2 * (W + T) + 1);
    const ribs = new THREE.InstancedMesh(ribGeo, new THREE.MeshStandardMaterial({ color: 0x8a6d2a, roughness: 0.6 }), 24);
    for (let i = 0; i < 24; i++) {
      basisMatrix(m, (i / 24) * Math.PI * 2, R + hull, 0);
      ribs.setMatrixAt(i, m);
    }
    this.level.add(ribs);

    // Obstacles.
    const boxMat = new THREE.MeshStandardMaterial({ map: this.textures.crate, roughness: 0.8 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1a1510 });
    for (const b of level.boxes) {
      const geo = new THREE.BoxGeometry(2 * b.half[0], 2 * b.half[1], 2 * b.half[2]);
      const mesh = new THREE.Mesh(geo, boxMat);
      basisMatrix(m, b.angle, 0, 0);
      mesh.quaternion.setFromRotationMatrix(m);
      mesh.position.set(b.center[0], b.center[1], b.center[2]);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
      this.level.add(mesh);
    }

    // Spawn pads.
    for (const s of level.spawns) {
      const pad = new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), new THREE.MeshBasicMaterial({ color: 0x3fa7ff, transparent: true, opacity: 0.35 }));
      pad.rotateX(-Math.PI / 2);
      const holder = new THREE.Object3D();
      basisMatrix(m, s.angle, R - 0.04, s.z);
      holder.applyMatrix4(m);
      holder.add(pad);
      this.level.add(holder);
    }

    this.buildSky();
  }

  private buildWalls(cfg: SimConfig, heights: number[], sgn: number, segs: number) {
    const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
    const n = heights.length;
    if (!n) return;
    const step = (2 * Math.PI) / n;
    const segsPer = Math.max(4, Math.ceil(segs / n));
    const wallTex = this.textures.wall;
    const tall = new THREE.MeshStandardMaterial({ map: wallTex, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.3 });
    const low = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, side: THREE.DoubleSide, roughness: 0.7, emissive: 0x2a1000 });
    const outerMat = new THREE.MeshStandardMaterial({ color: 0x3a404a, side: THREE.DoubleSide, roughness: 0.9 });
    const topTall = new THREE.MeshStandardMaterial({ color: 0xc9a43a, side: THREE.DoubleSide, emissive: 0x332200 });
    const topLow = new THREE.MeshStandardMaterial({ color: 0xff5a2a, side: THREE.DoubleSide, emissive: 0x551400 }); // hazard: edge of the world
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const h = heights[i];
      const a0 = i * step;
      const isLow = h < cfg.wallHeight * 0.5;
      const inner = new THREE.Mesh(new THREE.RingGeometry(R - h, R, segsPer, 1, a0, step), isLow ? low : tall);
      inner.position.z = sgn * W;
      const outer = new THREE.Mesh(new THREE.RingGeometry(R - h, R + hull, segsPer, 1, a0, step), outerMat);
      outer.position.z = sgn * (W + T);
      // Cylinder theta 0 maps to ring angle -pi/2 after rotateX(pi/2).
      const topGeo = new THREE.CylinderGeometry(R - h, R - h, T, segsPer, 1, true, a0 + Math.PI / 2, step);
      topGeo.rotateX(Math.PI / 2);
      topGeo.translate(0, 0, sgn * (W + T / 2));
      this.level.add(inner, outer, new THREE.Mesh(topGeo, isLow ? topLow : topTall));
      // End cap where this sector meets a lower neighbour.
      for (const [j, edge] of [[(i + 1) % n, a0 + step], [(i + n - 1) % n, a0]] as const) {
        const hj = heights[j];
        if (hj >= h) continue;
        const cap = new THREE.Mesh(new THREE.PlaneGeometry(T, h - hj).rotateY(Math.PI / 2), tall);
        const holder = new THREE.Object3D();
        holder.applyMatrix4(basisMatrix(m, edge, R - (h + hj) / 2, sgn * (W + T / 2)));
        holder.add(cap);
        this.level.add(holder);
      }
    }
  }

  private buildSky() {
    const Rs = this.starRadius;
    // Stars: fixed in the inertial frame.
    const n = 5000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([Rs * s * Math.cos(th), Rs * s * Math.sin(th), Rs * u], i * 3);
      const b = 0.5 + Math.random() * 0.5;
      const tint = Math.random();
      col.set([b * (tint < 0.2 ? 0.8 : 1), b * 0.95, b * (tint > 0.8 ? 0.75 : 1)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    this.inertial.add(stars);

    // Sun, mostly along the axis so the floor is lit everywhere; it still
    // visibly circles in the rotating view.
    const sunDir = new THREE.Vector3(0.45, 0, 1).normalize();
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xfff1c0, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    sun.position.copy(sunDir).multiplyScalar(Rs * 0.9);
    sun.scale.setScalar(Rs * 0.12);
    this.inertial.add(sun);
    const light = new THREE.DirectionalLight(0xfff1d6, 1.3);
    light.position.copy(sunDir).multiplyScalar(100);
    this.inertial.add(light);

    // A gas giant hanging off to one side.
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(Rs * 0.18, 48, 32),
      new THREE.MeshStandardMaterial({ map: this.textures.planet, fog: false, roughness: 1 }),
    );
    planet.position.set(-Rs * 0.55, Rs * 0.3, -Rs * 0.35);
    planet.rotation.set(0.4, 0.2, 0.3);
    this.inertial.add(planet);
  }

  setFrameAngle(a: number) {
    this.inertial.rotation.z = -a;
  }
}

/** Matrix whose basis is (spinward, up, axial) at ring angle `a`, positioned at radius r, axial z. */
export function basisMatrix(m: THREE.Matrix4, a: number, r: number, z: number) {
  const c = Math.cos(a), s = Math.sin(a);
  m.set(
    -s, -c, 0, r * c,
    c, -s, 0, r * s,
    0, 0, 1, z,
    0, 0, 0, 1,
  );
  return m;
}
