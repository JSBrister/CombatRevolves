import GUI from 'lil-gui';
import * as sim from '../sim';
import * as THREE from 'three';
import {
  DT, LEVELS, WEAPON_HOVER, WEAPON_IDS, WEAPON_NAMES, isLaconicBusy, addPlayer, applyItem, botInput, createState, damagePlayer,
  eyeOffset, levelById, localBasis, omegaOf, startLevel,
  predictTrajectory, removePlayer, step, viewVectors, addVehicle, addScaled, convertDir, transportYaw, dist,
  type BoltKind, type GameMode, type InputCmd, type ItemKind, type LevelDef, type ThrownKind, type SimConfig, type SimEvent, type SimState, type Vec3,
} from '../sim';
import { Sfx } from './audio';
import { CUSTOM_DEFAULTS, buildCustomForm, customLevel, decodeCustom, encodeCustom, randomCustom, type CustomSettings } from './custom';
import { BOLT_COLORS, EntityViews, type PosMap } from './entities';
import { Hud } from './hud';
import { basesFor, buildMatchPanel, buildPlayerPanel, match, player, setupFor } from './setup';
import { NetClient } from '../net/client';
import { InputSampler } from './input';
import { LAYER_INERTIAL_ONLY, LAYER_ROT_TRAILS, LAYER_SELF, RingScene } from './scene';
import './style.css';

// ---------------------------------------------------------------- setup
const canvas = document.getElementById('view') as HTMLCanvasElement;
// Graphics quality: 'low' (no sun shadows, one pixel per CSS pixel, no antialiasing)
// for weaker machines. Chosen automatically the first time, then remembered;
// the title screen has a button to switch (it reloads the page).
const lowSpec = ((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) <= 4 || (navigator.hardwareConcurrency ?? 8) <= 4;
let gfx: 'high' | 'low' = lowSpec ? 'low' : 'high';
try { const g = localStorage.getItem('cr-graphics'); if (g === 'high' || g === 'low') gfx = g; } catch { /* storage blocked: use the guess */ }
const renderer = new THREE.WebGLRenderer({ canvas, antialias: gfx === 'high', logarithmicDepthBuffer: true, powerPreference: gfx === 'high' ? 'high-performance' : 'default' });
renderer.setPixelRatio(gfx === 'high' ? Math.min(window.devicePixelRatio, 2) : 1);
renderer.shadowMap.enabled = gfx === 'high';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// If the GPU drops us (driver reset, out of memory), say so, and rebuild when it comes back.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const el = document.getElementById('gfx-lost');
  if (el) el.classList.remove('hidden');
});
canvas.addEventListener('webglcontextrestored', () => {
  const el = document.getElementById('gfx-lost');
  if (el) el.classList.add('hidden');
  startGame(currentLevel);
});
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
/** A network game: the socket and the client's side of the match. Null when playing locally. */
let net: { ws: WebSocket; client: NetClient } | null = null;
const NO_PREV: PosMap = new Map();

const view = {
  timeScale: 1,
  paused: true, // until the player clicks "spawn"; Esc pauses again
  trailSeconds: 1.5,
  preview: true,
  inertial: false,
  freefly: false,
  bots: 3,
};

let currentLevel: LevelDef = levelById('s-standard')!;
/** Set when the debug panel's R slider is moved; cleared when a level is picked from the menu. */
let rOverride: number | null = null;

/** Build `def` using the live (debug-tweakable) config as the base, then the level's own settings. */
function startGame(def: LevelDef) {
  currentLevel = def;
  const ldef = rOverride !== null ? { ...def, config: { ...def.config, R: rOverride } } : def;
  const started = startLevel(ldef, { ...cfg }, setupFor(def));
  state = started.state;
  Object.assign(cfg, state.config); // the GUI stays bound to the same object
  state.config = cfg;
  localId = started.localId;
  botIds = started.botIds;
  view.bots = state.mode === 'sandbox' ? botIds.length : 0;
  outcomeAt = 0;
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  rs.build(cfg, state.level, currentLevel.sky ?? 'space');
  views.reset();
  views.localId = localId;
  input.yaw = state.players.find((p) => p.id === localId)!.yaw;
  input.pitch = 0;
  input.weapon = 0;
  prev = capture(state);
  prevFrameAngle = state.frameAngle;
}

function newWorld() {
  startGame(currentLevel);
}

function setBotCount(n: number) {
  if (net || state.mode !== 'sandbox' || state.config.teams >= 2) return; // (team games: set the bots in the match setup)
  while (botIds.length < n) botIds.push(addPlayer(state, 'bot', `Bot ${String.fromCharCode(65 + botIds.length)}`));
  while (botIds.length > n) removePlayer(state, botIds.pop()!);
}

function capture(s: SimState): PosMap {
  const m: PosMap = new Map();
  for (const p of s.players) m.set(p.id, [...p.pos] as Vec3);
  for (const b of s.bolts) m.set(b.id, [...b.pos] as Vec3);
  for (const g of s.grenades) m.set(g.id, [...g.pos] as Vec3);
  for (const p of s.props) m.set(p.id, [...p.pos] as Vec3);
  for (const v of s.vehicles) m.set(v.id, [...v.pos] as Vec3);
  return m;
}

