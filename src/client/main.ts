import GUI from 'lil-gui';
import * as sim from '../sim';
import * as THREE from 'three';
import {
  DT, EYE_OFFSET, WEAPON_HOVER, WEAPON_IDS, WEAPON_LASER, WEAPON_NAMES, addPlayer, botInput, createState, localBasis, omegaOf,
  predictTrajectory, removePlayer, step, viewVectors,
  type BoltKind, type InputCmd, type ThrownKind, type SimConfig, type SimEvent, type SimState, type Vec3,
} from '../sim';
import { Sfx } from './audio';
import { BOLT_COLORS, EntityViews, type PosMap } from './entities';
import { Hud } from './hud';
import { InputSampler } from './input';
import { LAYER_INERTIAL_ONLY, LAYER_ROT_TRAILS, LAYER_SELF, RingScene } from './scene';
import './style.css';

// ---------------------------------------------------------------- setup
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const rs = new RingScene();
const views = new EntityViews(rs);
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 2e5);
camera.layers.enable(LAYER_ROT_TRAILS);
rs.scene.add(camera); // so the first-person gun (a child of the camera) renders
camera.add(views.viewModel);
const pipCam = new THREE.PerspectiveCamera(38, 4 / 3, 1, 2e5);
pipCam.layers.enable(LAYER_INERTIAL_ONLY);
pipCam.layers.enable(LAYER_SELF);
const input = new InputSampler(canvas);
const hud = new Hud();
const sfx = new Sfx();

// Live config object: GUI binds to it, and every world uses it as its config.
const cfg: SimConfig = createState({ obstacles: false, props: false, dummies: false }).config;
let state!: SimState;
let localId = -1;
let botIds: number[] = [];
let prev: PosMap = new Map();
let prevFrameAngle = 0;

const view = {
  timeScale: 1,
  paused: true, // until the player clicks "spawn"; Esc pauses again
  trailSeconds: 1.5,
  preview: true,
  inertial: false,
  freefly: false,
  bots: 3,
  seed: 1234,
};

function newWorld() {
  state = createState({ seed: view.seed, config: cfg });
  state.config = cfg;
  localId = addPlayer(state, 'human', 'You');
  botIds = [];
  for (let i = 0; i < view.bots; i++) botIds.push(addPlayer(state, 'bot', `Bot ${String.fromCharCode(65 + i)}`));
  rs.build(cfg, state.level);
  views.reset();
  views.localId = localId;
  input.yaw = 0;
  input.pitch = 0;
  prev = capture(state);
  prevFrameAngle = state.frameAngle;
}

function setBotCount(n: number) {
  while (botIds.length < n) botIds.push(addPlayer(state, 'bot', `Bot ${String.fromCharCode(65 + botIds.length)}`));
  while (botIds.length > n) removePlayer(state, botIds.pop()!);
}

function capture(s: SimState): PosMap {
  const m: PosMap = new Map();
  for (const p of s.players) m.set(p.id, [...p.pos] as Vec3);
  for (const b of s.bolts) m.set(b.id, [...b.pos] as Vec3);
  for (const g of s.grenades) m.set(g.id, [...g.pos] as Vec3);
  for (const p of s.props) m.set(p.id, [...p.pos] as Vec3);
  return m;
}

// ---------------------------------------------------------------- debug GUI
// Only visible while paused: the prototype has no debug controls in normal play.
const gui = new GUI({ title: 'Debug settings' });
gui.hide();
const fRing = gui.addFolder('Ring');
fRing.add(cfg, 'R', 10, 5000, 5).name('R (m) — rebuilds').onFinishChange(() => newWorld());
fRing.add(cfg, 'g', 1, 30, 0.01).name('g at floor (m/s²)');
fRing.add(cfg, 'centrifugal').name('centrifugal force');
fRing.add(cfg, 'coriolis').name('Coriolis force');
fRing.add(cfg, 'dragType', ['none', 'linear', 'quadratic']).name('air drag');
fRing.add(cfg, 'dragCoeff', 0, 1, 0.001).name('drag coeff');
fRing.add(cfg, 'fallKillDistance', 2, 500, 1).name('fall-off kill distance (m)');

