// Dynamic entity views. Reads sim state only; interpolates positions between
// the previous and current tick.

import * as THREE from 'three';
import { type Prediction, type SimState, type Vec3, localBasis, PLAYER_HALF_SEG, PLAYER_RADIUS } from '../sim';
import { makeGun, makePickup } from './models';
import { LAYER_INERTIAL_ONLY, LAYER_ROT_TRAILS, LAYER_SELF, type RingScene } from './scene';

const PICKUP_GLOW: Record<string, number> = {
  health: 0xff6060, sticky: 0x7fb6ff, bounce: 0xffd23a, redRifle: 0xff4a3a, launcher: 0x9dff3a, laser: 0xbffcff, jetpack: 0xffa040,
  rifle: 0x55c8ff, pistol: 0x8dff5a,
};

export type PosMap = Map<number, Vec3>;

const BOLT_COLORS: Record<string, number> = {
  rifle: 0x55c8ff, redRifle: 0xff4a3a, pistol: 0x8dff5a, overcharge: 0x5dff7a, fuelRod: 0x9dff3a, laser: 0xbffcff,
  hover: 0xff5ee8, grenade: 0x7fb6ff, bounceGrenade: 0xffd23a,
};

/** Fading polyline trail stored as a ring buffer. */
class Trail {
  line: THREE.Line;
  pos: Float32Array;
  col: Float32Array;
  pts: number[] = []; // flat xyz history (oldest first)
  constructor(public max: number, public color: THREE.Color, layer: number, parent: THREE.Object3D) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setDrawRange(0, 0);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.line.frustumCulled = false;
    this.line.layers.set(layer);
    parent.add(this.line);
  }
  push(x: number, y: number, z: number) {
    this.pts.push(x, y, z);
    if (this.pts.length > this.max * 3) this.pts.splice(0, this.pts.length - this.max * 3);
  }
  update(head?: Vec3) {
    let n = this.pts.length / 3;
    this.pos.set(this.pts);
    if (head && n < this.max) {
      this.pos.set(head, n * 3);
      n++;
    }
    for (let i = 0; i < n; i++) {
      const f = Math.pow((i + 1) / n, 1.6);
      this.col[i * 3] = this.color.r * f;
      this.col[i * 3 + 1] = this.color.g * f;
      this.col[i * 3 + 2] = this.color.b * f;
    }
    const g = this.line.geometry;
    g.setDrawRange(0, n);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose() {
    this.line.removeFromParent();
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}

interface ProjView {
  sprite: THREE.Sprite;
  core: THREE.Mesh;
  trail: Trail;
  inTrail: Trail;
  marker: THREE.Sprite; // big dot for the inertial overview camera
  baseSize: number;
  dying: number; // frames left for the trail to fade after the projectile is gone
}

interface PlayerView {
  group: THREE.Group;
  body: THREE.Mesh;
  shieldFlash: number;
  marker: THREE.Sprite;
  gunHolder: THREE.Group; // floating gun beside the player, pitched with their aim
  gunWeapon: number;
  flame: THREE.Sprite; // jetpack exhaust
}

interface PickupView {
  group: THREE.Group;
  model: THREE.Group;
  glow: THREE.Sprite;
}

export class EntityViews {
  root = new THREE.Group();
  players = new Map<number, PlayerView>();
  projs = new Map<number, ProjView>();
  props = new Map<number, THREE.Mesh>();
  explosions = new Map<number, THREE.Mesh>();
  pickups = new Map<number, PickupView>();
  /** First-person gun, attached to the camera (main view only). */
  viewModel = new THREE.Group();
  private viewWeapon = -1;
  trailTicks = 180;
  localId = -1;
  cameraPos = new THREE.Vector3();
  preview: THREE.Line;
  previewMarker: THREE.Mesh;
  private previewPos = new Float32Array(4000 * 3);
  private flashLight = new THREE.PointLight(0x9fd0ff, 0, 40, 1.5);
  private flashT = 0;

  constructor(private rs: RingScene) {
    rs.scene.add(this.root);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.previewPos, 3));
    this.preview = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.8, fog: false, depthTest: false }));
    this.preview.frustumCulled = false;
    this.preview.visible = false;
    this.preview.renderOrder = 10;
    this.previewMarker = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.06, 6, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, fog: false }));
    this.previewMarker.renderOrder = 10;
    this.previewMarker.visible = false;
    this.root.add(this.preview, this.previewMarker, this.flashLight);
    this.viewModel.position.set(0.2, -0.17, -0.42);
    this.viewModel.scale.setScalar(0.38);
    this.viewModel.rotation.y = Math.PI / 2; // gun +X -> camera forward (-Z)
  }

  private beams: { line: THREE.Line; t: number }[] = [];

  /** A brief fading beam for the pulse laser (its bolt lands within a tick or two, too fast for a trail). */
  addBeam(from: Vec3, to: Vec3) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...from), new THREE.Vector3(...to)]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xbffcff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    line.frustumCulled = false;
    this.root.add(line);
    this.beams.push({ line, t: 1 });
  }

  /** Show the local player's current weapon in first person. */
  setViewWeapon(weapon: number, visible: boolean) {
    this.viewModel.visible = visible;
    if (weapon === this.viewWeapon) return;
    this.viewModel.clear();
    const gun = makeGun(weapon);
    gun.traverse((o) => o.layers.set(LAYER_ROT_TRAILS)); // main camera only
    this.viewModel.add(gun);
    this.viewWeapon = weapon;
  }

  reset() {
    for (const v of this.players.values()) v.group.removeFromParent();
    for (const v of this.projs.values()) this.disposeProj(v);
    for (const v of this.props.values()) v.removeFromParent();
    for (const v of this.explosions.values()) v.removeFromParent();
    for (const v of this.pickups.values()) v.group.removeFromParent();
    this.players.clear(); this.projs.clear(); this.props.clear(); this.explosions.clear(); this.pickups.clear();
  }

  private makeGlow(color: number, size: number, layer = 0) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.rs.glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    s.scale.setScalar(size);
    s.layers.set(layer);
    return s;
  }

  private disposeProj(v: ProjView) {
    v.sprite.removeFromParent(); v.core.removeFromParent(); v.marker.removeFromParent();
    v.trail.dispose(); v.inTrail.dispose();
  }

  /** Called once per sim tick: record trail points. */
  onTick(state: SimState) {
    const fa = state.frameAngle;
    const c = Math.cos(fa), s = Math.sin(fa);
    const seen = new Set<number>();
    const projs: { id: number; pos: Vec3; kind: string; radius: number }[] = [
      ...state.bolts.map((b) => ({ id: b.id, pos: b.pos, kind: b.kind, radius: b.radius })),
      ...state.grenades.map((g) => ({ id: g.id, pos: g.pos, kind: g.variant === 'bounce' ? 'bounceGrenade' : 'grenade', radius: g.radius })),
    ];
    for (const p of projs) {
      seen.add(p.id);
      let v = this.projs.get(p.id);
      if (!v) v = this.createProj(p.id, p.kind, p.radius);
      if (state.tick % 2 === 0) {
        v.trail.push(p.pos[0], p.pos[1], p.pos[2]);
        // inertial coordinates: rotate by +frameAngle; the inertial group renders at -frameAngle
        v.inTrail.push(c * p.pos[0] - s * p.pos[1], s * p.pos[0] + c * p.pos[1], p.pos[2]);
      }
    }
    for (const [id, v] of this.projs) {
      if (seen.has(id)) continue;
      if (v.dying < 0) {
        v.dying = 30;
        v.sprite.visible = false; v.core.visible = false; v.marker.visible = false;
      }
    }
  }

  private createProj(id: number, kind: string, radius: number): ProjView {
    const color = BOLT_COLORS[kind] ?? 0xffffff;
    const sprite = this.makeGlow(color, radius * ((kind === 'grenade' || kind === 'bounceGrenade') ? 7 : kind === 'laser' ? 12 : 6));
    const core = new THREE.Mesh(new THREE.SphereGeometry(radius * ((kind === 'grenade' || kind === 'bounceGrenade') ? 1 : 0.45), 12, 8), new THREE.MeshBasicMaterial({ color: kind === 'grenade' ? 0xcfe4ff : kind === 'bounceGrenade' ? 0xfff0a0 : 0xffffff, fog: false }));
    const marker = this.makeGlow(color, Math.max(1.5, this.rs.starRadius / 1500), LAYER_INERTIAL_ONLY);
    const max = Math.max(4, Math.round(this.trailTicks / 2));
    const trail = new Trail(max, new THREE.Color(color), LAYER_ROT_TRAILS, this.root);
    const inTrail = new Trail(max, new THREE.Color(color), LAYER_INERTIAL_ONLY, this.rs.inertial);
    this.root.add(sprite, core, marker);
    const v: ProjView = { sprite, core, trail, inTrail, marker, baseSize: sprite.scale.x, dying: -1 };
    this.projs.set(id, v);
    return v;
  }

  private createPlayer(id: number, kind: string): PlayerView {
    const group = new THREE.Group();
    const color = kind === 'human' ? 0x3d7bd9 : kind === 'bot' ? 0xd2553a : 0xd8c040;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HALF_SEG * 2, 6, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.5, emissive: 0x000000 }));
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.5), new THREE.MeshStandardMaterial({ color: 0xffb030, emissive: 0x6a3a00, metalness: 0.9, roughness: 0.2 }));
    visor.position.set(PLAYER_RADIUS - 0.04, 0.62, 0);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 0.5), new THREE.MeshStandardMaterial({ color: 0x333a44 }));
    pack.position.set(-PLAYER_RADIUS, 0.2, 0);
    const gunHolder = new THREE.Group();
    gunHolder.position.set(0.15, 0.45, 0.42); // floating at the right hand (local +Z = right)
    const flame = this.makeGlow(0xff8a2a, 0.9);
    flame.position.set(-PLAYER_RADIUS - 0.1, -0.35, 0);
    flame.visible = false;
    group.add(body, visor, pack, gunHolder, flame);
    if (kind === 'dummy') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.05, 6, 20), new THREE.MeshBasicMaterial({ color: 0xff3020 }));
      ring.rotation.y = Math.PI / 2;
      ring.position.set(0.3, 0.1, 0);
      group.add(ring);
    }
    if (id === this.localId) group.traverse((o) => o.layers.set(LAYER_SELF));
    const marker = this.makeGlow(kind === 'human' ? 0x66aaff : 0xff6644, Math.max(4, this.rs.starRadius / 600), LAYER_INERTIAL_ONLY);
    this.root.add(group, marker);
    const v = { group, body, shieldFlash: 0, marker, gunHolder, gunWeapon: -1, flame };
    this.players.set(id, v);
    return v;
  }

  flashHit(id: number) {
    const v = this.players.get(id);
    if (v) v.shieldFlash = 1;
  }

  explosionFlash(pos: Vec3) {
    this.flashLight.position.set(pos[0], pos[1], pos[2]);
    this.flashT = 1;
  }

  /** Per-frame: interpolate and place everything. */
  render(state: SimState, prev: PosMap, alpha: number, dtReal: number) {
    const lerpPos = (id: number, cur: Vec3): Vec3 => {
      const p = prev.get(id);
      if (!p) return cur;
      return [p[0] + (cur[0] - p[0]) * alpha, p[1] + (cur[1] - p[1]) * alpha, p[2] + (cur[2] - p[2]) * alpha];
    };
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qy = new THREE.Quaternion();
    const Y = new THREE.Vector3(0, 1, 0);

    // players
    const seenP = new Set<number>();
    for (const p of state.players) {
      seenP.add(p.id);
      const v = this.players.get(p.id) ?? this.createPlayer(p.id, p.kind);
      v.group.visible = p.alive;
      v.marker.visible = p.alive;
      if (!p.alive) continue;
      const pos = lerpPos(p.id, p.pos);
      const b = localBasis(pos);
      m.makeBasis(new THREE.Vector3(...b.spin), new THREE.Vector3(...b.up), new THREE.Vector3(...b.axial));
      q.setFromRotationMatrix(m);
      qy.setFromAxisAngle(Y, -p.yaw);
      v.group.quaternion.copy(q).multiply(qy);
      v.group.position.set(pos[0], pos[1], pos[2]);
      v.marker.position.copy(v.group.position);
      if (v.gunWeapon !== p.weapon) {
        v.gunHolder.clear();
        const gun = makeGun(p.weapon);
        if (p.id === this.localId) gun.traverse((o) => o.layers.set(LAYER_SELF));
        v.gunHolder.add(gun);
        v.gunWeapon = p.weapon;
      }
      v.gunHolder.rotation.z = p.pitch; // tip the gun up/down with the aim
      v.flame.visible = p.jetting;
      if (p.jetting) v.flame.scale.setScalar(0.7 + Math.random() * 0.5);
      const mat = v.body.material as THREE.MeshStandardMaterial;
      v.shieldFlash = Math.max(0, v.shieldFlash - dtReal * 4);
      const shieldFrac = p.shield / state.config.maxShield;
      mat.emissive.setRGB(0.2 * v.shieldFlash, 0.5 * v.shieldFlash * (shieldFrac > 0 ? 1 : 0.2), 1.0 * v.shieldFlash * (shieldFrac > 0 ? 1 : 0.1));
    }
    for (const [id, v] of this.players) if (!seenP.has(id)) { v.group.removeFromParent(); v.marker.removeFromParent(); this.players.delete(id); }

    // projectiles
    const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.03);
    const live = new Map<number, { pos: Vec3; stuck: boolean }>();
    for (const b of state.bolts) live.set(b.id, { pos: b.pos, stuck: false });
    for (const g of state.grenades) live.set(g.id, { pos: g.pos, stuck: g.stuck !== null });
    for (const [id, v] of this.projs) {
      const l = live.get(id);
      if (l) {
        const pos = lerpPos(id, l.pos);
        v.sprite.position.set(pos[0], pos[1], pos[2]);
        // keep glows from swamping the screen right at the muzzle
        const dCam = this.cameraPos.distanceTo(v.sprite.position);
        v.sprite.scale.setScalar(Math.min(v.baseSize, Math.max(0.05, dCam * 0.08)));
        v.core.position.copy(v.sprite.position);
        v.marker.position.copy(v.sprite.position);
        if (l.stuck) v.sprite.material.opacity = 0.5 + 0.5 * Math.sin(performance.now() * 0.04);
        else v.sprite.material.opacity = pulse;
        v.trail.update(pos);
        v.inTrail.update();
      } else {
        v.dying--;
        const f = Math.max(0, v.dying / 30);
        (v.trail.line.material as THREE.LineBasicMaterial).opacity = f;
        (v.inTrail.line.material as THREE.LineBasicMaterial).opacity = f;
        if (v.dying <= 0) { this.disposeProj(v); this.projs.delete(id); }
      }
    }

    // props
    const seenR = new Set<number>();
    for (const pr of state.props) {
      seenR.add(pr.id);
      let mesh = this.props.get(pr.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(pr.radius, 20, 14), new THREE.MeshStandardMaterial({ map: this.rs.textures.ball, roughness: 0.5 }));
        this.root.add(mesh);
        this.props.set(pr.id, mesh);
      }
      const old = mesh.position.clone();
      const pos = lerpPos(pr.id, pr.pos);
      mesh.position.set(pos[0], pos[1], pos[2]);
      // fake rolling for looks (props have no rigid-body rotation in the sim)
      const d = mesh.position.clone().sub(old);
      const dl = d.length();
      if (dl > 1e-5 && dl < 5) {
        const up = new THREE.Vector3(...localBasis(pos).up);
        const axis = up.cross(d).normalize();
        mesh.rotateOnWorldAxis(axis, -dl / pr.radius);
      }
    }
    for (const [id, mesh] of this.props) if (!seenR.has(id)) { mesh.removeFromParent(); this.props.delete(id); }

    // pickups: floating, spinning, glowing; hidden while waiting to respawn
    const seenK = new Set<number>();
    const tNow = performance.now() / 1000;
    for (const it of state.pickups) {
      seenK.add(it.id);
      let v = this.pickups.get(it.id);
      if (!v) {
        const group = new THREE.Group();
        const model = makePickup(it.item);
        const glow = this.makeGlow(PICKUP_GLOW[it.item] ?? 0xffffff, 1.6);
        glow.material.opacity = 0.45;
        group.add(model, glow);
        this.root.add(group);
        v = { group, model, glow };
        this.pickups.set(it.id, v);
      }
      const active = state.tick >= it.activeAt;
      // dropped items blink for their last 5 seconds
      const ending = it.expireTick >= 0 && it.expireTick - state.tick < 600;
      v.group.visible = active && (!ending || Math.sin(tNow * 12) > 0);
      if (!v.group.visible) continue;
      const b = localBasis(it.pos);
      m.makeBasis(new THREE.Vector3(...b.spin), new THREE.Vector3(...b.up), new THREE.Vector3(...b.axial));
      v.group.quaternion.setFromRotationMatrix(m);
      const bob = 0.12 * Math.sin(tNow * 2 + it.id);
      v.group.position.set(it.pos[0] + b.up[0] * bob, it.pos[1] + b.up[1] * bob, it.pos[2] + b.up[2] * bob);
      v.model.rotation.y = tNow * 1.5 + it.id;
    }
    for (const [id, v] of this.pickups) if (!seenK.has(id)) { v.group.removeFromParent(); this.pickups.delete(id); }

    // explosions
    const seenE = new Set<number>();
    for (const e of state.explosions) {
      seenE.add(e.id);
      let mesh = this.explosions.get(e.id);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0x8fc6ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        mesh.position.set(e.pos[0], e.pos[1], e.pos[2]);
        this.root.add(mesh);
        this.explosions.set(e.id, mesh);
      }
      const t = (state.tick - e.tick + alpha) / (e.endTick - e.tick);
      mesh.scale.setScalar(Math.max(0.1, e.radius * Math.sqrt(Math.min(1, t * 1.5))));
      (mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 * (1 - t));
    }
    for (const [id, mesh] of this.explosions) if (!seenE.has(id)) { mesh.removeFromParent(); this.explosions.delete(id); }

    for (const b of this.beams) {
      b.t -= dtReal * 2.5;
      (b.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, b.t);
      if (b.t <= 0) { b.line.removeFromParent(); b.line.geometry.dispose(); }
    }
    this.beams = this.beams.filter((b) => b.t > 0);
    this.flashT = Math.max(0, this.flashT - dtReal * 3);
    this.flashLight.intensity = 60 * this.flashT;
  }

  setPreview(pred: Prediction | null, color: number) {
    if (!pred || pred.points.length < 2) {
      this.preview.visible = false;
      this.previewMarker.visible = false;
      return;
    }
    const n = Math.min(pred.points.length, 4000);
    for (let i = 0; i < n; i++) this.previewPos.set(pred.points[i], i * 3);
    const g = this.preview.geometry;
    g.setDrawRange(0, n);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    g.computeBoundingSphere();
    this.preview.computeLineDistances();
    (this.preview.material as THREE.LineDashedMaterial).color.setHex(color);
    this.preview.visible = true;
    if (pred.hit) {
      const b = localBasis(pred.hit);
      this.previewMarker.position.set(...pred.hit);
      this.previewMarker.lookAt(pred.hit[0] + b.up[0], pred.hit[1] + b.up[1], pred.hit[2] + b.up[2]);
      this.previewMarker.visible = true;
    } else this.previewMarker.visible = false;
  }
}

export { BOLT_COLORS };