// ---------------------------------------------------------------- debug GUI
// Only visible while paused: the prototype has no debug controls in normal play.
const gui = new GUI({ title: 'Debug settings' });
gui.hide();
const fRing = gui.addFolder('Ring');
fRing.add(cfg, 'R', 10, 5000, 5).name('R (m) — restarts level').onFinishChange((v: number) => { rOverride = v; newWorld(); });
fRing.add(cfg, 'g', 1, 30, 0.01).name('g at floor (m/s²)');
fRing.add(cfg, 'centrifugal').name('centrifugal force');
fRing.add(cfg, 'coriolis').name('Coriolis force');
fRing.add(cfg, 'dragType', ['none', 'linear', 'quadratic']).name('air drag');
fRing.add(cfg, 'dragCoeff', 0, 1, 0.001).name('drag coeff');
fRing.add(cfg, 'fallKillDistance', 2, 500, 1).name('fall-off kill distance (m)');
fRing.add(cfg, 'spinChange', 0, 2, 0.05).name('spin change (1 = stops, 2 = reverses)').listen();
fRing.add(cfg, 'spinPeriod', 5, 600, 1).name('spin change cycle (s)').listen();
fRing.add(cfg, 'planetPull', 0, 30, 0.05).name('planet pull (m/s²)').listen();
fRing.add(cfg, 'gravity', 0, 30, 0.05).name('real gravity to the floor (m/s²)').listen();

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
fP.add(cfg, 'meleeDamage', 0, 300, 1).name('melee damage');
fP.add(cfg, 'meleeKnockback', 0, 80, 0.5).name('melee knockback (m/s)');
fP.add(cfg, 'meleeRange', 0.5, 6, 0.1).name('melee range (m)');
fP.add(cfg, 'meleeCooldown', 0.1, 3, 0.05).name('melee cooldown (s)');

// One folder per weapon, showing only the stats that weapon uses.
const fW = gui.addFolder('Weapons');
type StatKey = keyof SimConfig['weapons']['rifle'];
const STAT_UI: Partial<Record<StatKey, [string, number, number, number]>> = {
  muzzle: ['muzzle speed (m/s)', 1, 5000, 1], damage: ['damage', 0, 300, 1], shieldDamage: ['shield damage', 0, 300, 1],
  interval: ['time between shots (s)', 0.02, 3, 0.01], heatPerShot: ['heat per shot', 0, 1, 0.005],
  coolRate: ['cooling (heat/s)', 0, 3, 0.01], overheatLock: ['overheat lockout (s)', 0, 10, 0.1], radius: ['bolt radius (m)', 0.02, 1, 0.01],
  ammoMax: ['spare rounds carried', 0, 100, 1], magSize: ['magazine size', 1, 50, 1], reloadTime: ['reload time (s)', 0.1, 10, 0.1],
  knockback: ['knockback per hit (m/s)', 0, 40, 0.1], burstTime: ['stream length (s)', 0.05, 3, 0.05],
  chargeTime: ['charge time (s)', 0.05, 5, 0.05],
  ocMuzzle: ['overcharge muzzle (m/s)', 1, 200, 1], ocDamage: ['overcharge damage', 0, 300, 1],
  ocShieldDamage: ['overcharge shield damage', 0, 500, 1], ocHeat: ['overcharge heat', 0, 1, 0.01],
  blastRadius: ['blast radius (m)', 0.5, 20, 0.5], blastDamage: ['blast damage', 0, 300, 1], blastKnockback: ['blast knockback (m/s)', 0, 80, 0.5],
  chargeMoveScale: ['move speed while charging/firing', 0, 1, 0.05], chargeLookScale: ['look speed while charging/firing', 0.02, 1, 0.02],
  lifetime: ['bolt lifetime (s)', 0.1, 120, 0.1],
  thrust: ['rocket thrust (m/s²)', 0, 400, 1], burnTime: ['motor burn (s)', 0, 10, 0.1],
  pellets: ['pellets per shot', 1, 40, 1], spread: ['spread (° from your aim)', 0, 45, 0.1], muzzleMin: ['slowest shot (m/s)', 0, 500, 1],
  turnRate: ['homing turn rate (rad/s)', 0, 20, 0.1], seekRange: ['seeker range (m)', 0, 300, 1], seekAngle: ['seeker cone (° either side)', 0, 180, 1],
};
const WEAPON_UI: Record<string, StatKey[]> = {
  rifle: ['muzzle', 'damage', 'knockback', 'interval', 'heatPerShot', 'coolRate', 'overheatLock'],
  redRifle: ['muzzle', 'damage', 'knockback', 'interval', 'heatPerShot', 'coolRate', 'overheatLock'],
  pistol: ['muzzle', 'damage', 'knockback', 'interval', 'heatPerShot', 'coolRate', 'chargeTime', 'ocMuzzle', 'ocDamage', 'ocShieldDamage', 'ocHeat', 'turnRate', 'seekAngle'],
  launcher: ['muzzle', 'damage', 'knockback', 'interval', 'magSize', 'ammoMax', 'reloadTime', 'blastRadius', 'blastDamage', 'blastKnockback'],
  cannon: ['muzzle', 'damage', 'knockback', 'radius', 'overheatLock'],
  laconic: ['muzzle', 'damage', 'knockback', 'chargeTime', 'burstTime', 'interval', 'overheatLock', 'chargeMoveScale', 'chargeLookScale'],
  hammer: ['damage', 'knockback', 'blastRadius', 'interval'],
  rocket: ['muzzle', 'thrust', 'burnTime', 'damage', 'knockback', 'interval', 'magSize', 'ammoMax', 'reloadTime', 'blastRadius', 'blastDamage', 'blastKnockback'],
  revolver: ['muzzle', 'damage', 'knockback', 'interval', 'magSize', 'ammoMax', 'reloadTime', 'radius'],
  scatter: ['muzzle', 'pellets', 'spread', 'damage', 'knockback', 'interval', 'magSize', 'ammoMax', 'reloadTime', 'lifetime'],
  chaos: ['muzzleMin', 'muzzle', 'spread', 'damage', 'interval', 'heatPerShot', 'coolRate', 'overheatLock'],
  seeker: ['muzzle', 'thrust', 'burnTime', 'turnRate', 'seekRange', 'seekAngle', 'damage', 'interval', 'magSize', 'ammoMax', 'reloadTime', 'blastRadius', 'blastDamage'],
  hover: ['damage', 'interval'],
  flag: ['damage', 'knockback', 'blastRadius', 'interval'],
};
WEAPON_IDS.forEach((id, i) => {
  const f = fW.addFolder(WEAPON_NAMES[i]);
  for (const k of WEAPON_UI[id]) {
    const [label, lo, hi, stepv] = STAT_UI[k]!;
    f.add(cfg.weapons[id], k, lo, hi, stepv).name((id === 'hammer' || id === 'flag') && k === 'blastRadius' ? 'reach (m)' : label);
  }
  f.close();
});