const fP = gui.addFolder('Player');
fP.add(cfg, 'walkSpeed', 1, 60, 0.5).name('run speed (m/s)');
fP.add(cfg, 'sprintSpeed', 1, 80, 0.5).name('sprint speed (m/s)');
fP.add(cfg, 'jumpSpeed', 0, 40, 0.5).name('jump speed (m/s)');
fP.add(cfg, 'groundAccel', 10, 500, 5).name('ground accel (m/s²)');
fP.add(cfg, 'airAccel', 0, 60, 0.5).name('air control (m/s²)');
fP.add(cfg, 'coyoteTime', 0, 0.5, 0.01).name('jump grace after leaving ground (s)');
fP.add(cfg, 'impactDamageSpeed', 5, 100, 1).name('impact damage above (m/s)');
fP.add(cfg, 'impactDamagePerMs', 0, 30, 0.5).name('impact damage per m/s');
fP.add(cfg, 'jetThrust', 0, 60, 0.5).name('jetpack thrust (m/s²)');
fP.add(cfg, 'jetLateral', 0, 30, 0.5).name('jetpack steering (m/s²)');
fP.add(cfg, 'jetBurn', 0.02, 2, 0.01).name('jetpack burn (tank/s)');

// One folder per weapon, showing only the stats that weapon uses.
const fW = gui.addFolder('Weapons');
type StatKey = keyof SimConfig['weapons']['rifle'];
const STAT_UI: Partial<Record<StatKey, [string, number, number, number]>> = {
  muzzle: ['muzzle speed (m/s)', 1, 5000, 1], damage: ['damage', 0, 300, 1], shieldDamage: ['shield damage', 0, 300, 1],
  interval: ['time between shots (s)', 0.02, 3, 0.01], heatPerShot: ['heat per shot', 0, 1, 0.005],
  coolRate: ['cooling (heat/s)', 0, 3, 0.01], overheatLock: ['overheat lockout (s)', 0, 10, 0.1], radius: ['bolt radius (m)', 0.02, 1, 0.01],
  ammoMax: ['ammo capacity', 1, 100, 1], chargeTime: ['charge time (s)', 0.05, 5, 0.05],
  ocMuzzle: ['overcharge muzzle (m/s)', 1, 200, 1], ocDamage: ['overcharge damage', 0, 300, 1],
  ocShieldDamage: ['overcharge shield damage', 0, 500, 1], ocHeat: ['overcharge heat', 0, 1, 0.01],
  blastRadius: ['blast radius (m)', 0.5, 20, 0.5], blastDamage: ['blast damage', 0, 300, 1], blastKnockback: ['blast knockback (m/s)', 0, 80, 0.5],
  chargeMoveScale: ['move speed while charging', 0, 1, 0.05], chargeLookScale: ['look speed while charging', 0.02, 1, 0.02],
  lifetime: ['bolt lifetime (s)', 0.1, 120, 0.1],
};
const WEAPON_UI: Record<string, StatKey[]> = {
  rifle: ['muzzle', 'damage', 'interval', 'heatPerShot', 'coolRate', 'overheatLock'],
  redRifle: ['muzzle', 'damage', 'interval', 'heatPerShot', 'coolRate', 'overheatLock'],
  pistol: ['muzzle', 'damage', 'interval', 'heatPerShot', 'coolRate', 'chargeTime', 'ocMuzzle', 'ocDamage', 'ocShieldDamage', 'ocHeat'],
  launcher: ['muzzle', 'damage', 'interval', 'ammoMax', 'blastRadius', 'blastDamage', 'blastKnockback'],
  laser: ['muzzle', 'damage', 'chargeTime', 'interval', 'heatPerShot', 'coolRate', 'chargeMoveScale', 'chargeLookScale', 'lifetime'],
  hover: ['damage', 'interval'],
};
WEAPON_IDS.forEach((id, i) => {
  const f = fW.addFolder(WEAPON_NAMES[i]);
  for (const k of WEAPON_UI[id]) {
    const [label, lo, hi, stepv] = STAT_UI[k]!;
    f.add(cfg.weapons[id], k, lo, hi, stepv).name(label);
  }
  f.close();
});

