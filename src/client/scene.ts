// Static world rendering. Everything here is drawn in the ROTATING frame
// (the level never moves), except `inertial`, a group whose rotation is set
// to -frameAngle every frame so its children (stars, sun, planet, inertial
// trails) are fixed in the non-rotating frame.

import * as THREE from 'three';
import { disposeTree } from './dispose';
import { DISK_THICKNESS, diskSurface, floorRadius, towerPoint, type Hole, type Level, type SimConfig, type TowerFloor } from '../sim';
import { ballTexture, crateTexture, deckTexture, glowTexture, grassTexture, planetTexture, rockTexture, sandTexture, snowTexture, wallTexture } from './textures';

export const LAYER_ROT_TRAILS = 1;
export const LAYER_INERTIAL_ONLY = 2;
export const LAYER_SELF = 3;

export class RingScene {
  scene = new THREE.Scene();
  inertial = new THREE.Group(); // fixed in the inertial frame
  level = new THREE.Group();
  glow = glowTexture();
  textures = {
    deck: deckTexture(), wall: wallTexture(), crate: crateTexture(), ball: ballTexture(), planet: planetTexture(), grass: grassTexture(),
    sand: sandTexture(), snow: snowTexture(), rock: rockTexture(),
  };
  /** The level's chosen floor texture ('auto' = whatever suits the floor: deck plating, grass on hills). */
  private floorChoice: SimConfig['floorTexture'] = 'auto';
  private floorTex(fallback: 'deck' | 'grass'): THREE.Texture {
    const k = this.floorChoice === 'auto' ? fallback : this.floorChoice;
    const t = this.textures[k].clone();
    t.needsUpdate = true;
    return t;
  }
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
    // free the previous level's GPU memory (keeping the shared original textures)
    const keep = new Set<THREE.Texture>([...Object.values(this.textures), this.glow]);
    for (const c of [...this.level.children]) disposeTree(c, keep);
    for (const c of [...this.inertial.children]) disposeTree(c, keep);
    this.sky = sky;
    this.floorChoice = cfg.floorTexture;
    if (sky === 'earth') return this.buildEarth(cfg, level);
    if (level.shape === 'planet') return this.buildPlanet(cfg, level);
    if (level.shape === 'disk') return this.buildDisk(cfg, level);
    if (level.shape === 'tower') return this.buildTower(cfg, level);
    this.scene.background = new THREE.Color(0x02030a);
    this.ambient.intensity = 0.6;
    this.axisLight.intensity = 0.85;
    this.sunLight.intensity = 2.6;
    this.sunDir.set(Math.sin(0.7), 0, Math.cos(0.7));
    const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
    // Closed worlds (inside a torus, a whole sphere): no sunlight gets in, so no
    // sweeping sun shadows; they're lit from inside instead.
    const enclosed = level.terrain?.tube?.kind === 'inside' || (!!level.terrain?.sphere && W > 0.9 * R);
    if (enclosed) {
      this.sunLight.intensity = 0;
      this.ambient.intensity = 1.0;
      this.axisLight.intensity = 1.2;
    }
    this.sunLight.castShadow = !enclosed;
    const segs = Math.min(720, Math.max(192, Math.round(R * 2.4)));
    this.starRadius = Math.max(4000, R * 12);
    this.scene.fog = new THREE.Fog(0x0b1020, Math.max(R * 1.5, 80), Math.max(R * 7, 400));