const fG = gui.addFolder('Grenades & items');
fG.add(cfg, 'muzzleGrenade', 2, 60, 0.5).name('throw speed (m/s)');
fG.add(cfg, 'grenadeFuse', 0.2, 5, 0.1).name('sticky fuse (s)');
fG.add(cfg, 'bounceFuse', 0.2, 8, 0.1).name('bouncer fuse (s)');
fG.add(cfg, 'bounceRestitution', 0, 1, 0.05).name('bouncer bounciness');
fG.add(cfg, 'pickupRespawn', 1, 120, 1).name('pickup respawn (s)');
fG.add(cfg, 'comboHits', 1, 30, 1).name('seeker supercombine: hits');
fG.add(cfg, 'comboWindow', 0.05, 5, 0.05).name('...each within (s)');
fG.add(cfg, 'comboDamage', 0, 500, 1).name('...blast damage');
fG.add(cfg, 'dropLifetime', 1, 120, 1).name('dropped item lifetime (s)');

const fB = gui.addFolder('Hover-bikes');
fB.add(cfg, 'bikeThrust', 0, 80, 0.5).name('thrust (m/s²)');
fB.add(cfg, 'bikeStrafe', 0, 40, 0.5).name('strafe (m/s²)');
fB.add(cfg, 'bikeMaxSpeed', 5, 150, 1).name('throttle top speed (m/s)');
fB.add(cfg, 'bikeDamping', 0, 1, 0.01).name('damping (/s)');
fB.add(cfg, 'bikeHop', 0, 30, 0.5).name('hop (m/s)');
fB.add(cfg, 'bikeBounce', 0, 1, 0.05).name('bounciness');
fB.add(cfg, 'bikeHealth', 10, 3000, 10).name('health (new bikes)');
fB.add(cfg, 'bikeCrashSpeed', 0, 150, 1).name('wall crash damage above (m/s)');
fB.add(cfg, 'bikeGrip', 0, 15, 0.1).name('sideways grip (/s)');
fB.add(cfg, 'bikeHoverHeight', 0.85, 3, 0.05).name('ride height (m)');
fB.add(cfg, 'bikeHoverStiffness', 5, 300, 1).name('hover spring');
fB.add(cfg, 'bikeHoverDamping', 0, 40, 0.5).name('hover damping');
fB.add(cfg, 'bikeRamThrow', 0, 3, 0.05).name('run-over throw');
fB.add(cfg, 'bikeCrashDamage', 0, 50, 0.5).name('crash damage per m/s');
fB.add(cfg, 'bikeRamSpeed', 0, 40, 0.5).name('run-over damage above (m/s)');
fB.add(cfg, 'bikeRamDamage', 0, 50, 0.5).name('run-over damage per m/s');
fB.close();

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
fV.add({ reset: () => newWorld() }, 'reset').name('restart level');

