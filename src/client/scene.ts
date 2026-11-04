// Static world rendering. Everything here is drawn in the ROTATING frame
// (the level never moves), except `inertial`, a group whose rotation is set
// to -frameAngle every frame so its children (stars, sun, planet, inertial
// trails) are fixed in the non-rotating frame.

import * as THREE from 'three';
import { floorRadius, type Level, type SimConfig } from '../sim';
import { ballTexture, crateTexture, deckTexture, glowTexture, grassTexture, planetTexture, wallTexture } from './textures';

export const LAYER_ROT_TRAILS = 1;
export const LAYER_INERTIAL_ONLY = 2;
export const LAYER_SELF = 3;

export class RingScene {
  scene = new THREE.Scene();
  inertial = new THREE.Group(); // fixed in the inertial frame
  level = new THREE.Group();
  glow = glowTexture();
  textures = { deck: deckTexture(), wall: wallTexture(), crate: crateTexture(), ball: ballTexture(), planet: planetTexture(), grass: grassTexture() };
  starRadius = 4000;
  sky: 'space' | 'earth' = 'space';
  ambient = new THREE.AmbientLight(0x9aa8c0, 0.6);
  axisLight = new THREE.PointLight(0xfff2dd, 0.85, 0, 0); // light from the axis: the "sky" of a ring habitat
  /**
   * The sun: fixed relative to the stars, so in the ring's (rotating) frame it
   * circles once per spin and the shadows sweep round. It casts shadows in a
   * box that follows the camera.
   */
  sunLight = new THREE.DirectionalLight(0xfff1d6, 2.6);
  // Inertial-frame direction toward the sun: 40 degrees off the ring's axis, so
  // each part of the floor gets a day (with sweeping shadows) and a night per spin.
  sunDir = new THREE.Vector3(Math.sin(0.7), 0, Math.cos(0.7));

  constructor() {
    this.scene.background = new THREE.Color(0x02030a);
    this.scene.add(this.inertial, this.level, this.ambient, this.axisLight, this.sunLight, this.sunLight.target);
    const sh = this.sunLight.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.left = -40; sh.camera.right = 40; sh.camera.top = 40; sh.camera.bottom = -40;
    sh.camera.near = 1; sh.camera.far = 400;
    sh.bias = -0.0004;
    sh.normalBias = 0.04;
    this.sunLight.castShadow = true;
  }

