import type { Vec3 } from './vec';

export const TICK_RATE = 120;
export const DT = 1 / TICK_RATE;

export type DragType = 'none' | 'linear' | 'quadratic';
export type Falloff = 'none' | 'linear' | 'quadratic';

/** All tunables. Lives inside SimState so it is serialized with it. */
export interface SimConfig {
  R: number; // floor radius (m)
  g: number; // target apparent gravity at the floor (m/s^2); omega = sqrt(g/R)
  halfWidth: number; // half of the ring width along Z
  wallHeight: number;
  wallThickness: number;
  hullThickness: number;

  centrifugal: boolean; // debug toggles (physics comparison)
  coriolis: boolean;
  dragType: DragType;
  dragCoeff: number; // k (1/s) for linear, c (1/m) for quadratic

  restitution: number;
  friction: number;

  // weapons
  muzzleRifle: number;
  muzzlePistol: number;
  muzzleOvercharge: number;
  muzzleGrenade: number; // throw speed (both grenade types)
  projectileLifetime: number; // seconds
  grenadeFuse: number; // sticky: seconds after sticking
  bounceFuse: number; // bouncing: seconds after the throw
  bounceRestitution: number;
  grenadeMaxFlight: number; // seconds before an unstuck grenade pops anyway

  // explosions
  explosionRadius: number;
  explosionDamage: number;
  knockbackSpeed: number; // delta-v given to an 80 kg player at point blank
  knockbackScale: number;
  knockbackFalloff: Falloff;
  liftBias: number; // 0 = purely radial from blast; >0 biases toward the axis ("up")
  selfDamageScale: number;

  // world edge
  fallKillDistance: number; // m beyond the ring's hull before a falling body is dead

  // players
  walkSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  groundAccel: number;
  slideDecel: number;
  maxHealth: number;
  maxShield: number;
  shieldRegenDelay: number; // s
  shieldRegenRate: number; // per s
  respawnTime: number; // s
}

export const defaultConfig = (): SimConfig => ({
  R: 100,
  g: 9.81,
  halfWidth: 20,
  wallHeight: 15,
  wallThickness: 1.5,
  hullThickness: 3,

  centrifugal: true,
  coriolis: true,
  dragType: 'none',
  dragCoeff: 0,

  restitution: 0.35,
  friction: 0.5,

  muzzleRifle: 25,
  muzzlePistol: 30,
  muzzleOvercharge: 14,
  muzzleGrenade: 16,
  projectileLifetime: 60,
  grenadeFuse: 1.2,
  bounceFuse: 2.5,
  bounceRestitution: 0.6,
  grenadeMaxFlight: 12,

  explosionRadius: 6,
  explosionDamage: 110,
  knockbackSpeed: 20,
  knockbackScale: 1,
  knockbackFalloff: 'linear',
  liftBias: 0.35,
  selfDamageScale: 0.3,

  fallKillDistance: 25,

  walkSpeed: 9,
  sprintSpeed: 15,
  jumpSpeed: 8,
  groundAccel: 90,
  slideDecel: 12,
  maxHealth: 100,
  maxShield: 70,
  shieldRegenDelay: 4,
  shieldRegenRate: 35,
  respawnTime: 3,
});

export const omegaOf = (c: SimConfig) => Math.sqrt(c.g / c.R);

// ---------------------------------------------------------------- input

export const BTN_FIRE = 1;
export const BTN_AIM = 2; // trajectory preview (client-only meaning, still sent)
export const BTN_JUMP = 4;
export const BTN_SPRINT = 8;
export const BTN_GRENADE = 16; // sticky grenade: hold to aim, release to throw
export const BTN_GRENADE2 = 32; // bouncing grenade: hold to aim, release to throw

export const WEAPON_RIFLE = 0;
export const WEAPON_PISTOL = 1;
export const WEAPON_HOVER = 2;
export const WEAPON_NAMES = ['Plasma Rifle', 'Plasma Pistol', 'Hover Gun (debug)'];

/** One tick of player intent. The ONLY way gameplay is driven. */
export interface InputCmd {
  playerId: number;
  tick: number;
  moveX: number; // strafe right [-1,1]
  moveY: number; // forward [-1,1]
  yaw: number; // local-frame yaw (0 = spinward, +pi/2 = +Z axial)
  pitch: number; // local-frame pitch (+ = toward axis)
  buttons: number;
  weapon: number; // desired weapon slot
}

export const neutralInput = (playerId: number, tick: number): InputCmd => ({
  playerId, tick, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0,
});