// Give yourself things (debug only: in multiplayer this would be a server command).
const fGive = gui.addFolder('Give');
const me_ = () => state.players.find((p) => p.id === localId);
const give = (item: ItemKind) => () => { const p = me_(); if (p && p.alive) applyItem(cfg, p, item, -1); };
for (const item of ['redRifle', 'launcher', 'cannon', 'laconic', 'hammer', 'rocket', 'seeker', 'scatter', 'chaos', 'revolver', 'rifle', 'pistol'] as ItemKind[]) fGive.add({ f: give(item) }, 'f').name(WEAPON_NAMES[WEAPON_IDS.indexOf(item as never)]);
fGive.add({ f: () => { cfg.allowHoverGun = true; input.weapon = WEAPON_HOVER; } }, 'f').name('Hover Gun (debug)');
fGive.add({ f: give('jetpack') }, 'f').name('Jetpack (full)');
fGive.add({ f: () => {
  const p = me_();
  if (!p || !p.alive) return;
  const v = viewVectors(p.pos, input.yaw, 0);
  addVehicle(state, addScaled(addScaled(p.pos, v.forward, 3.5), v.up, -0.2), input.yaw);
} }, 'f').name('Hover-bike (in front of you)');
fGive.add({ f: () => { give('sticky')(); give('bounce')(); } }, 'f').name('Grenades (refill)');
fGive.add({ f: () => { const p = me_(); if (p) { p.health = p.maxHealth; p.shield = p.maxShield; } } }, 'f').name('Health + shields');
fGive.add({ f: () => { for (const p of state.players) if (p.id !== localId && p.alive) damagePlayer(state, p, localId, 1e6, 1e6, 'debug'); } }, 'f').name('Kill everyone else');
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
function handleEvent(e0: SimEvent) {
  // twin rings: events happen in their ring's frame; show them in ours
  let e = e0;
  if (cfg.twin && 'pos' in e0) {
    const th = state.frameAngle, f: 0 | 1 = e0.pos[2] >= 0 ? 1 : 0;
    e = { ...e0, pos: views.toView(e0.pos, th) } as SimEvent;
    if (e.type === 'melee') e = { ...e, from: views.toView(e.from, th), aim: convertDir(e.aim, f, views.viewFrame, th), up: convertDir(e.up, f, views.viewFrame, th) };
  }
  const lp = listenerPos();
  const d = (p: Vec3) => Math.hypot(p[0] - lp[0], p[1] - lp[1], p[2] - lp[2]);
  switch (e.type) {
    case 'fire':
      sfx.shot(e.kind, d(e.pos));
      if (e.kind === 'laconic') laserFrom.set(e.owner, e.pos);
      break;
    case 'impact': {
      sfx.impact(d(e.pos));
      // a splash wherever a shot lands, sized by how hard it hits
      const big = e.kind === 'cannon' || e.kind === 'overcharge' || e.kind === 'laconic';
      views.burst(e.pos, BOLT_COLORS[e.kind] ?? 0xffffff, big ? 2.2 : 1.1);
      if (e.kind === 'laconic') {
        const from = laserFrom.get(e.owner);
        if (from) views.addBeam(from, e.pos);
      }
      break;
    }
    case 'reload': if (e.id === localId) sfx.reload(); break;
    case 'melee':
      sfx.melee(d(e.pos), e.target >= 0);
      if (e.id === localId && !e.mallet) views.jab = 1;
      views.swing(e);
      if (e.target >= 0) views.burst(e.pos, 0xffffff, 1.5);
      break;
    case 'stick': sfx.stick(d(e.pos)); break;
    case 'explode': sfx.explode(d(e.pos)); views.explosionFlash(e.pos); break;
    case 'supercombine': views.burst(e.pos, 0xff6ad8, 4); sfx.explode(d(e.pos)); break;
    case 'pad': views.burst(e.pos, 0x3affc0, 2.5); sfx.shot('hover', d(e.pos)); break;
    case 'grapple': if (e.what === 'catch') { views.burst(e.pos, 0xf2e2b0, 0.8); sfx.thud(d(e.pos)); } else sfx.melee(d(e.pos), false); break;
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
    case 'mount': if (e.id === localId) sfx.pickup(); break;
    case 'vehicleHit': sfx.thud(d(e.pos)); break;
    case 'flag': {
      const col = sim.TEAM_COLORS[e.flagTeam] ?? 0xffffff;
      views.burst(e.pos, col, e.what === 'captured' ? 6 : 3);
      if (e.what === 'captured') { sfx.explode(d(e.pos)); views.explosionFlash(e.pos); } else sfx.pickup();
      break;
    }
  }
  hud.onEvent(state, e, localId);
}

// ---------------------------------------------------------------- main loop
let acc = 0;
let last = performance.now();
const MAX_STEPS = 12;

/** A tick of a network game: this tick's input goes to the server and into the prediction. */
function netTick() {
  const c = net!.client;
  const before = c.localPlayer;
  const from: Vec3 | null = before && before.alive ? [...before.pos] as Vec3 : null;
  // (in a menu the game goes on: you just stand there)
  c.tick((id, tick) => (screen === 'playing' ? input.sample(id, tick) : { playerId: id, tick, moveX: 0, moveY: 0, yaw: input.yaw, pitch: input.pitch, buttons: 0, weapon: before?.weapon ?? 0 }));
  const after = c.localPlayer;
  if (cfg.world !== 'ring' && from && after && after.alive && dist(from, after.pos) < 5) input.yaw = transportYaw(input.yaw, from, after.pos);
  const rs0 = c.renderState(1, 0);
  if (rs0) views.onTick(rs0);
}

function simTick() {
  if (net) return netTick();
  prev = capture(state);
  prevFrameAngle = state.frameAngle;
  const inputs: InputCmd[] = [input.sample(localId, state.tick)];
  for (const b of botIds) inputs.push(botInput(state, b));
  const meBefore = state.players.find((p) => p.id === localId);
  const from: Vec3 | null = meBefore && meBefore.alive ? [...meBefore.pos] as Vec3 : null;
  step(state, inputs, state.tick);
  // on a planet or disk, keep facing the same way as you move (near a pole or the axis "east" swings round)
  const meAfter = state.players.find((p) => p.id === localId);
  if (cfg.world !== 'ring' && from && meAfter && meAfter.alive && dist(from, meAfter.pos) < 5) input.yaw = transportYaw(input.yaw, from, meAfter.pos);
  for (const e of state.events) handleEvent(e);
  views.onTick(state);
}