  /** Point the sun (and its shadow box) at `focus`, for the current spin angle. */
  updateSun(frameAngle: number, focus: THREE.Vector3) {
    const d = this.sunDir.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -frameAngle);
    this.sunLight.position.copy(focus).addScaledVector(d, 200);
    this.sunLight.target.position.copy(focus);
  }

  build(cfg: SimConfig, level: Level, sky: 'space' | 'earth' = 'space') {
    this.level.clear();
    this.inertial.clear();
    this.sky = sky;
    if (sky === 'earth') return this.buildEarth(cfg, level);
    this.scene.background = new THREE.Color(0x02030a);
    this.ambient.intensity = 0.6;
    this.axisLight.intensity = 0.85;
    this.sunLight.intensity = 2.6;
    this.sunDir.set(Math.sin(0.7), 0, Math.cos(0.7));
    const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
    const segs = Math.min(720, Math.max(192, Math.round(R * 2.4)));
    this.starRadius = Math.max(4000, R * 12);
    this.scene.fog = new THREE.Fog(0x0b1020, Math.max(R * 1.5, 80), Math.max(R * 7, 400));

    // Floor: inside of a cylinder about Z.
    const deck = this.textures.deck.clone();
    deck.needsUpdate = true;
    deck.repeat.set((2 * Math.PI * R) / 5, (2 * W) / 5);
    const floorGeo = new THREE.CylinderGeometry(R, R, 2 * W, segs, 1, true);
    floorGeo.rotateX(Math.PI / 2);
    if (level.terrain) {
      this.level.add(this.terrainMesh(cfg, level));
    } else {
      const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ map: deck, side: THREE.BackSide, roughness: 0.85, metalness: 0.2 }));
      floor.receiveShadow = true;
      this.level.add(floor);
    }

    // Center stripe + edge stripes (painted on, slightly above the floor).
    const stripe = (z: number, w: number, color: number) => {
      const g = new THREE.CylinderGeometry(R - 0.02, R - 0.02, w, segs, 1, true);
      g.rotateX(Math.PI / 2);
      g.translate(0, 0, z);
      this.level.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, side: THREE.BackSide, roughness: 0.6 })));
    };
    if (!level.terrain) {
      stripe(0, 0.6, 0xc9a43a);
      stripe(W - 1.5, 0.4, 0x8a96a8);
      stripe(-W + 1.5, 0.4, 0x8a96a8);
    }

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
    if (!level.terrain) this.level.add(inst); // painted arrows only on a flat floor

    // Rim walls, one piece per sector so heights can vary (low curbs = you can fall off).
    this.buildWalls(cfg, level.wallPos, 1, segs, level);
    this.buildWalls(cfg, level.wallNeg, -1, segs, level);
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

    this.buildBoxes(cfg, level);
    this.buildSky(cfg);
  }

  private buildBoxes(cfg: SimConfig, level: Level) {
    const R = cfg.R;
    const m = new THREE.Matrix4();
    // Obstacles.
    const boxMat = new THREE.MeshStandardMaterial({ map: this.textures.crate, roughness: 0.8 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1a1510 });
    const wallMat = new THREE.MeshStandardMaterial({ map: this.textures.wall, roughness: 0.7, metalness: 0.3 });
    const stairMat = new THREE.MeshStandardMaterial({ map: this.textures.wall, color: 0xd6e2f5, emissive: 0x1c2a40, roughness: 0.6, metalness: 0.15 });
    for (const b of level.boxes) {
      const geo = new THREE.BoxGeometry(2 * b.half[0], 2 * b.half[1], 2 * b.half[2]);
      const mesh = new THREE.Mesh(geo, b.kind === 'ramp' ? stairMat : b.kind === 'wall' ? wallMat : boxMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      basisMatrix(m, b.angle, 0, 0);
      mesh.quaternion.setFromRotationMatrix(m);
      if (b.tilt) mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), b.tilt));
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

  }

  /**
   * Earth: a 100 km "ring" that doesn't spin. Only the arena and a wide apron
   * of ground around it are drawn (finely: the whole circumference would put
   * the drawn floor metres away from where the physics has it).
   */
  private buildEarth(cfg: SimConfig, level: Level) {
    const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness;
    const sky = new THREE.Color(0x8fc4ff);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(0xb8d8f5, 120, 700);
    this.ambient.intensity = 1.0;
    this.axisLight.intensity = 0;
    this.sunLight.intensity = 2.2;
    // sun high in the sky over the arena (around angle 0, "up" is -x)
    this.sunDir.set(-0.8, 0.25, 0.45).normalize();
    const half = 600; // metres of ground drawn each way
    const arc = (2 * half) / R;
    const grass = this.textures.grass.clone();
    grass.needsUpdate = true;
    grass.repeat.set((2 * half) / 4, (2 * half) / 4);
    const segs = Math.round((2 * half) / 2);
    // Geometry is built around the arena centre (R, 0, 0) and the mesh moved
    // there: 100 km coordinates in single precision are only good to ~1 cm.
    const centre = new THREE.Vector3(R, 0, 0);
    const g = new THREE.CylinderGeometry(R, R, 2 * half, segs, 1, true, -arc / 2 + Math.PI / 2, arc);
    g.rotateX(Math.PI / 2);
    g.translate(-R, 0, 0);
    const ground = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: grass, side: THREE.BackSide, roughness: 1 }));
    ground.position.copy(centre);
    ground.receiveShadow = true;
    this.level.add(ground);
    // painted arena floor on top of the grass
    const deck = this.textures.deck.clone();
    deck.needsUpdate = true;
    deck.repeat.set(cfg.arena / 5, (2 * W) / 5);
    const a2 = cfg.arena / R;
    const fg = new THREE.CylinderGeometry(R - 0.03, R - 0.03, 2 * W, Math.round(cfg.arena / 2), 1, true, -a2 / 2 + Math.PI / 2, a2);
    fg.rotateX(Math.PI / 2);
    fg.translate(-R, 0, 0);
    const floor = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ map: deck, side: THREE.BackSide, roughness: 0.85, metalness: 0.1 }));
    floor.position.copy(centre);
    floor.receiveShadow = true;
    this.level.add(floor);
    // side fences (the rim walls), only along the arena
    const wallMat = new THREE.MeshStandardMaterial({ map: this.textures.wall, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.3 });
    const h = level.wallPos[0] ?? cfg.wallHeight;
    for (const sgn of [1, -1]) {
      const geo = new THREE.BoxGeometry(cfg.arena + 3, h, T);
      const fence = new THREE.Mesh(geo, wallMat);
      const m = new THREE.Matrix4();
      basisMatrix(m, 0, R - h / 2, sgn * (W + T / 2));
      fence.applyMatrix4(m);
      fence.castShadow = true;
      fence.receiveShadow = true;
      this.level.add(fence);
    }
    this.buildBoxes(cfg, level);
    // a sun in the sky (no stars by day)
    this.starRadius = 4000;
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xfff6d0, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
    sun.position.copy(this.sunDir).multiplyScalar(3500).add(new THREE.Vector3(R, 0, 0));
    sun.scale.setScalar(400);
    this.level.add(sun);
  }

  /** The floor as a mesh following the terrain (hills / sphere band). */
  private terrainMesh(cfg: SimConfig, level: Level): THREE.Mesh {
    const R = cfg.R, W = cfg.halfWidth + cfg.wallThickness;
    const span = 2 * Math.PI * R;
    const nu = Math.min(1400, Math.max(96, Math.round(span / 1.5)));
    const nv = Math.min(120, Math.max(8, Math.round((2 * W) / 1.5)));
    const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
    const uv = new Float32Array((nu + 1) * (nv + 1) * 2);
    const tile = level.terrain!.hills.length ? 4 : 5;
    let k = 0;
    for (let i = 0; i <= nu; i++) {
      const a = (i / nu) * Math.PI * 2;
      for (let j = 0; j <= nv; j++) {
        const z = -W + (2 * W * j) / nv;
        const r = floorRadius(level, cfg, a, z);
        pos[k * 3] = r * Math.cos(a); pos[k * 3 + 1] = r * Math.sin(a); pos[k * 3 + 2] = z;
        uv[k * 2] = (a * R) / tile; uv[k * 2 + 1] = z / tile;
        k++;
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j, b = (i + 1) * (nv + 1) + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = (level.terrain!.hills.length ? this.textures.grass : this.textures.deck).clone();
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.05 }));
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildWalls(cfg: SimConfig, heights: number[], sgn: number, segs: number, level?: Level) {
    const W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
    // walls stand on the floor at the edge: higher up on a sphere band
    const R = level?.terrain?.sphere ? Math.sqrt(cfg.R * cfg.R - W * W) : cfg.R;
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
      const outer = new THREE.Mesh(new THREE.RingGeometry(R - h, cfg.R + hull, segsPer, 1, a0, step), outerMat);
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

  private buildSky(cfg: SimConfig) {
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
    // (the light itself is this.sunLight, steered every frame by updateSun)

    // A gas giant hanging off to one side.
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(Rs * 0.18, 48, 32),
      new THREE.MeshStandardMaterial({ map: this.textures.planet, fog: false, roughness: 1 }),
    );
    planet.position.set(-Rs * 0.55, Rs * 0.3, -Rs * 0.35);
    if (cfg.planetPull > 0) {
      // the planet doing the pulling: huge, in the direction of the pull
      planet.scale.setScalar(2.4);
      planet.position.set(Math.cos(cfg.planetAngle) * Rs * 0.6, Math.sin(cfg.planetAngle) * Rs * 0.6, -Rs * 0.05);
    }
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
