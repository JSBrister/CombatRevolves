// Dynamic entity views. Reads sim state only; interpolates positions between
// the previous and current tick.

import * as THREE from 'three';
import { type Player, type Prediction, type SimEvent, type SimState, type Vec3, localBasis, PLAYER_HALF_SEG, PLAYER_RADIUS, WEAPON_HAMMER, WEAPON_LACONIC, WEAPON_PISTOL } from '../sim';
import { makeBike, makeGun, makePickup } from './models';
import { LAYER_INERTIAL_ONLY, LAYER_ROT_TRAILS, LAYER_SELF, type RingScene } from './scene';

const PICKUP_GLOW: Record<string, number> = {
  health: 0xff6060, sticky: 0x7fb6ff, bounce: 0xffd23a, redRifle: 0xff4a3a, launcher: 0x9dff3a, cannon: 0xff3df0, laconic: 0xff2a1a, hammer: 0x9ad0ff, jetpack: 0xffa040,
  rocket: 0xffa03a, seeker: 0xff6ad8,
  rifle: 0x55c8ff, pistol: 0x8dff5a,
};

export type PosMap = Map<number, Vec3>;

/** How far along a gun model (+X) its muzzle is. */
const MUZZLE_TIP: Record<number, number> = { 1: 0.27, 5: 1.08 };