function previewKind(): BoltKind | ThrownKind | null {
  const me = net ? net.client.localPlayer : state.players.find((p) => p.id === localId);
  if (!me || !me.alive || !view.preview) return null;
  if (input.grenadeHeld && me.grenades > 0) return 'grenade';
  if (input.bounceHeld && me.bounceGrenades > 0) return 'bounceGrenade';
  if (!input.aiming) return null;
  const id = WEAPON_IDS[me.weapon];
  if (id === 'hammer' || id === 'flag' || id === 'rocket' || id === 'seeker' || id === 'chaos') return null; // rockets steer and burn; the repeater's speed is a lottery
  if (id === 'scatter') return 'pellet'; // the middle of the spray
  if (id === 'revolver') return 'bullet';
  if (id === 'pistol') return me.charge >= 1 ? 'overcharge' : 'pistol';
  if (id === 'launcher') return 'fuelRod';
  return id;
}

function frame(now: number) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  // (a network game never pauses, and runs a shade fast or slow to stay in step with the server)
  if (net) acc += dtReal * net.client.timeScale;
  else if (!view.paused) acc += dtReal * view.timeScale;
  let steps = 0;
  while (acc >= DT && steps < MAX_STEPS) {
    simTick();
    acc -= DT;
    steps++;
  }
  if (steps === MAX_STEPS) acc = 0; // can't keep up: drop time rather than spiral
  const alpha = acc / DT;

  // what to draw: the local world, or (network) everyone else interpolated and you predicted
  const rstate = (net && net.client.renderState(alpha, dtReal)) || state;
  const rprev = net ? NO_PREV : prev, ralpha = net ? 1 : alpha;
  const fa = net ? rstate.frameAngle : prevFrameAngle + (state.frameAngle - prevFrameAngle) * alpha;
  const me = rstate.players.find((p) => p.id === localId);
  const myTick = net?.client.pred?.tick ?? state.tick; // (the tick your own timers run on)
  // Twin rings: draw everything in the frame of the ring you're on.
  const vf: 0 | 1 = cfg.twin && me && me.pos[2] >= 0 ? 1 : 0;
  views.twin = cfg.twin;
  views.viewFrame = vf;
  views.viewTheta = fa;
  const viewAngle = vf ? -fa : fa;
  rs.setFrameAngle(viewAngle);
  rs.setTwinView(fa, vf);
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
    const p0 = views.toView(rprev.get(me.id) ?? me.pos), p1 = views.toView(me.pos);
    const pos: Vec3 = [p0[0] + (p1[0] - p0[0]) * ralpha, p0[1] + (p1[1] - p0[1]) * ralpha, p0[2] + (p1[2] - p0[2]) * ralpha];
    const v = viewVectors(pos, input.yaw, input.pitch);
    const eo = eyeOffset(me);
    const eye = new THREE.Vector3(pos[0] + v.up[0] * eo, pos[1] + v.up[1] * eo, pos[2] + v.up[2] * eo);
    camera.up.set(...v.up);
    const riding = me.alive && me.vehicle >= 0;
    // third person on a bike: behind and above, looking where you aim
    if (riding) camera.layers.enable(LAYER_SELF);
    else if (!view.freefly) camera.layers.disable(LAYER_SELF);
    if (riding) {
      camera.position.set(eye.x - v.aim[0] * 6 + v.up[0] * 1.6, eye.y - v.aim[1] * 6 + v.up[1] * 1.6, eye.z - v.aim[2] * 6 + v.up[2] * 1.6);
      camera.lookAt(eye.x + v.aim[0] * 12, eye.y + v.aim[1] * 12, eye.z + v.aim[2] * 12);
    } else if (me.alive) {
      camera.position.copy(eye);
      camera.lookAt(eye.x + v.aim[0], eye.y + v.aim[1], eye.z + v.aim[2]);
    } else {
      // death cam: up and back from where you fell, looking down at the spot
      camera.position.set(pos[0] + v.up[0] * 4 - v.forward[0] * 4, pos[1] + v.up[1] * 4 - v.forward[1] * 4, pos[2] + v.up[2] * 4 - v.forward[2] * 4);
      camera.lookAt(pos[0], pos[1], pos[2]);
    }
  }

  views.cameraPos.copy(camera.position);
  rs.updateSun(viewAngle, camera.position);
  rs.updateLifts(state.level);
  views.render(rstate, rprev, ralpha, dtReal);
  // trajectory preview (real physics, includes the shooter's own velocity)
  const pk = previewKind();
  const maxT = pk === 'laconic' ? cfg.weapons.laconic.lifetime : 22;
  views.setPreview(pk ? predictTrajectory(net?.client.pred ?? state, localId, pk, input.yaw, input.pitch, maxT) : null, BOLT_COLORS[pk ?? 'rifle']);
  // first-person gun, mouse slowdown while charging the laser, owned list for the wheel
  views.setViewWeapon(me?.weapon ?? 0, !!me && me.alive && !view.freefly && me.vehicle < 0, me?.carrying ?? -1);
  views.setViewCharge(me, myTick);
  input.lookScale = me && isLaconicBusy(me, myTick) ? cfg.weapons.laconic.chargeLookScale : 1;
  views.reloadDip = me && me.reloadUntil > myTick && me.reloadWeapon === me.weapon ? Math.min(1, views.reloadDip + dtReal * 6) : Math.max(0, views.reloadDip - dtReal * 6);
  if (me) input.owned = me.owned;

  // main view
  const W = window.innerWidth, H = window.innerHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.render(rs.scene, camera);

  // inertial picture-in-picture: a camera fixed in the NON-rotating frame
  document.getElementById('pip-label')!.classList.toggle('hidden', !view.inertial);
  if (view.inertial && rs.sky !== 'earth') {
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

  checkOutcome(now);
  // this level's tips, one after another (each stays up until the next, at most 9 s)
  const tips = currentLevel.tips ?? [];
  const tNow = state.tick * DT;
  let tip = '';
  for (let i = 0; i < tips.length; i++) if (tNow >= tips[i].at && tNow < Math.min(tips[i].at + 9, tips[i + 1]?.at ?? Infinity)) tip = tips[i].text;
  const tipEl = $('tip');
  if (tip && tipEl.textContent !== tip) tipEl.textContent = tip;
  tipEl.classList.toggle('on', !!tip && screen === 'playing');
  // (on ring 1 of the twin rings, spinward is the other way round)
  const ni = $('net-info');
  ni.classList.toggle('hidden', !net);
  if (net) {
    const st = net.client.stats;
    ni.textContent = `online · ping ${st.rtt.toFixed(0)} ms · ${st.pending} inputs ahead · last correction ${(st.lastCorrection * 100).toFixed(1)} cm`;
  }
  hud.update(rstate, me, { yaw: input.yaw + (vf ? Math.PI : 0), timeScale: view.timeScale, paused: view.paused, freefly: view.freefly, sprintOn: input.sprintOn, showScores: input.keys.has('Tab') });
  requestAnimationFrame(frame);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- menus
// Screens: title -> level list -> playing <-> paused, and the campaign's
// win/lose screen. Playing == pointer locked: losing the lock (Esc) pauses and
// shows the debug panel.
type Screen = 'title' | 'levels' | 'custom' | 'mp' | 'playing' | 'paused' | 'outcome';
let screen: Screen = 'title';
let outcomeAt = 0; // when the campaign outcome was first seen (performance.now)
const $ = (id: string) => document.getElementById(id)!;
const overlays: Record<string, HTMLElement> = { title: $('loading'), levels: $('levels'), custom: $('custom'), mp: $('mp'), paused: $('pause'), outcome: $('outcome') };
document.querySelector('#pause .controls')!.innerHTML = document.querySelector('#loading .controls')!.innerHTML;

function show(next: Screen) {
  screen = next;
  for (const [k, el] of Object.entries(overlays)) el.classList.toggle('hidden', k !== next);
  $('hud').classList.toggle('hidden', next === 'title' || next === 'levels' || next === 'custom');
  $('build').classList.toggle('hidden', next === 'playing');
  view.paused = next !== 'playing';
  if (next === 'paused' && !net) gui.show(); // (the debug panel changes the rules: not in a network game)
  else gui.hide();
  $('pause-title').textContent = net ? 'MENU (the game goes on)' : 'PAUSED';
  $('btn-change').classList.toggle('hidden', !net);
  $('btn-restart').textContent = net ? 'Restart match' : 'Restart level';
  $('btn-menu').textContent = net ? 'Leave the server' : 'Quit to menu';
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
  if (locked) show('playing');
  else if (screen === 'playing') show((state.outcome !== 'playing' || state.over) && outcomeAt ? 'outcome' : 'paused');
});