const fG = gui.addFolder('Grenades & items');
fG.add(cfg, 'muzzleGrenade', 2, 60, 0.5).name('throw speed (m/s)');
fG.add(cfg, 'grenadeFuse', 0.2, 5, 0.1).name('sticky fuse (s)');
fG.add(cfg, 'bounceFuse', 0.2, 8, 0.1).name('bouncer fuse (s)');
fG.add(cfg, 'bounceRestitution', 0, 1, 0.05).name('bouncer bounciness');
fG.add(cfg, 'pickupRespawn', 1, 120, 1).name('pickup respawn (s)');
fG.add(cfg, 'dropLifetime', 1, 120, 1).name('dropped item lifetime (s)');

const fK = gui.addFolder('Explosions (grenades)');
fK.add(cfg, 'knockbackScale', 0, 5, 0.05).name('knockback scale (all blasts)');
fK.add(cfg, 'knockbackSpeed', 0, 60, 0.5).name('point-blank Δv (m/s)');
fK.add(cfg, 'knockbackFalloff', ['none', 'linear', 'quadratic']).name('falloff');
fK.add(cfg, 'liftBias', 0, 2, 0.05).name('toward-axis lift');
fK.add(cfg, 'explosionRadius', 1, 20, 0.5).name('radius (m)');
fK.add(cfg, 'explosionDamage', 0, 300, 1).name('damage');
fK.add(cfg, 'selfDamageScale', 0, 1, 0.05).name('self damage');
const fV = gui.addFolder('View / debug');
fV.add(view, 'timeScale', 0.02, 2, 0.01).name('time scale (local)').listen();
fV.add(view, 'trailSeconds', 0.1, 10, 0.1).name('trail length (s)').onChange((v: number) => (views.trailTicks = Math.round(v / DT)));
fV.add(view, 'preview').name('trajectory preview');
fV.add(view, 'inertial').name('inertial-frame overlay').listen();
fV.add(view, 'freefly').name('free-fly camera').listen().onChange(() => setFreefly(view.freefly));
fV.add(view, 'bots', 0, 8, 1).name('bots').onFinishChange((n: number) => setBotCount(n));
fV.add({ hover: () => { cfg.allowHoverGun = true; input.weapon = WEAPON_HOVER; } }, 'hover').name('equip hover gun (debug weapon)');
fV.add({ reset: () => newWorld() }, 'reset').name('reset world');
for (const f of [fRing, fW, fP, fG, fK]) f.close();

// ---------------------------------------------------------------- free-fly
const ff = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
function setFreefly(on: boolean) {
  view.freefly = on;
  input.enabled = !on;
  if (on) {
    ff.pos.copy(camera.position);
    ff.quat.copy(camera.quaternion);
    camera.layers.enable(LAYER_SELF);
    input.freeLook = (dx, dy) => {
      const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * 0.002);
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * 0.002);
      ff.quat.multiply(qy).multiply(qx);
    };
  } else {
    camera.layers.disable(LAYER_SELF);
    input.freeLook = null;
  }
}