const BOLT_COLORS: Record<string, number> = {
  rifle: 0x55c8ff, redRifle: 0xff4a3a, pistol: 0x8dff5a, overcharge: 0x5dff7a, fuelRod: 0x9dff3a, cannon: 0xff3df0, laconic: 0xff2a1a,
  hover: 0xff5ee8, grenade: 0x7fb6ff, bounceGrenade: 0xffd23a, rocket: 0xffa03a, seeker: 0xff6ad8,
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
  chargeGlow: THREE.Sprite; // at the muzzle: the laser (red) or pistol overcharge (green) charging
  flame: THREE.Sprite; // jetpack exhaust
  shell: THREE.Mesh; // shield bubble, a little outside the body
  shellGlow: number; // 0..1, decays
  prevShield: number;
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
  vehicles = new Map<number, { group: THREE.Group; glow: THREE.Sprite }>();
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

  private beams: { line: THREE.Mesh; t: number }[] = [];

  /** If true, the local player's own shield bubble is drawn (free-fly / inertial views). */
  showSelf = false;
  private splashes: { s: THREE.Sprite; t: number; size: number }[] = [];
  /** Mallet swings: the arc that was hit (sweeps across, then fades) and each swinger's progress. */
  private arcs: { mesh: THREE.Mesh; t: number; half: number; inner: number; reach: number }[] = [];
  private swingT = new Map<number, number>();
  private fpSwing = -1; // first-person swing progress 0..1 (-1 = none)

  /** A quick glow where a shot lands (or a shield pops). */
  burst(pos: Vec3, color: number, size: number) {
    const s = this.makeGlow(color, size * 0.3);
    s.position.set(pos[0], pos[1], pos[2]);
    this.root.add(s);
    this.splashes.push({ s, t: 1, size });
  }

  /** A brief fading beam (Laconic Laser bolts land within a tick or two: too fast for a trail). Drawn as a glowing rod. */
  addBeam(from: Vec3, to: Vec3, color = 0xff2a1a) {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const length = a.distanceTo(b);
    if (length < 0.01) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, length, 8, 1, true), mat);
    rod.position.copy(a).add(b).multiplyScalar(0.5);
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    rod.frustumCulled = false;
    this.root.add(rod);
    this.beams.push({ line: rod, t: 1 });
  }

  /** A mallet swing: animate the swinger and flash the arc it hit. */
  swing(e: Extract<SimEvent, { type: 'melee' }>) {
    if (!e.mallet) return;
    this.swingT.set(e.id, 0);
    if (e.id === this.localId) this.fpSwing = 0;
    const X = new THREE.Vector3(...e.aim).normalize();
    const Z = new THREE.Vector3(...e.up);
    Z.addScaledVector(X, -Z.dot(X));
    if (Z.lengthSq() < 1e-6) Z.set(0, 0, 1);
    Z.normalize();
    const Y = new THREE.Vector3().crossVectors(Z, X);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9ad0ff, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    // start a little in front of the eye so it doesn't fill your own view
    mesh.position.set(...e.from);
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.arcs.push({ mesh, t: 0, half: Math.acos(Math.max(-1, Math.min(1, e.cone))), inner: e.reach * 0.55, reach: e.reach });
  }

  jab = 0; // 0..1, set to 1 on a melee
  reloadDip = 0; // 0..1 while reloading

  /** Show the local player's current weapon in first person. */
  /** Glow at the muzzle while a weapon charges: red for the Laconic Laser (also while it streams), green for the pistol. */
  setChargeGlow(glow: THREE.Sprite, p: Player, tick: number) {
    const laser = p.weapon === WEAPON_LACONIC, pistol = p.weapon === WEAPON_PISTOL;
    const streaming = laser && tick < p.burstUntil;
    const k = streaming ? 1 : (laser || pistol) ? p.charge : 0;
    glow.visible = p.alive && k > 0.02;
    if (!glow.visible) return;
    glow.material.color.setHex(laser ? (k > 0.95 ? 0xffb090 : 0xff5030) : 0x9dffb0);
    glow.position.set((MUZZLE_TIP[p.weapon] ?? 0.4) + 0.12, 0, 0);
    const flicker = 0.85 + 0.15 * Math.sin(performance.now() * (streaming ? 0.08 : 0.02));
    glow.scale.setScalar((laser ? 2.6 : 1.0) * (0.3 + k) * flicker);
    glow.material.opacity = 1;
  }

  /** First-person charge glow (on the view model). */
  private fpGlow: THREE.Sprite | null = null;
  setViewCharge(p: Player | undefined, tick: number) {
    if (!this.fpGlow) {
      this.fpGlow = this.makeGlow(0xff2a1a, 1, LAYER_ROT_TRAILS);
      this.fpGlow.visible = false;
    }
    if (this.fpGlow.parent !== this.viewModel.children[0] && this.viewModel.children[0]) this.viewModel.children[0].add(this.fpGlow);
    if (!p) { this.fpGlow.visible = false; return; }
    this.setChargeGlow(this.fpGlow, p, tick);
  }

  setViewWeapon(weapon: number, visible: boolean) {
    this.viewModel.visible = visible;
    if (weapon === this.viewWeapon) return;
    this.viewModel.clear();
    const gun = makeGun(weapon);
    gun.traverse((o) => o.layers.set(LAYER_ROT_TRAILS)); // main camera only
    if (weapon === WEAPON_HAMMER) gun.position.x = 0.3; // pivot at the grip, so a swing sweeps the head
    this.viewModel.add(gun);
    this.viewWeapon = weapon;
  }

  reset() {
    for (const v of this.players.values()) v.group.removeFromParent();
    for (const v of this.projs.values()) this.disposeProj(v);
    for (const v of this.props.values()) v.removeFromParent();
    for (const v of this.explosions.values()) v.removeFromParent();
    for (const v of this.pickups.values()) v.group.removeFromParent();
    for (const v of this.vehicles.values()) v.group.removeFromParent();
    this.vehicles.clear();
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
    const sprite = this.makeGlow(color, radius * ((kind === 'grenade' || kind === 'bounceGrenade') ? 7 : kind === 'cannon' || kind === 'laconic' ? 9 : 6));
    const rocket = kind === 'rocket' || kind === 'seeker';
    const core = rocket
      // a rocket body along local +Y (turned to the nose every frame); its glow is the exhaust
      ? new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.35, radius * 0.6, radius * (kind === 'rocket' ? 6 : 4), 10), new THREE.MeshStandardMaterial({ color: kind === 'rocket' ? 0xd8d0c0 : 0xff9ae8, emissive: kind === 'rocket' ? 0x222018 : 0x601848, metalness: 0.6, roughness: 0.4 }))
      : new THREE.Mesh(new THREE.SphereGeometry(radius * ((kind === 'grenade' || kind === 'bounceGrenade') ? 1 : 0.45), 12, 8), new THREE.MeshBasicMaterial({ color: kind === 'grenade' ? 0xcfe4ff : kind === 'bounceGrenade' ? 0xfff0a0 : 0xffffff, fog: false }));
    const marker = this.makeGlow(color, Math.max(1.5, this.rs.starRadius / 1500), LAYER_INERTIAL_ONLY);
    const max = Math.max(4, Math.round(this.trailTicks / 2));
    const trail = new Trail(max, new THREE.Color(color), LAYER_ROT_TRAILS, this.root);
    const inTrail = new Trail(max, new THREE.Color(color), LAYER_INERTIAL_ONLY, this.rs.inertial);
    this.root.add(sprite, core, marker);
    const v: ProjView = { sprite, core, trail, inTrail, marker, baseSize: sprite.scale.x, dying: -1 };
    this.projs.set(id, v);
    return v;
  }

  private createPlayer(pl: Player): PlayerView {
    const id = pl.id, kind = pl.kind;
    const group = new THREE.Group();
    const color = pl.color >= 0 ? pl.color : kind === 'human' ? 0x3d7bd9 : kind === 'bot' ? 0xd2553a : 0xd8c040;
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
    // shield bubble: a slightly larger capsule, additive, normally invisible
    const shell = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER_RADIUS * 1.25, PLAYER_HALF_SEG * 2 + 0.1, 6, 16),
      new THREE.MeshBasicMaterial({ color: 0x6ad0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    body.castShadow = true;
    pack.castShadow = true;
    group.add(body, visor, pack, gunHolder, flame, shell);
    if (kind === 'dummy') {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.05, 6, 20), new THREE.MeshBasicMaterial({ color: 0xff3020 }));
      ring.rotation.y = Math.PI / 2;
      ring.position.set(0.3, 0.1, 0);
      group.add(ring);
    }
    if (id === this.localId) group.traverse((o) => o.layers.set(LAYER_SELF));
    const marker = this.makeGlow(kind === 'human' ? 0x66aaff : 0xff6644, Math.max(4, this.rs.starRadius / 600), LAYER_INERTIAL_ONLY);
    this.root.add(group, marker);
    const chargeGlow = this.makeGlow(0xff2a1a, 1, pl.id === this.localId ? LAYER_SELF : 0);
    chargeGlow.visible = false;
    gunHolder.add(chargeGlow);
    const v = { group, body, shieldFlash: 0, marker, gunHolder, gunWeapon: -1, chargeGlow, flame, shell, shellGlow: 0, prevShield: pl.shield };
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
      const v = this.players.get(p.id) ?? this.createPlayer(p);
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
      v.group.scale.setScalar(p.size);
      v.marker.position.copy(v.group.position);
      if (v.gunWeapon !== p.weapon) {
        v.gunHolder.clear();
        const gun = makeGun(p.weapon);
        if (p.id === this.localId) gun.traverse((o) => o.layers.set(LAYER_SELF));
        v.gunHolder.add(gun);
        v.gunWeapon = p.weapon;
      }
      v.gunHolder.rotation.z = p.pitch; // tip the gun up/down with the aim
      this.setChargeGlow(v.chargeGlow, p, state.tick);
      const sw = this.swingT.get(p.id);
      if (sw !== undefined && p.weapon === WEAPON_HAMMER) {
        // wind up over the right shoulder, then sweep across to the left
        const k = sw < 0.25 ? -sw / 0.25 : -1 + 2 * Math.sin(((sw - 0.25) / 0.75) * Math.PI / 2);
        v.gunHolder.rotation.y = 1.3 * k;
        v.gunHolder.rotation.x = -0.4 * (1 - Math.abs(k));
      } else { v.gunHolder.rotation.y = 0; v.gunHolder.rotation.x = 0; }
      v.flame.visible = p.jetting;
      if (p.jetting) v.flame.scale.setScalar(0.7 + Math.random() * 0.5);
      // Shields: the bubble flashes on hits, bursts when the shield breaks,
      // and shimmers while it recharges. Hits on bare health flash the body red.
      const mat = v.body.material as THREE.MeshStandardMaterial;
      v.shieldFlash = Math.max(0, v.shieldFlash - dtReal * 4);
      if (p.shield <= 0 && v.prevShield > 0) { v.shellGlow = 1.6; this.burst(pos, 0x6ad0ff, 1.6); }
      const recharging = p.shield > v.prevShield && p.shield < p.maxShield;
      if (p.shield > 0 && v.prevShield <= 0) this.burst(pos, 0x9ae8ff, 1.0); // shield back up
      v.prevShield = p.shield;
      v.shellGlow = Math.max(0, v.shellGlow - dtReal * 3);
      const hitGlow = p.shield > 0 ? v.shieldFlash : 0;
      const shimmer = recharging ? 0.18 + 0.12 * Math.sin(performance.now() * 0.02) : 0;
      (v.shell.material as THREE.MeshBasicMaterial).opacity = Math.min(0.85, Math.max(hitGlow * 0.7, v.shellGlow * 0.5, shimmer));
      v.shell.visible = p.id !== this.localId || this.showSelf;
      const bare = p.shield <= 0 ? v.shieldFlash : 0;
      mat.emissive.setRGB(0.9 * bare, 0.1 * bare, 0.05 * bare);
    }
    for (const [id, v] of this.players) if (!seenP.has(id)) { v.group.removeFromParent(); v.marker.removeFromParent(); this.players.delete(id); }

    // projectiles
    const pulse = 0.85 + 0.15 * Math.sin(performance.now() * 0.03);
    const live = new Map<number, { pos: Vec3; stuck: boolean; dir?: Vec3 | null; burning?: boolean }>();
    for (const b of state.bolts) live.set(b.id, { pos: b.pos, stuck: false, dir: b.dir, burning: state.tick < b.burnUntil });
    for (const g of state.grenades) live.set(g.id, { pos: g.pos, stuck: g.stuck !== null });
    for (const [id, v] of this.projs) {
      const l = live.get(id);
      if (l) {
        const pos = lerpPos(id, l.pos);
        v.sprite.position.set(pos[0], pos[1], pos[2]);
        // keep glows from swamping the screen right at the muzzle
        const dCam = this.cameraPos.distanceTo(v.sprite.position);
        v.sprite.scale.setScalar(Math.min(v.baseSize, Math.max(0.05, dCam * 0.08)));
        v.core.scale.setScalar(Math.min(1, dCam * 0.25)); // the hot core too, right at the muzzle
        v.core.position.copy(v.sprite.position);
        v.marker.position.copy(v.sprite.position);
        if (l.stuck) v.sprite.material.opacity = 0.5 + 0.5 * Math.sin(performance.now() * 0.04);
        else v.sprite.material.opacity = pulse;
        if (l.dir) {
          // rocket: body along its nose, exhaust glow behind it while the motor burns
          const nose = new THREE.Vector3(...l.dir);
          v.core.quaternion.setFromUnitVectors(Y, nose);
          v.core.scale.setScalar(1);
          v.sprite.position.addScaledVector(nose, -0.5);
          v.sprite.material.opacity = l.burning ? 0.7 + 0.3 * Math.random() : 0.15;
        }
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
        mesh.castShadow = true;
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

    // hover-bikes
    for (const veh of state.vehicles) {
      let vw = this.vehicles.get(veh.id);
      if (!vw) {
        const group = new THREE.Group();
        const glow = this.makeGlow(0x6ad8ff, 2.2);
        glow.position.set(0, -0.55, 0);
        glow.material.opacity = 0.5;
        group.add(makeBike(), glow);
        this.root.add(group);
        vw = { group, glow };
        this.vehicles.set(veh.id, vw);
      }
      vw.group.visible = veh.alive;
      if (!veh.alive) continue;
      const pos = lerpPos(veh.id, veh.pos);
      const b = localBasis(pos);
      m.makeBasis(new THREE.Vector3(...b.spin), new THREE.Vector3(...b.up), new THREE.Vector3(...b.axial));
      q.setFromRotationMatrix(m);
      qy.setFromAxisAngle(Y, -veh.yaw);
      vw.group.quaternion.copy(q).multiply(qy);
      vw.group.position.set(pos[0], pos[1], pos[2]);
      vw.glow.material.opacity = veh.driver >= 0 ? 0.65 + 0.2 * Math.sin(performance.now() * 0.03) : 0.35;
    }

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
      (b.line.material as THREE.MeshBasicMaterial).opacity = Math.max(0, b.t);
      if (b.t <= 0) { b.line.removeFromParent(); b.line.geometry.dispose(); }
    }
    this.beams = this.beams.filter((b) => b.t > 0);
    for (const sp of this.splashes) {
      sp.t -= dtReal * 4;
      const dCam = this.cameraPos.distanceTo(sp.s.position);
      sp.s.scale.setScalar(Math.min(sp.size * (1.2 - sp.t), dCam * 0.15)); // never swamp the screen
      sp.s.material.opacity = Math.max(0, sp.t);
      if (sp.t <= 0) sp.s.removeFromParent();
    }
    this.splashes = this.splashes.filter((sp) => sp.t > 0);
    // mallet swings: progress, and the arc sweeping across then fading
    for (const [id, t] of this.swingT) {
      const nt = t + dtReal / 0.3;
      if (nt >= 1) this.swingT.delete(id); else this.swingT.set(id, nt);
    }
    for (const a of this.arcs) {
      a.t += dtReal / 0.35;
      const sweep = Math.min(1, a.t * 3);
      const len = 2 * a.half * sweep;
      a.mesh.geometry.dispose();
      a.mesh.geometry = new THREE.RingGeometry(a.inner, a.reach, 24, 1, -a.half, Math.max(0.001, len));
      (a.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * Math.max(0, 1 - a.t);
      if (a.t >= 1) { a.mesh.removeFromParent(); a.mesh.geometry.dispose(); }
    }
    this.arcs = this.arcs.filter((a) => a.t < 1);
    // first-person gun: jab on melee, dip while reloading, sweep on a mallet swing
    this.jab = Math.max(0, this.jab - dtReal * 5);
    let swingYaw = 0, swingRoll = 0;
    if (this.fpSwing >= 0) {
      const sw = this.fpSwing;
      const k = sw < 0.25 ? -sw / 0.25 : -1 + 2 * Math.sin(((sw - 0.25) / 0.75) * Math.PI / 2);
      swingYaw = 0.9 * k; // wind up to the right, sweep to the left
      swingRoll = -0.3 * Math.max(0, k);
      this.fpSwing += dtReal / 0.3;
      if (this.fpSwing >= 1) this.fpSwing = -1;
    }
    const jab = this.fpSwing >= 0 ? 0 : this.jab;
    this.viewModel.position.set(0.2 - 0.15 * Math.sin(swingYaw), -0.17 - 0.18 * this.reloadDip, -0.42 - 0.25 * Math.sin(jab * Math.PI));
    this.viewModel.rotation.set(-0.6 * this.reloadDip + swingRoll, Math.PI / 2 + swingYaw, 0);
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