const fmtSpin = (R: number) => `${((2 * Math.PI) / Math.sqrt(cfg.g / R)).toFixed(1)} s spin`;
function showLevels(mode: GameMode) {
  $('levels-title').textContent = net ? 'MULTIPLAYER: CHOOSE A LEVEL' : mode === 'campaign' ? 'CAMPAIGN' : 'DEATHMATCH';
  const ms = $('match-setup');
  ms.classList.toggle('hidden', mode !== 'sandbox');
  if (mode === 'sandbox') buildMatchPanel(ms, () => showLevels(mode));
  const list = $('level-list');
  list.innerHTML = '';
  delete list.dataset.last;
  // sandbox levels are grouped by what's special about them
  const groupOf = (d: LevelDef) => {
    const c = d.config;
    if (d.mode === 'campaign') return '';
    if (c.spin === false) return 'EARTH (FOR COMPARISON)';
    if ((c.R ?? 0) >= 500 || (c.halfWidth ?? 0) >= 500) return 'HUGE (BEST ONCE VEHICLES ARE BETTER)';
    if (c.floorHoles || c.deckHeight || c.spinChange || c.planetPull || (c.dragType && c.dragType !== 'none')) return 'GIMMICKS';
    if (c.tube || c.terrainSphere || c.hills || c.ridgeHeight) return 'SHAPES AND TERRAIN';
    return 'RINGS';
  };
  const defs = LEVELS.filter((l) => l.mode === mode);
  const ORDER = ['', 'RINGS', 'SHAPES AND TERRAIN', 'GIMMICKS', 'HUGE (BEST ONCE VEHICLES ARE BETTER)', 'EARTH (FOR COMPARISON)'];
  const groups = [...new Set(defs.map(groupOf))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  for (const def of groups.flatMap((g) => defs.filter((d) => groupOf(d) === g))) {
    const g = groupOf(def);
    if (g && list.dataset.last !== g) {
      const h = document.createElement('div');
      h.className = 'level-group';
      h.textContent = g;
      list.appendChild(h);
      list.dataset.last = g;
    }
    const card = document.createElement('div');
    card.className = 'level-card';
    const bases = basesFor(def, sim.defaultConfig());
    const who = mode === 'campaign' ? `${def.enemies?.length ?? 0} enemies` : `${def.bots ?? 0} bots${bases ? (match.ctf ? ' · capture the flag' : ' · team bases') : match.ctf && match.teams >= 2 ? ' · no bases here: team deathmatch' : ''}`;
    card.innerHTML = `<h3>${def.name}</h3><div class="stats">${def.config.spin === false ? "flat ground · no spin" : `R ${def.config.R} m · ${fmtSpin(def.config.R ?? 100)}`} · ${who}</div><p>${def.blurb}</p>`;
    card.addEventListener('click', () => {
      rOverride = null;
      if (net) net.client.requestStart({ def, setup: setupFor(def) }); // (the server starts it for everyone)
      else startGame(def);
      requestPlay();
    });
    list.appendChild(card);
  }
  show('levels');
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#loading button[data-mode]')) {
  b.addEventListener('click', () => showLevels(b.dataset.mode as GameMode));
}
$('btn-back').addEventListener('click', () => show(net ? 'paused' : 'title'));
buildPlayerPanel($('player-setup'));
$('btn-gfx').textContent = `Graphics: ${gfx === 'high' ? 'High' : 'Low'}`;
$('btn-gfx').addEventListener('click', () => {
  try { localStorage.setItem('cr-graphics', gfx === 'high' ? 'low' : 'high'); } catch { /* can't remember it: still switch for now */ }
  location.reload();
});

// Build a level: the form, a random one, and a link that rebuilds it.
let custom: CustomSettings = { ...CUSTOM_DEFAULTS };
function showCustom(s: CustomSettings) {
  custom = s;
  buildCustomForm($('custom-form'), custom, (ns) => { custom = ns; $('custom-note').textContent = ''; });
  $('custom-note').textContent = '';
  show('custom');
}
$('btn-custom').addEventListener('click', () => showCustom(custom));
$('btn-custom-back').addEventListener('click', () => show('title'));
$('btn-custom-random').addEventListener('click', () => showCustom(randomCustom()));
$('btn-custom-play').addEventListener('click', () => {
  rOverride = null;
  history.replaceState(null, '', `#custom=${encodeCustom(custom)}`);
  if (net) net.client.requestStart({ def: customLevel(custom), setup: setupFor({ ...customLevel(custom), mode: 'sandbox' }) });
  else startGame(customLevel(custom));
  requestPlay();
});
$('btn-custom-link').addEventListener('click', () => {
  const url = `${location.origin}${location.pathname}#custom=${encodeCustom(custom)}`;
  history.replaceState(null, '', `#custom=${encodeCustom(custom)}`);
  navigator.clipboard?.writeText(url).then(
    () => { $('custom-note').textContent = 'Link copied: anyone who opens it gets this level.'; },
    () => { $('custom-note').textContent = url; },
  ) ?? ($('custom-note').textContent = url);
});
$('btn-resume').addEventListener('click', requestPlay);
const restart = () => { if (net) { if (net.client.spec) net.client.requestStart(net.client.spec); } else newWorld(); requestPlay(); };
const toTitle = () => { netLeave(); show('title'); };
$('btn-restart').addEventListener('click', restart);
$('btn-menu').addEventListener('click', toTitle);
$('btn-menu2').addEventListener('click', toTitle);
$('btn-retry').addEventListener('click', restart);
$('btn-change').addEventListener('click', () => showLevels('sandbox'));

// ---------------------------------------------------------------- multiplayer
/** "host:port", "ws://...", or an http address someone pasted: the WebSocket address for it. */
function wsUrl(addr: string): string {
  let a = addr.trim();
  if (/^wss?:\/\//i.test(a)) return a;
  const secure = /^https:\/\//i.test(a) || (!/^http:\/\//i.test(a) && location.protocol === 'https:');
  a = a.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return `${secure ? 'wss' : 'ws'}://${a}`;
}

function netLeave() {
  if (!net) return;
  const { ws } = net;
  net = null;
  try { ws.close(); } catch { /* already gone */ }
  startGame(levelById('s-standard')!); // (a local world again, behind the menus)
}

function netConnect(addr: string) {
  netLeave();
  const status = $('mp-status');
  let url: string;
  try { url = wsUrl(addr); new URL(url); } catch { status.textContent = "That doesn't look like an address."; return; }
  try { localStorage.setItem('cr-server', addr.trim()); } catch { /* not remembered */ }
  status.textContent = `Connecting to ${url} ...`;
  let ws: WebSocket;
  try { ws = new WebSocket(url); } catch { status.textContent = `Can't open ${url} (a page loaded over https can only reach wss:// servers).`; return; }
  ws.binaryType = 'arraybuffer';
  const client = new NetClient((bytes) => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); }, {
    now: () => performance.now(),
    onEvent: (e) => handleEvent(e),
    onRename: (from, to) => views.renameProj(from, to),
    onError: (text) => hud.push(`<span style="color:#ff6a3d">${text.replace(/[<>&]/g, '')}</span>`),
    onMatch: (c) => {
      // a (new) match: the server's world, built here from its description
      state = c.world!;
      Object.assign(cfg, state.config);
      state.config = cfg;
      localId = c.localId;
      botIds = [];
      currentLevel = c.spec!.def;
      outcomeAt = 0;
      gui.controllersRecursive().forEach((g) => g.updateDisplay());
      rs.build(cfg, state.level, 'space');
      views.reset();
      views.localId = localId;
      input.pitch = 0;
      input.weapon = 0;
      prev = new Map();
      status.textContent = '';
      if (document.pointerLockElement === canvas) show('playing'); else show('paused');
    },
  });
  const session = { ws, client };
  net = session;
  ws.onopen = () => { status.textContent = 'Connected: joining ...'; client.hello(player.name, player.color, match.teams >= 2 ? match.myTeam : -1); };
  ws.onmessage = (ev) => { if (net === session) client.receive(new Uint8Array(ev.data as ArrayBuffer)); };
  const lost = (why: string) => {
    if (net !== session) return;
    net = null;
    startGame(levelById('s-standard')!);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    show('mp');
    status.textContent = why;
  };
  ws.onclose = () => lost(client.world ? 'Disconnected from the server.' : `Couldn't reach ${url}.`);
  ws.onerror = () => lost(`Couldn't reach ${url}.`);
}