// ---------------------------------------------------------------- entities

export type PlayerKind = 'human' | 'bot' | 'dummy';

export interface Player {
  id: number;
  type: 'player';
  kind: PlayerKind;
  name: string;
  pos: Vec3; // capsule centre
  vel: Vec3; // rotating-frame velocity
  yaw: number;
  pitch: number;
  grounded: boolean;
  groundNormal: Vec3 | null;
  apparentG: number; // normal force / (m g), smoothed
  alive: boolean;
  respawnTick: number;
  homeSpawn: number; // spawn index (dummies always return home)
  health: number;
  shield: number;
  lastDamageTick: number;
  lastAttacker: number;
  weapon: number;
  rifleHeat: number;
  rifleOverheatUntil: number;
  pistolHeat: number;
  pistolCharge: number; // 0..1
  pistolHoldTicks: number;
  fireReadyTick: number;
  grenades: number; // sticky
  bounceGrenades: number;
  grenadeReadyTick: number;
  prevButtons: number;
  lastInput: InputCmd;
  kills: number;
  deaths: number;
}

export type BoltKind = 'rifle' | 'pistol' | 'overcharge' | 'hover';

export interface Bolt {
  id: number;
  type: 'bolt';
  kind: BoltKind;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  launchVel: Vec3; // rotating-frame velocity at launch (for tests / debugging)
  radius: number;
  damage: number;
  shieldDamage: number;
  armed: boolean; // false until it has cleared its owner's capsule
  spawnTick: number;
  expireTick: number;
}

export type GrenadeKind = 'sticky' | 'bounce';
export type ThrownKind = 'grenade' | 'bounceGrenade';

export type StickTarget =
  | { kind: 'world' }
  | { kind: 'player'; id: number; offset: Vec3 } // offset in target's local (spin, up, axial) basis
  | { kind: 'prop'; id: number; offset: Vec3 };

export interface Grenade {
  id: number;
  type: 'grenade';
  variant: GrenadeKind;
  owner: number;
  pos: Vec3;
  vel: Vec3;
  launchVel: Vec3;
  radius: number;
  armed: boolean;
  stuck: StickTarget | null;
  contactNormal: Vec3 | null; // bouncing grenades rolling/resting on a surface
  fuseTick: number; // sticky: -1 until stuck; bounce: set at throw
  spawnTick: number;
  expireTick: number;
}

export interface Prop {
  id: number;
  type: 'prop';
  pos: Vec3;
  vel: Vec3;
  radius: number;
  mass: number;
  contactNormal: Vec3 | null;
}

export interface Explosion {
  id: number;
  type: 'explosion';
  owner: number;
  pos: Vec3;
  radius: number;
  tick: number;
  endTick: number;
}

/** Obstacle box: axis-aligned in the local frame of its ring angle. */
export interface Box {
  id: number;
  type: 'box';
  angle: number; // ring angle of the box centre
  center: Vec3;
  half: Vec3; // half extents along (spinward, up, axial) at `angle`
}

export interface SpawnPoint {
  angle: number;
  z: number;
}

export interface Level {
  boxes: Box[];
  spawns: SpawnPoint[];
  /** Rim wall height per equal angular sector, for the +Z and -Z walls. */
  wallPos: number[];
  wallNeg: number[];
}

export type SimEvent =
  | { type: 'fire'; owner: number; kind: BoltKind | ThrownKind; pos: Vec3 }
  | { type: 'grenadeBounce'; id: number; pos: Vec3; speed: number }
  | { type: 'impact'; pos: Vec3; kind: BoltKind; target: number }
  | { type: 'hit'; target: number; attacker: number; damage: number; shieldBroken: boolean }
  | { type: 'stick'; id: number; pos: Vec3; target: number }
  | { type: 'explode'; id: number; owner: number; pos: Vec3 }
  | { type: 'kill'; killer: number; victim: number; cause: string }
  | { type: 'respawn'; id: number }
  | { type: 'overheat'; id: number }
  | { type: 'jump'; id: number }
  | { type: 'bodyImpact'; id: number; pos: Vec3; speed: number };

export interface SimState {
  tick: number;
  /** Accumulated spin angle (= omega * t for constant omega). Inertial-frame things render at -frameAngle. */
  frameAngle: number;
  rng: number;
  nextId: number;
  config: SimConfig;
  level: Level;
  players: Player[];
  bolts: Bolt[];
  grenades: Grenade[];
  props: Prop[];
  explosions: Explosion[];
  events: SimEvent[]; // emitted during the most recent step
}