// ---------------------------------------------------------------- events -> audio/hud/fx
function listenerPos(): Vec3 {
  return [camera.position.x, camera.position.y, camera.position.z];
}
// Where each player's last laser shot left the muzzle (for the beam effect).
const laserFrom = new Map<number, Vec3>();
function handleEvent(e: SimEvent) {
  const lp = listenerPos();
  const d = (p: Vec3) => Math.hypot(p[0] - lp[0], p[1] - lp[1], p[2] - lp[2]);
  switch (e.type) {
    case 'fire':
      sfx.shot(e.kind, d(e.pos));
      if (e.kind === 'laser') laserFrom.set(e.owner, e.pos);
      break;
    case 'impact':
      sfx.impact(d(e.pos));
      if (e.kind === 'laser') {
        const from = laserFrom.get(e.owner);
        if (from) views.addBeam(from, e.pos);
      }
      break;
    case 'stick': sfx.stick(d(e.pos)); break;
    case 'explode': sfx.explode(d(e.pos)); views.explosionFlash(e.pos); break;
    case 'hit':
      views.flashHit(e.target);
      if (e.attacker === localId && e.target !== localId) sfx.hit();
      if (e.target === localId) e.shieldBroken ? sfx.shieldDown() : sfx.hurt();
      break;
    case 'overheat': if (e.id === localId) sfx.overheat(); break;
    case 'jump': if (e.id === localId) sfx.jump(); break;
    case 'bodyImpact': sfx.thud(d(e.pos)); break;
    case 'grenadeBounce': sfx.bounce(d(e.pos), e.speed); break;
    case 'pickup': if (e.player === localId) sfx.pickup(); break;
  }
  hud.onEvent(state, e, localId);
}

// ---------------------------------------------------------------- main loop
let acc = 0;
let last = performance.now();
const MAX_STEPS = 12;

function simTick() {
  prev = capture(state);
  prevFrameAngle = state.frameAngle;
  const inputs: InputCmd[] = [input.sample(localId, state.tick)];
  for (const b of botIds) inputs.push(botInput(state, b));
  step(state, inputs, state.tick);
  for (const e of state.events) handleEvent(e);
  views.onTick(state);
}

function previewKind(): BoltKind | ThrownKind | null {
  const me = state.players.find((p) => p.id === localId);
  if (!me || !me.alive || !view.preview) return null;
  if (input.grenadeHeld && me.grenades > 0) return 'grenade';
  if (input.bounceHeld && me.bounceGrenades > 0) return 'bounceGrenade';
  if (!input.aiming) return null;
  const id = WEAPON_IDS[me.weapon];
  if (id === 'pistol') return me.charge >= 1 ? 'overcharge' : 'pistol';
  if (id === 'launcher') return 'fuelRod';
  return id;
}