{
  // the address: remembered, or (when this page came from a game server) the server it came from
  const addr = $('mp-addr') as HTMLInputElement;
  let saved = '';
  try { saved = localStorage.getItem('cr-server') ?? ''; } catch { /* none */ }
  const served = !/github\.io$/.test(location.hostname) && location.protocol !== 'file:' && location.port !== '5173';
  addr.value = served ? location.host : saved;
  $('btn-mp').addEventListener('click', () => { $('mp-status').textContent = ''; show('mp'); });
  $('btn-mp-back').addEventListener('click', () => { netLeave(); show('title'); });
  $('btn-mp-connect').addEventListener('click', () => netConnect(addr.value));
  addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') netConnect(addr.value); });
}
$('btn-next').addEventListener('click', () => {
  const next = nextCampaignLevel();
  if (next) { rOverride = null; startGame(next); requestPlay(); }
});

function nextCampaignLevel(): LevelDef | undefined {
  const camp = LEVELS.filter((l) => l.mode === 'campaign');
  return camp[camp.indexOf(currentLevel) + 1];
}

/** Campaign over: give it a moment, then release the mouse and show the result. */
function checkOutcome(now: number) {
  if (state.over) return matchOutcome(now);
  if (state.mode !== 'campaign' || state.outcome === 'playing') return;
  // only while you're in the level: once you've gone back to the menus, leave them be
  if (screen !== 'playing' && screen !== 'paused') return;
  if (!outcomeAt) outcomeAt = now;
  if (now - outcomeAt < 1500) return;
  const won = state.outcome === 'won';
  ($('outcome-title') as HTMLElement).style.color = '';
  $('outcome-title').textContent = won ? 'LEVEL CLEAR' : 'YOU DIED';
  const next = nextCampaignLevel();
  $('outcome-sub').textContent = won ? (next ? `Next: ${next.name}` : 'That was the last level. For now.') : currentLevel.name;
  $('btn-next').classList.toggle('hidden', !won || !next);
  if (document.pointerLockElement === canvas) document.exitPointerLock(); // -> pointerlockchange -> outcome
  else show('outcome');
}