    // Floor: inside of a cylinder about Z.
    const deck = this.floorTex('deck');
    deck.repeat.set((2 * Math.PI * R) / 5, (2 * W) / 5);
    this.twinGroups = [];
    if (cfg.twin) return this.buildTwin(cfg, level, segs);
    const floorGeo = new THREE.CylinderGeometry(R, R, 2 * W, segs, 1, true);
    floorGeo.rotateX(Math.PI / 2);
    const tube = level.terrain?.tube;
    if (tube && tube.kind !== 'half') {
      this.level.add(this.tubeMesh(cfg, tube.kind, tube.radius));
    } else if (level.terrain) {
      this.level.add(this.terrainMesh(cfg, level));
      if (level.terrain.sphere && W > 0.9 * R) this.sphereMarkings(cfg);
    } else if (level.holes?.length) {
      this.level.add(this.cutShell(R, W + T, level.holes, R, hull, 'floor'));
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
    for (const dk of level.decks ?? []) this.level.add(this.cutShell(dk.r, W, dk.holes, R, dk.thickness, 'deck'));
    if (!level.terrain && !level.holes?.length) {
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
    if (!level.terrain && !level.holes?.length) this.level.add(inst); // painted arrows only on a flat, whole floor

    // Rim walls, one piece per sector so heights can vary (low curbs = you can fall off).
    this.buildWalls(cfg, level.wallPos, 1, segs, level);
    this.buildWalls(cfg, level.wallNeg, -1, segs, level);
    if (tube) { this.buildBoxes(cfg, level); this.buildSky(cfg); return; } // no hull or ribs round a tube
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

  /**
   * Twin rings: each ring is its own group, built in its own frame. Every frame
   * the groups are turned so the scene is drawn in the frame of the ring the
   * viewer is on: that ring stands still and the other one turns past.
   */
  private twinGroups: THREE.Group[] = [];
  private buildTwin(cfg: SimConfig, level: Level, segs: number) {
    const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness, g = cfg.twinGap / 2;
    const saved = this.level;
    const m = new THREE.Matrix4();
    for (const k of [0, 1] as const) {
      const grp = new THREE.Group();
      this.level = grp;
      const sg = k ? 1 : -1;
      const len = W + T - g, zc = (sg * (W + T + g)) / 2;
      const tint = k ? 0xffe2c8 : 0xc8e2ff; // the two rings in slightly different light
      const tex = this.floorTex('deck');
      tex.repeat.set((2 * Math.PI * R) / 5, len / 5);
      const fg = new THREE.CylinderGeometry(R, R, len, segs, 1, true);
      fg.rotateX(Math.PI / 2);
      fg.translate(0, 0, zc);
      const floor = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ map: tex, color: tint, side: THREE.BackSide, roughness: 0.85, metalness: 0.2 }));
      floor.receiveShadow = true;
      grp.add(floor);
      // a stripe down the middle of each ring
      const st = new THREE.CylinderGeometry(R - 0.02, R - 0.02, 0.6, segs, 1, true);
      st.rotateX(Math.PI / 2);
      st.translate(0, 0, zc);
      grp.add(new THREE.Mesh(st, new THREE.MeshStandardMaterial({ color: k ? 0xff9a3a : 0x3ac8ff, side: THREE.BackSide, roughness: 0.6 })));
      // the curb along the seam: its top and its face over the gap, in hazard orange
      const hazard = new THREE.MeshStandardMaterial({ color: 0xff5a2a, emissive: 0x551400, side: THREE.DoubleSide });
      const top = new THREE.CylinderGeometry(R - 0.6, R - 0.6, T, segs, 1, true);
      top.rotateX(Math.PI / 2);
      top.translate(0, 0, sg * (g + T / 2));
      grp.add(new THREE.Mesh(top, hazard));
      const face = new THREE.Mesh(new THREE.RingGeometry(R - 0.6, R + hull, segs), new THREE.MeshStandardMaterial({ color: 0x3a404a, side: THREE.DoubleSide, roughness: 0.9 }));
      face.position.z = sg * g;
      grp.add(face);
      // chevrons pointing this ring's way round (ring 1 turns the other way)
      const chev = new THREE.BufferGeometry();
      const x = k ? -1 : 1;
      chev.setAttribute('position', new THREE.Float32BufferAttribute([1.4 * x, 0, 0, -0.4 * x, 0, -0.9, 0, 0, 0, 1.4 * x, 0, 0, 0, 0, 0, -0.4 * x, 0, 0.9], 3));
      chev.computeVertexNormals();
      const nPer = Math.round((2 * Math.PI * R) / 8);
      const inst = new THREE.InstancedMesh(chev, new THREE.MeshBasicMaterial({ color: k ? 0xff9a3a : 0x3ac8ff, side: THREE.DoubleSide }), nPer);
      for (let i = 0; i < nPer; i++) { basisMatrix(m, (i / nPer) * Math.PI * 2, R - 0.03, zc + sg * 6); inst.setMatrixAt(i, m); }
      grp.add(inst);
      // outer rim wall, hull and ribs
      if (k) this.buildWalls(cfg, level.wallPos, 1, segs, level); else this.buildWalls(cfg, level.wallNeg, -1, segs, level);
      const hg = new THREE.CylinderGeometry(R + hull, R + hull, len, segs, 1, true);
      hg.rotateX(Math.PI / 2);
      hg.translate(0, 0, zc);
      grp.add(new THREE.Mesh(hg, new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.9, metalness: 0.5 })));
      const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, hull * 1.2, len), new THREE.MeshStandardMaterial({ color: k ? 0xc86a2a : 0x2a8ac8, roughness: 0.6 }), 24);
      for (let i = 0; i < 24; i++) { basisMatrix(m, (i / 24) * Math.PI * 2, R + hull, zc); ribs.setMatrixAt(i, m); }
      grp.add(ribs);
      this.buildBoxes(cfg, { ...level, boxes: level.boxes.filter((b) => (b.ring ?? 0) === k), spawns: level.spawns.filter((sp) => (sp.z >= 0 ? 1 : 0) === k) });
      saved.add(grp);
      this.twinGroups.push(grp);
    }
    this.level = saved;
    this.buildSky(cfg);
  }

  /** Twin rings: turn each ring's group into the viewer's frame (ring 0 at angle theta, ring 1 at -theta). */
  setTwinView(theta: number, view: 0 | 1) {
    if (!this.twinGroups.length) return;
    const tv = view ? -theta : theta;
    this.twinGroups[0].rotation.z = theta - tv;
    this.twinGroups[1].rotation.z = -theta - tv;
  }

  private liftMeshes = new Map<number, THREE.Mesh>();
  /** Lifts move: follow the sim's boxes (interpolated between ticks by the caller's alpha is overkill at lift speeds). */
  updateLifts(level: Level) {
    if (!this.liftMeshes.size) return;
    for (const b of level.boxes) {
      const m = this.liftMeshes.get(b.id);
      if (m) m.position.set(b.center[0], b.center[1], b.center[2]);
    }
  }

  private buildBoxes(cfg: SimConfig, level: Level) {
    const R = cfg.R;
    const m = new THREE.Matrix4();
    // Obstacles.
    const boxMat = new THREE.MeshStandardMaterial({ map: this.textures.crate, roughness: 0.8 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1a1510 });
    const wallMat = new THREE.MeshStandardMaterial({ map: this.textures.wall, roughness: 0.7, metalness: 0.3 });
    const stairMat = new THREE.MeshStandardMaterial({ map: this.textures.wall, color: 0xd6e2f5, emissive: 0x1c2a40, roughness: 0.6, metalness: 0.15 });
    const liftMat = new THREE.MeshStandardMaterial({ color: 0x4a5a70, emissive: 0x1a4a7a, roughness: 0.5, metalness: 0.6 });
    // bases: that particular blue-grey alloy, faintly lit, with glowing edges
    const structMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ae, emissive: 0x0c1218, roughness: 0.32, metalness: 0.55 });
    const structEdge = new THREE.LineBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.55 });
    this.liftMeshes.clear();
    for (const b of level.boxes) {
      const geo = new THREE.BoxGeometry(2 * b.half[0], 2 * b.half[1], 2 * b.half[2]);
      const mesh = new THREE.Mesh(geo, b.kind === 'ramp' ? stairMat : b.kind === 'wall' ? wallMat : b.kind === 'lift' ? liftMat : b.kind === 'struct' ? structMat : boxMat);
      if (b.lift) this.liftMeshes.set(b.id, mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (b.axes) m.makeBasis(new THREE.Vector3(...b.axes[0]), new THREE.Vector3(...b.axes[1]), new THREE.Vector3(...b.axes[2]));
      else basisMatrix(m, b.angle, 0, 0);
      mesh.quaternion.setFromRotationMatrix(m);
      if (b.yaw) mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -b.yaw));
      if (b.tilt) mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), b.tilt));
      mesh.position.set(b.center[0], b.center[1], b.center[2]);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), b.kind === 'struct' ? structEdge : edgeMat));
      this.level.add(mesh);
    }

    // Spawn pads.
    for (const s of level.shape !== 'ring' ? [] : level.spawns) {
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
    this.sunLight.castShadow = true;
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
    // the arena: a mown, slightly greener patch of the same grass
    const deck = this.textures.grass.clone();
    deck.needsUpdate = true;
    deck.repeat.set(cfg.arena / 4, (2 * W) / 4);
    const a2 = cfg.arena / R;
    const fg = new THREE.CylinderGeometry(R - 0.03, R - 0.03, 2 * W, Math.round(cfg.arena / 2), 1, true, -a2 / 2 + Math.PI / 2, a2);
    fg.rotateX(Math.PI / 2);
    fg.translate(-R, 0, 0);
    const floor = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ map: deck, color: 0xb8e8a0, side: THREE.BackSide, roughness: 0.95, metalness: 0 }));
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

  /**
   * Inside a whole sphere there's no sky to read the shape from: a glowing
   * line along the axis (it lights the place, like a sun stretched pole to
   * pole) and painted latitude rings every 15 degrees. The orange ring at
   * ~53 degrees is where the floor gets too steep to stand on.
   */
  private sphereMarkings(cfg: SimConfig) {
    const R = cfg.R;
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 2 * R, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff1c0, fog: false }));
    rod.rotation.x = Math.PI / 2;
    const halo = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 2 * R, 16, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffd890, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    halo.rotation.x = Math.PI / 2;
    this.level.add(rod, halo);
    const ring = (lat: number, color: number) => {
      const pts: THREE.Vector3[] = [];
      const r = (R - 0.05) * Math.cos(lat), z = (R - 0.05) * Math.sin(lat);
      for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z)); }
      this.level.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, fog: true })));
    };
    for (let deg = -75; deg <= 75; deg += 15) ring((deg * Math.PI) / 180, deg === 0 ? 0xc9a43a : 0x8a96a8);
    const steep = Math.acos(0.6); // the walkable limit (ground normal within ~53 degrees of "up")
    for (const sg of [-1, 1]) ring(sg * steep, 0xff5a2a);
  }

  /**
   * A dense little planet seen from its surface: a textured ball with the
   * equator and latitude lines painted on (so the curve and the spin read), the
   * usual sky turning overhead, and the sun.
   */
  private buildPlanet(cfg: SimConfig, level: Level) {
    const R = cfg.R;
    this.scene.background = new THREE.Color(0x02030a);
    this.ambient.intensity = 0.55;
    this.axisLight.intensity = 0;
    this.sunLight.intensity = 2.8;
    this.sunLight.castShadow = true;
    this.sunDir.set(Math.sin(0.5), 0, Math.cos(0.5));
    this.starRadius = Math.max(4000, R * 20);
    this.scene.fog = new THREE.Fog(0x0b1020, R * 2, R * 12);
    const tex = this.floorTex('grass');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set((2 * Math.PI * R) / 6, (Math.PI * R) / 6);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 384, 192), new THREE.MeshStandardMaterial({ map: tex, color: this.floorChoice === 'auto' ? 0xb8c8a0 : 0xffffff, roughness: 0.95, metalness: 0 }));
    ball.rotation.x = Math.PI / 2; // the sphere's poles on the spin axis (z)
    ball.receiveShadow = true;
    this.level.add(ball);
    const ring = (lat: number, color: number) => {
      const pts: THREE.Vector3[] = [];
      const r = (R + 0.04) * Math.cos(lat), z = (R + 0.04) * Math.sin(lat);
      for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z)); }
      this.level.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
    };
    for (let deg = -75; deg <= 75; deg += 15) ring((deg * Math.PI) / 180, deg === 0 ? 0xc9a43a : 0x6a7a68);
    // meridians every 30 degrees, so you can see which way is east
    for (let k = 0; k < 12; k++) {
      const lon = (k / 12) * Math.PI * 2, pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 128; i++) { const lat = -Math.PI / 2 + (i / 128) * Math.PI; pts.push(new THREE.Vector3((R + 0.04) * Math.cos(lat) * Math.cos(lon), (R + 0.04) * Math.cos(lat) * Math.sin(lon), (R + 0.04) * Math.sin(lat))); }
      this.level.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6a7a68 })));
    }
    // a beacon at each pole
    for (const sg of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.2, 14, 12), new THREE.MeshStandardMaterial({ color: 0x9aa3ae, emissive: 0x0c1218, metalness: 0.55, roughness: 0.32 }));
      pole.rotation.x = Math.PI / 2;
      pole.position.set(0, 0, sg * (R + 7));
      const lamp = this.makeGlowSprite(0x7fd8ff, 6);
      lamp.position.set(0, 0, sg * (R + 15));
      this.level.add(pole, lamp);
    }
    if (cfg.outerShell > 0) this.buildShell(cfg, level);
    this.buildBoxes(cfg, level);
    this.buildSky(cfg);
  }

  /**
   * Nested spheres: the shell round the ball, seen from inside, with latitude
   * rings and an orange one where it stops being walkable (beyond it gravity
   * beats the spin and you fall off, down to the ball). No sunlight gets in;
   * it's lit from within. Plus the launch pads on both surfaces.
   */
  private buildShell(cfg: SimConfig, level: Level) {
    const R2 = cfg.outerShell;
    this.sunLight.intensity = 0;
    this.sunLight.castShadow = false;
    this.ambient.intensity = 1.0;
    this.scene.fog = new THREE.Fog(0x0b1020, R2 * 1.5, R2 * 6);
    const tex = this.floorTex('deck');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set((2 * Math.PI * R2) / 5, (Math.PI * R2) / 5);
    const shell = new THREE.Mesh(new THREE.SphereGeometry(R2, 256, 128), new THREE.MeshStandardMaterial({ map: tex, color: 0xc8d0dc, side: THREE.BackSide, roughness: 0.85, metalness: 0.2 }));
    shell.rotation.x = Math.PI / 2;
    this.level.add(shell);
    // where the shell stops being walkable: the spin's outward push (w^2 r cos^2 lat) falls below gravity (GM / r^2)
    const w2 = (cfg.planetSpin * cfg.g) / cfg.R, GM = cfg.g * cfg.R * cfg.R;
    const c2 = GM / (R2 * R2) / (w2 * R2);
    const limit = c2 < 1 ? Math.acos(Math.sqrt(c2)) : 0;
    const ring = (lat: number, color: number) => {
      const pts: THREE.Vector3[] = [];
      const r = (R2 - 0.05) * Math.cos(lat), z = (R2 - 0.05) * Math.sin(lat);
      for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z)); }
      this.level.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
    };
    for (let deg = -60; deg <= 60; deg += 15) ring((deg * Math.PI) / 180, deg === 0 ? 0xc9a43a : 0x8a96a8);
    for (const sg of [-1, 1]) ring(sg * limit, 0xff5a2a);
    // a soft glow from the ball lights the inside
    const glow = new THREE.PointLight(0xfff2dd, 1.4, 0, 0);
    this.level.add(glow);
    this.buildPads(level, (pos) => { const r = Math.hypot(...pos); return new THREE.Vector3(...pos).divideScalar(r).multiplyScalar(r > cfg.R + 1 ? -1 : 1); });
  }

  /** Launch pads: a glowing disc and an arrow the way it throws you. `normalAt` points out of the ground. */
  private buildPads(level: Level, normalAt: (pos: [number, number, number]) => THREE.Vector3) {
    const padMat = new THREE.MeshBasicMaterial({ color: 0x3affc0, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
    const arrowMat = new THREE.MeshBasicMaterial({ color: 0xbfffe8 });
    for (const pad of level.pads ?? []) {
      const n = normalAt(pad.pos);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), padMat);
      disc.position.set(...pad.pos).addScaledVector(n, 0.05);
      disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.2, 12), arrowMat);
      const up = new THREE.Vector3(...pad.up);
      arrow.position.copy(disc.position).addScaledVector(up, 1.2);
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      this.level.add(disc, arrow);
    }
  }

  /**
   * Spin Tower: the hollow box through the axis, seen from inside. Floors are
   * curved (each at one radius) and tinted from warm at the heavy ends to cool
   * near the weightless middle, with their weight painted on the end walls.
   */
  private buildTower(cfg: SimConfig, level: Level) {
    const T = level.tower!, R = cfg.R, W = T.halfWidth, hw = cfg.halfWidth;
    this.scene.background = new THREE.Color(0x02030a);
    this.sunLight.intensity = 0;
    this.sunLight.castShadow = false;
    this.ambient.intensity = 1.25;
    this.axisLight.intensity = 1.4;
    this.starRadius = Math.max(4000, R * 12);
    this.scene.fog = new THREE.Fog(0x0b1020, R * 1.2, R * 4);
    const xe = Math.sqrt(R * R - W * W);
    const tint = (r: number) => new THREE.Color(0x6ab0e8).lerp(new THREE.Color(0xe0a070), r / R);
    // floors (and the end walls, which are the bottom floors): curved surfaces with their openings left out
    const surface = (f: TowerFloor, arm: 0 | 1) => {
      const ys = new Set<number>(), zs = new Set<number>();
      for (let i = 0; i <= 20; i++) ys.add(-W + (2 * W * i) / 20);
      for (let i = 0; i <= 8; i++) zs.add(-hw + (2 * hw * i) / 8);
      for (const h of f.holes) { ys.add(h.y - h.hy); ys.add(h.y + h.hy); zs.add(h.z - h.hz); zs.add(h.z + h.hz); }
      const Y = [...ys].filter((y) => y >= -W && y <= W).sort((a, b) => a - b), Z = [...zs].filter((z) => z >= -hw && z <= hw).sort((a, b) => a - b);
      const pos: number[] = [], uv: number[] = [];
      for (let i = 0; i + 1 < Y.length; i++) for (let j = 0; j + 1 < Z.length; j++) {
        const yc = (Y[i] + Y[i + 1]) / 2, zc = (Z[j] + Z[j + 1]) / 2;
        if (f.holes.some((h) => Math.abs(yc - h.y) < h.hy && Math.abs(zc - h.z) < h.hz)) continue;
        const q = [[Y[i], Z[j]], [Y[i + 1], Z[j]], [Y[i + 1], Z[j + 1]], [Y[i], Z[j]], [Y[i + 1], Z[j + 1]], [Y[i], Z[j + 1]]];
        for (const [y, z] of q) { pos.push(...towerPoint(f.r - 0.02, y, z, arm)); uv.push(y / 4, z / 4); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      return g;
    };
    const tex = this.floorTex('deck');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const all: TowerFloor[] = [{ r: R, thickness: 0, holes: [] }, ...T.floors];
    for (const f of all) {
      const mat = new THREE.MeshStandardMaterial({ map: tex, color: tint(f.r), side: THREE.DoubleSide, roughness: 0.8, metalness: 0.2 });
      for (const arm of [0, 1] as const) {
        const m = new THREE.Mesh(surface(f, arm), mat);
        m.receiveShadow = true;
        this.level.add(m);
        // a thin dark edge under it: the slab's thickness, seen from below
        if (f.thickness) this.level.add(new THREE.Mesh(surface({ ...f, r: f.r + f.thickness }, arm), new THREE.MeshStandardMaterial({ color: 0x2a2f38, side: THREE.DoubleSide, roughness: 0.9 })));
      }
    }
    // side walls (round the spin) and the two faces (along the axis)
    const wallTex = this.textures.wall.clone();
    wallTex.needsUpdate = true;
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    wallTex.repeat.set((2 * xe) / 6, (2 * hw) / 6);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, color: 0xc4ccd8, side: THREE.DoubleSide, roughness: 0.75, metalness: 0.2 });
    for (const sy of [-1, 1]) {
      const g = new THREE.PlaneGeometry(2 * xe, 2 * hw);
      g.rotateX(Math.PI / 2);
      g.translate(0, sy * W, 0);
      this.level.add(new THREE.Mesh(g, wallMat));
    }
    const outline = new THREE.Shape();
    const a = Math.asin(W / R);
    outline.moveTo(xe, -W);
    outline.absarc(0, 0, R, -a, a, false);
    outline.lineTo(-xe, W);
    outline.absarc(0, 0, R, Math.PI - a, Math.PI + a, false);
    outline.lineTo(xe, -W);
    const faceMat = new THREE.MeshStandardMaterial({ color: 0x5e6878, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.2 });
    for (const sz of [-1, 1]) {
      const g = new THREE.ShapeGeometry(outline, 48);
      g.translate(0, 0, sz * hw);
      this.level.add(new THREE.Mesh(g, faceMat));
    }
    // each floor's weight, painted on both faces of both arms, and a stripe where it meets them
    const w2 = cfg.g / R;
    for (const f of all) {
      const label = this.textPlane(`${((w2 * f.r) / 9.81).toFixed(2)} g`, '#ffe9b0');
      for (const arm of [0, 1] as const) for (const sz of [-1, 1]) {
        const m = label.clone();
        const p = towerPoint(f.r - 2.2, 0, sz * (hw - 0.05), arm);
        m.position.set(...p);
        // upright: the floor's "up" (toward the axis) is the label's up
        const up = new THREE.Vector3(-p[0], -p[1], 0).normalize();
        const n = new THREE.Vector3(0, 0, -sz);
        m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, n), up, n));
        this.level.add(m);
      }
    }
    // the axis: a ring of light round it on each face
    for (const sz of [-1, 1]) {
      const lamp = this.makeGlowSprite(0x7fd8ff, 4);
      lamp.position.set(0, 0, sz * (hw - 1));
      this.level.add(lamp);
    }
    this.buildPads(level, (pos) => new THREE.Vector3(-pos[0], -pos[1], 0).normalize());
    this.buildBoxes(cfg, level);
    this.buildSky(cfg);
  }

  /** A flat plane with some text on it (2 m tall). */
  private textPlane(text: string, color: string): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 34);
    const tex = new THREE.CanvasTexture(c);
    return new THREE.Mesh(new THREE.PlaneGeometry(8, 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  }

  private makeGlowSprite(color: number, size: number) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    sp.scale.setScalar(size);
    return sp;
  }

  /**
   * Disk World: a solid of revolution (the flat top, or the spinning bucket's
   * paraboloid), its rim and underside, with painted rings every 20 m and, on
   * the flat disk, an orange ring where the floor becomes too steep to stand on.
   */
  private buildDisk(cfg: SimConfig, level: Level) {
    const R = cfg.R;
    this.scene.background = new THREE.Color(0x02030a);
    this.ambient.intensity = 0.6;
    this.axisLight.intensity = 0;
    this.sunLight.intensity = 2.6;
    this.sunLight.castShadow = true;
    this.sunDir.set(0.5, 0.2, 1).normalize(); // high over the disk's top face
    this.starRadius = Math.max(4000, R * 20);
    this.scene.fog = new THREE.Fog(0x0b1020, R * 3, R * 15);
    const T = DISK_THICKNESS, n = 96;
    const h = (r: number) => diskSurface(cfg, r).h;
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= n; i++) { const r = (R * i) / n; pts.push(new THREE.Vector2(Math.max(1e-3, r), h(r))); }
    for (let i = n; i >= 0; i--) { const r = (R * i) / n; pts.push(new THREE.Vector2(Math.max(1e-3, r), h(r) - T)); }
    const g = new THREE.LatheGeometry(pts, 256);
    g.rotateX(Math.PI / 2); // the lathe's axis (y) onto the spin axis (z)
    const tex = this.floorTex(cfg.diskBowl ? 'grass' : 'deck');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set((2 * Math.PI * R) / 6, (2 * (R + T)) / 6);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.1 }));
    mesh.receiveShadow = true;
    this.level.add(mesh);
    const ring = (r: number, color: number) => {
      const p: THREE.Vector3[] = [];
      for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; p.push(new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), h(r) + 0.04)); }
      this.level.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color })));
    };
    for (let r = 20; r < R; r += 20) ring(r, 0x8a96a8);
    ring(R - 0.2, 0xff5a2a);
    // flat disk: beyond here "down" leans more than ~53 degrees from the floor
    if (!cfg.diskBowl) { const lim = ((4 / 3) * R) / cfg.planetSpin; if (lim < R) ring(lim, 0xff5a2a); }
    // a beacon on the axis
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 10, 12), new THREE.MeshStandardMaterial({ color: 0x9aa3ae, emissive: 0x0c1218, metalness: 0.55, roughness: 0.32 }));
    mast.rotation.x = Math.PI / 2;
    mast.position.set(0, 0, 5);
    const lamp = this.makeGlowSprite(0x7fd8ff, 5);
    lamp.position.set(0, 0, 11);
    this.level.add(mast, lamp);
    this.buildBoxes(cfg, level);
    this.buildSky(cfg);
  }

  /** A torus: seen from inside (Stanford torus) or outside (the log). */
  private tubeMesh(cfg: SimConfig, kind: 'inside' | 'outside', a: number): THREE.Mesh {
    const R = cfg.R;
    const rc = kind === 'outside' ? R + a : R - a;
    const tubular = Math.min(1440, Math.max(192, Math.round((2 * Math.PI * R) / 1.5)));
    const radial = Math.max(48, Math.round((2 * Math.PI * a) / 1.2));
    const g = new THREE.TorusGeometry(rc, a, radial, tubular);
    const tex = this.floorTex('deck');
    tex.repeat.set((2 * Math.PI * R) / 5, (2 * Math.PI * a) / 5);
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, side: kind === 'inside' ? THREE.BackSide : THREE.FrontSide, roughness: 0.85, metalness: 0.2 }));
    mesh.receiveShadow = true;
    if (kind === 'inside') {
      // a window strip along the ceiling (the side nearest the axis): the tube's sky
      const strip = new THREE.Mesh(new THREE.CylinderGeometry(rc - a + 0.05, rc - a + 0.05, a * 0.35, tubular, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xfff1c8, side: THREE.DoubleSide, fog: false }));
      strip.rotation.x = Math.PI / 2;
      mesh.add(strip);
      const glow = new THREE.PointLight(0xfff2dd, 0.6, 0, 0);
      mesh.add(glow);
    }
    if (kind === 'outside') {
      // a painted line along the top (the side facing the axis) and the slip-off lines
      for (const [lat, color] of [[0, 0xc9a43a], [Math.acos(0.6), 0xff5a2a], [-Math.acos(0.6), 0xff5a2a]] as const) {
        const pts: THREE.Vector3[] = [];
        const r = rc - (a + 0.03) * Math.cos(lat), z = (a + 0.03) * Math.sin(lat);
        for (let i = 0; i <= 512; i++) { const t = (i / 512) * Math.PI * 2; pts.push(new THREE.Vector3(r * Math.cos(t), r * Math.sin(t), z)); }
        mesh.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
      }
    }
    return mesh;
  }

  /**
   * A floor or deck shell (walking surface at radius r, `thickness` deep) with
   * rectangular holes cut out of it. The grid's lines include every hole edge,
   * so the cut-outs are exact; the holes get walls and an orange hazard edge.
   */
  private cutShell(r: number, W: number, holes: Hole[], R: number, thickness: number, kind: 'floor' | 'deck'): THREE.Group {
    const group = new THREE.Group();
    const us: number[] = [], vs: number[] = [];
    const nu = Math.min(720, Math.max(96, Math.round((2 * Math.PI * R) / 2)));
    for (let i = 0; i <= nu; i++) us.push((i / nu) * Math.PI * 2);
    const nv = Math.max(4, Math.round((2 * W) / 2));
    for (let j = 0; j <= nv; j++) vs.push(-W + (2 * W * j) / nv);
    const wrap = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    for (const h of holes) {
      us.push(wrap(h.angle - h.halfArc / R), wrap(h.angle + h.halfArc / R));
      vs.push(h.z - h.halfZ, h.z + h.halfZ);
    }
    const uniq = (a: number[]) => [...new Set(a.map((x) => Math.round(x * 1e6) / 1e6))].sort((x, y) => x - y);
    const U = uniq(us), V = uniq(vs).filter((v) => v >= -W - 1e-6 && v <= W + 1e-6);
    const inHole = (a: number, z: number) => holes.some((h) =>
      Math.abs(Math.atan2(Math.sin(a - h.angle), Math.cos(a - h.angle))) * R < h.halfArc && Math.abs(z - h.z) < h.halfZ);
    const surface = (rad: number, side: THREE.Side, mat: THREE.Material) => {
      const pos: number[] = [], uv: number[] = [];
      for (const a of U) for (const z of V) { pos.push(rad * Math.cos(a), rad * Math.sin(a), z); uv.push((a * R) / 5, z / 5); }
      const idx: number[] = [];
      const nV = V.length;
      for (let i = 0; i < U.length - 1; i++) for (let j = 0; j < nV - 1; j++) {
        if (inHole((U[i] + U[i + 1]) / 2, (V[j] + V[j + 1]) / 2)) continue;
        const a = i * nV + j, b = (i + 1) * nV + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.material.side = side;
      m.receiveShadow = true;
      m.castShadow = kind === 'deck';
      return m;
    };
    const tex = this.floorTex('deck');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    group.add(surface(r, THREE.DoubleSide, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.2 })));
    if (kind === 'deck') group.add(surface(r + thickness, THREE.DoubleSide, new THREE.MeshStandardMaterial({ color: 0x3a404a, roughness: 0.9, metalness: 0.4 })));
    // hole walls (through the thickness) and hazard edges
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a4f5a, side: THREE.DoubleSide, roughness: 0.8 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xff5a2a });
    for (const h of holes) {
      const a0 = h.angle - h.halfArc / R, a1 = h.angle + h.halfArc / R;
      const z0 = h.z - h.halfZ, z1 = h.z + h.halfZ;
      const n = Math.max(2, Math.ceil(h.halfArc));
      const pos: number[] = [];
      const quad = (p: number[][]) => pos.push(...p[0], ...p[1], ...p[2], ...p[2], ...p[1], ...p[3]);
      const P = (rad: number, a: number, z: number) => [rad * Math.cos(a), rad * Math.sin(a), z];
      const r0 = r, r1 = r + thickness;
      for (const a of [a0, a1]) quad([P(r0, a, z0), P(r0, a, z1), P(r1, a, z0), P(r1, a, z1)]);
      for (let i = 0; i < n; i++) {
        const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 1)) / n;
        for (const z of [z0, z1]) quad([P(r0, t0, z), P(r0, t1, z), P(r1, t0, z), P(r1, t1, z)]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      group.add(new THREE.Mesh(g, wallMat));
      const edge: THREE.Vector3[] = [];
      const re = r - 0.03;
      for (let i = 0; i <= n; i++) edge.push(new THREE.Vector3(...P(re, a0 + ((a1 - a0) * i) / n, z0)));
      for (let i = n; i >= 0; i--) edge.push(new THREE.Vector3(...P(re, a0 + ((a1 - a0) * i) / n, z1)));
      edge.push(edge[0].clone());
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(edge), edgeMat));
    }
    return group;
  }

  /** The floor as a mesh following the terrain (hills / sphere band). */
  private terrainMesh(cfg: SimConfig, level: Level): THREE.Mesh {
    const R = cfg.R, W = cfg.halfWidth + cfg.wallThickness;
    const span = 2 * Math.PI * R;
    const nu = Math.min(1400, Math.max(96, Math.round(span / 1.5)));
    const sphere = level.terrain!.sphere;
    // on a sphere, rows are evenly spaced in latitude (z = R sin(lat)), so the poles stay smooth
    const latMax = sphere ? Math.asin(Math.min(1, cfg.halfWidth / R)) : 0;
    const nv = sphere ? Math.min(160, Math.max(16, Math.round((2 * latMax * R) / 2))) : Math.min(120, Math.max(8, Math.round((2 * W) / 1.5)));
    const pos = new Float32Array((nu + 1) * (nv + 1) * 3);
    const uv = new Float32Array((nu + 1) * (nv + 1) * 2);
    const tile = level.terrain!.hills.length ? 4 : 5;
    let k = 0;
    for (let i = 0; i <= nu; i++) {
      const a = (i / nu) * Math.PI * 2;
      for (let j = 0; j <= nv; j++) {
        const z = sphere ? R * Math.sin(-latMax + (2 * latMax * j) / nv) : -W + (2 * W * j) / nv;
        const r = floorRadius(level, cfg, a, z);
        pos[k * 3] = r * Math.cos(a); pos[k * 3 + 1] = r * Math.sin(a); pos[k * 3 + 2] = z;
        uv[k * 2] = (a * R) / tile; uv[k * 2 + 1] = z / tile;
        k++;
      }
    }
    const wins = level.windows ?? [];
    const inWindow = (a: number) => wins.some((w) => Math.abs(Math.atan2(Math.sin(a - w.angle), Math.cos(a - w.angle))) * R < w.halfArc);
    // biomes: land strip k (centred on angle k/n of a turn) gets BIOMES[k]; otherwise one material
    const BIOMES = ['grass', 'sand', 'snow', 'rock'] as const;
    const nw = wins.length;
    const biomeOf = (a: number) => (cfg.biomes && nw ? Math.round(((((a / (2 * Math.PI)) * nw) % nw) + nw) % nw) % nw : 0);
    const idxs: number[][] = [[], [], [], []];
    for (let i = 0; i < nu; i++) {
      const ac = ((i + 0.5) / nu) * Math.PI * 2;
      if (nw && inWindow(ac)) continue; // glass there (drawn separately)
      const list = idxs[biomeOf(ac) % 4];
      for (let j = 0; j < nv; j++) {
        const a = i * (nv + 1) + j, b = (i + 1) * (nv + 1) + j;
        list.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const idx = idxs.flat();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = this.floorTex(level.terrain!.hills.length ? 'grass' : 'deck');
    const mats: THREE.Material[] = [new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.05 })];
    if (cfg.biomes && nw) {
      // one draw group (and texture) per biome
      let start = 0;
      g.clearGroups();
      idxs.forEach((list, k) => {
        if (k > 0) {
          const t = this.textures[BIOMES[k]].clone();
          t.needsUpdate = true;
          mats.push(new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.05 }));
        }
        if (list.length) g.addGroup(start, list.length, k);
        start += list.length;
      });
    }
    const mesh = new THREE.Mesh(g, mats.length > 1 ? mats : mats[0]);
    mesh.receiveShadow = true;
    // O'Neill windows: faintly tinted glass with mullions, flush with the floor
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc8ff, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0, side: THREE.DoubleSide, depthWrite: false });
    const frame = new THREE.LineBasicMaterial({ color: 0x5a6a80, transparent: true, opacity: 0.6 });
    for (const w of level.windows ?? []) {
      // the grid snaps to whole cells, so span exactly the cells left out above
      const i0 = Math.ceil(((w.angle - w.halfArc / R) / (2 * Math.PI)) * nu - 0.5), i1 = Math.floor(((w.angle + w.halfArc / R) / (2 * Math.PI)) * nu - 0.5);
      const a0 = (i0 / nu) * 2 * Math.PI, a1 = ((i1 + 1) / nu) * 2 * Math.PI;
      const gg = new THREE.CylinderGeometry(R, R, 2 * W, Math.max(8, i1 - i0 + 1), 1, true, a0 + Math.PI / 2, a1 - a0);
      gg.rotateX(Math.PI / 2);
      const pane = new THREE.Mesh(gg, glass);
      mesh.add(pane);
      const pts: number[] = [];
      for (let z = -W; z <= W; z += 50) for (let k = 0; k < 64; k++) {
        const t0 = a0 + ((a1 - a0) * k) / 64, t1 = a0 + ((a1 - a0) * (k + 1)) / 64;
        pts.push(R * Math.cos(t0), R * Math.sin(t0), z, R * Math.cos(t1), R * Math.sin(t1), z);
      }
      for (let k = 0; k <= 12; k++) { const t = a0 + ((a1 - a0) * k) / 12; pts.push(R * Math.cos(t), R * Math.sin(t), -W, R * Math.cos(t), R * Math.sin(t), W); }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      mesh.add(new THREE.LineSegments(lg, frame));
    }
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
      const rIn = Math.max(0, R - h); // (a wall taller than the floor radius closes a sphere's pole)
      const inner = new THREE.Mesh(new THREE.RingGeometry(rIn, R, segsPer, 1, a0, step), isLow ? low : tall);
      inner.position.z = sgn * W;
      const outer = new THREE.Mesh(new THREE.RingGeometry(rIn, cfg.R + hull, segsPer, 1, a0, step), outerMat);
      outer.position.z = sgn * (W + T);
      // Cylinder theta 0 maps to ring angle -pi/2 after rotateX(pi/2).
      const topGeo = new THREE.CylinderGeometry(Math.max(0.01, rIn), Math.max(0.01, rIn), T, segsPer, 1, true, a0 + Math.PI / 2, step);
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
    if (cfg.planetPull > 0) this.buildSkyhook(cfg, planet.position, Rs * 0.18 * 2.4);
  }

  /**
   * What holds the ring up over the planet: a tower from the planet's surface
   * to a bearing on the ring's axle, off to one side of the ring. The tower is
   * fixed to the stars (it turns in the ring's view); the axle and the spokes
   * out to the rim turn with the ring.
   */
  private buildSkyhook(cfg: SimConfig, planetPos: THREE.Vector3, planetRadius: number) {
    const R = cfg.R, W = cfg.halfWidth;
    const metal = new THREE.MeshStandardMaterial({ color: 0x8a8f9c, metalness: 0.7, roughness: 0.45, fog: false });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, metalness: 0.6, roughness: 0.5, fog: false });
    const glow = new THREE.MeshBasicMaterial({ color: 0x6ad8ff, fog: false });
    const strut = (a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, m: THREE.Material) => {
      const len = a.distanceTo(b);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 12, 1), m);
      c.position.copy(a).add(b).multiplyScalar(0.5);
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      c.castShadow = true;
      return c;
    };
    const hubZ = -(W + R * 0.45);
    const hub = new THREE.Vector3(0, 0, hubZ);
    // tower: from the planet's surface (nearest point to the hub) up to the bearing
    const toHub = hub.clone().sub(planetPos).normalize();
    const base = planetPos.clone().addScaledVector(toHub, planetRadius * 0.98);
    const top = hub.clone().addScaledVector(toHub, -R * 0.06);
    this.inertial.add(strut(base, top, R * 0.12, R * 0.035, metal));
    // a few braces near the base so it reads as a structure, not a stick
    const side = new THREE.Vector3(0, 0, 1).cross(toHub).normalize();
    for (const sgn of [-1, 1]) {
      const foot = base.clone().addScaledVector(side, sgn * R * 0.6);
      this.inertial.add(strut(foot, base.clone().lerp(top, 0.25), R * 0.03, R * 0.02, dark));
    }
    const bearing = new THREE.Mesh(new THREE.TorusGeometry(R * 0.06, R * 0.015, 12, 32), glow);
    bearing.position.copy(hub);
    this.inertial.add(bearing);
    // turning with the ring: the axle stub and spokes out to the rim
    this.level.add(strut(hub.clone().setZ(hubZ - R * 0.05), new THREE.Vector3(0, 0, -W - 2), R * 0.03, R * 0.03, dark));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const rim = new THREE.Vector3(Math.cos(a) * (R + cfg.hullThickness), Math.sin(a) * (R + cfg.hullThickness), -W - cfg.wallThickness);
      this.level.add(strut(new THREE.Vector3(0, 0, hubZ * 0.85), rim, R * 0.012, R * 0.012, metal));
    }
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