function frame(now: number) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!view.paused) acc += dtReal * view.timeScale;
  let steps = 0;
  while (acc >= DT && steps < MAX_STEPS) {
    simTick();
    acc -= DT;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0; // can't keep up: drop time rather than spiral
  const alpha = acc / DT;

  const fa = prevFrameAngle + (state.frameAngle - prevFrameAngle) * alpha;
  rs.setFrameAngle(fa);
  const me = state.players.find((p) => p.id === localId);
  // camera
  if (view.freefly) {
    const speed = (input.keys.has('ShiftLeft') ? 60 : 15) * dtReal;
    const mv = new THREE.Vector3(
      (input.keys.has('KeyD') ? 1 : 0) - (input.keys.has('KeyA') ? 1 : 0),
      (input.keys.has('Space') ? 1 : 0) - (input.keys.has('KeyC') ? 1 : 0),
      (input.keys.has('KeyS') ? 1 : 0) - (input.keys.has('KeyW') ? 1 : 0),
    ).applyQuaternion(ff.quat).multiplyScalar(speed);
    ff.pos.add(mv);
    camera.position.copy(ff.pos);
    camera.quaternion.copy(ff.quat);
  } else if (me) {
    const p0 = prev.get(me.id) ?? me.pos;
    const pos: Vec3 = [p0[0] + (me.pos[0] - p0[0]) * alpha, p0[1] + (me.pos[1] - p0[1]) * alpha, p0[2] + (me.pos[2] - p0[2]) * alpha];
    const v = viewVectors(pos, input.yaw, input.pitch);
    const eye = new THREE.Vector3(pos[0] + v.up[0] * EYE_OFFSET, pos[1] + v.up[1] * EYE_OFFSET, pos[2] + v.up[2] * EYE_OFFSET);
    camera.position.copy(eye);
    camera.up.set(...v.up);
    camera.lookAt(eye.x + v.aim[0], eye.y + v.aim[1], eye.z + v.aim[2]);
  }

  views.cameraPos.copy(camera.position);
  views.render(state, prev, alpha, dtReal);
  // trajectory preview (real physics, includes the shooter's own velocity)
  const pk = previewKind();
  const maxT = pk === 'laser' ? cfg.weapons.laser.lifetime : 22;
  views.setPreview(pk ? predictTrajectory(state, localId, pk, input.yaw, input.pitch, maxT) : null, BOLT_COLORS[pk ?? 'rifle']);
  // first-person gun, mouse slowdown while charging the laser, owned list for the wheel
  views.setViewWeapon(me?.weapon ?? 0, !!me && me.alive && !view.freefly);
  input.lookScale = me && me.weapon === WEAPON_LASER && me.charge > 0 ? cfg.weapons.laser.chargeLookScale : 1;
  if (me) input.owned = me.owned;

  // main view
  const W = window.innerWidth, H = window.innerHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.render(rs.scene, camera);

  // inertial picture-in-picture: a camera fixed in the NON-rotating frame
  document.getElementById('pip-label')!.classList.toggle('hidden', !view.inertial);
  if (view.inertial) {
    const R = cfg.R;
    const pw = Math.round(Math.min(W * 0.42, H * 0.5)), ph = Math.round(pw * 0.72);
    const x = W - pw - 16, y = 96;
    const P = new THREE.Vector3(0, -R * 2.1, R * 1.5).applyAxisAngle(new THREE.Vector3(0, 0, 1), -fa);
    pipCam.position.copy(P);
    pipCam.up.set(0, 0, 1);
    pipCam.lookAt(0, 0, 0);
    pipCam.aspect = pw / ph;
    pipCam.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, pw, ph);
    renderer.setViewport(x, y, pw, ph);
    const fog = rs.scene.fog;
    rs.scene.fog = null;
    renderer.render(rs.scene, pipCam);
    rs.scene.fog = fog;
    renderer.setScissorTest(false);
    document.getElementById('pip-label')!.style.bottom = `${y + ph + 6}px`;
  }

  hud.update(state, me, { yaw: input.yaw, timeScale: view.timeScale, paused: view.paused, freefly: view.freefly, sprintOn: input.sprintOn });
  requestAnimationFrame(frame);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- boot
newWorld();
resize();
// ---------------------------------------------------------------- intro / pause
// Playing == pointer locked. Losing the lock (Esc) pauses and reveals the
// debug panel; clicking the pause screen re-locks and resumes.
const loading = document.getElementById('loading')!;
// one copy of the controls in the HTML: mirror it onto the pause screen
document.querySelector('#pause .controls')!.innerHTML = document.querySelector('#loading .controls')!.innerHTML;
const pauseEl = document.getElementById('pause')!;
let started = false;

function setPaused(p: boolean) {
  view.paused = p;
  pauseEl.classList.toggle('hidden', !p || !started);
  if (p && started) gui.show();
  else gui.hide();
  input.keys.clear();
  input.mouseButtons = 0;
}

function requestPlay() {
  sfx.unlock();
  const r = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
  // Some browsers refuse a re-lock right after Esc; stay paused and let them click again.
  if (r && typeof r.catch === 'function') r.catch(() => {});
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked && !started) {
    started = true;
    loading.classList.add('hidden');
    document.getElementById('hud')!.classList.remove('hidden');
  }
  setPaused(!locked);
});
loading.addEventListener('click', requestPlay);
pauseEl.addEventListener('click', requestPlay);
requestAnimationFrame((t) => {
  last = t;
  frame(t);
});

// Debug handle (console / automated checks).
(window as unknown as { __game: unknown }).__game = {
  get state() { return state; }, get localId() { return localId; }, sim, input, view, cfg, gui, views, newWorld, setFreefly, setPaused, localBasis, omegaOf,
};