/** A deathmatch or capture-the-flag match has ended (score or time limit): who won. */
function matchOutcome(now: number) {
  if (screen !== 'playing' && screen !== 'paused') return;
  if (!outcomeAt) outcomeAt = now;
  if (now - outcomeAt < 2500) return;
  const me = state.players.find((p) => p.id === localId);
  const w = state.winner, teams = state.config.teams >= 2;
  const title = $('outcome-title') as HTMLElement;
  title.style.color = '';
  if (w < 0) title.textContent = 'A DRAW';
  else if (teams) {
    title.textContent = `${sim.TEAM_NAMES[w].toUpperCase()} WINS`;
    title.style.color = `#${sim.TEAM_COLORS[w].toString(16).padStart(6, '0')}`;
  } else title.textContent = w === localId ? 'YOU WIN' : `${state.players.find((p) => p.id === w)?.name ?? '?'} WINS`.toUpperCase();
  const scores = sim.matchScores(state).sort((a, b) => b.score - a.score).slice(0, 6)
    .map((x) => `${teams ? sim.TEAM_NAMES[x.id] : state.players.find((p) => p.id === x.id)?.name ?? '?'} ${x.score}`).join(' · ');
  const mine = w >= 0 && (teams ? me?.team === w : w === localId);
  $('outcome-sub').textContent = (w < 0 ? '' : mine ? (teams ? 'Your team took it. ' : '') : 'Not this time. ') + scores;
  $('btn-next').classList.add('hidden');
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  else show('outcome');
}

// ---------------------------------------------------------------- boot
declare const __BUILD_ID__: string;
$('build').textContent = `build ${__BUILD_ID__}`;
startGame(currentLevel); // backdrop behind the title screen
resize();
show('title');
// a shared custom-level link opens the builder with its settings
if (location.hash.startsWith('#custom=')) {
  const s = decodeCustom(location.hash.slice('#custom='.length));
  if (s) showCustom(s);
}
requestAnimationFrame((t) => {
  last = t;
  frame(t);
});

// Debug handle (console / automated checks).
(window as unknown as { __game: unknown }).__game = {
  get state() { return state; }, get localId() { return localId; }, get screen() { return screen; }, sim, input, view, cfg, gui, views,
  newWorld, startGame, levelById, show, setFreefly, localBasis, omegaOf, rs, renderer,
};
