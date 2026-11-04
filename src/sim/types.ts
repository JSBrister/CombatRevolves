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
  weapons: Record<WeaponId, WeaponStats>;
  allowHoverGun: boolean; // debug weapon, selectable only when this is on
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

  // items
  pickupRespawn: number; // s before a level pickup reappears
  dropLifetime: number; // s a dropped item lasts
  jetThrust: number; // m/s^2 toward the axis while holding jump in the air
  jetLateral: number; // m/s^2 from WASD while thrusting
  jetBurn: number; // fraction of a full tank per second

  // players
  walkSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  groundAccel: number;
  airAccel: number; // m/s^2 of air control (only up to walk speed along the wish direction)
  coyoteTime: number; // s after leaving a surface during which a jump still works
  impactDamageSpeed: number; // m/s of normal impact speed before hitting a surface hurts
  impactDamagePerMs: number; // damage per m/s above that
  slideDecel: number;
  maxHealth: number;
  maxShield: number;
  shieldRegenDelay: number; // s
  shieldRegenRate: number; // per s
  respawnTime: number; // s
  meleeDamage: number;
  meleeKnockback: number; // m/s kick
  meleeRange: number; // m in front of you
  meleeCooldown: number; // s
  friendlyFire: boolean; // false: teammates can't hurt each other (campaign enemies)
}

export const omegaOf = (c: SimConfig) => Math.sqrt(c.g / c.R);

// ---------------------------------------------------------------- input

export const BTN_FIRE = 1;
export const BTN_AIM = 2; // trajectory preview (client-only meaning, still sent)
export const BTN_JUMP = 4;
export const BTN_SPRINT = 8;
export const BTN_GRENADE = 16; // sticky grenade: hold to aim, release to throw
export const BTN_GRENADE2 = 32; // bouncing grenade: hold to aim, release to throw
export const BTN_RELOAD = 64;
export const BTN_MELEE = 128;

// Weapons are addressed by a fixed slot index (also the 1-5 number keys).
export const WEAPON_IDS = ['rifle', 'pistol', 'redRifle', 'launcher', 'cannon', 'laconic', 'hammer', 'hover'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];
export const WEAPON_RIFLE = 0;
export const WEAPON_PISTOL = 1;
export const WEAPON_RED = 2;
export const WEAPON_LAUNCHER = 3;
export const WEAPON_CANNON = 4;
export const WEAPON_LACONIC = 5;
export const WEAPON_HAMMER = 6;
export const WEAPON_HOVER = 7;
export const WEAPON_NAMES = [
  'Plasma Rifle', 'Plasma Pistol', 'Red Plasma Rifle', 'Fuel Rod Launcher', 'Plasma Bolt Cannon', 'Laconic Laser', 'Grav Mallet',
  'Hover Gun (debug)',
];
/** Number keys 1..N select the first N weapons; the hover gun is debug-panel only. */
export const PLAYER_WEAPON_SLOTS = 7;
export const STARTING_WEAPONS = [WEAPON_RIFLE, WEAPON_PISTOL];

/** Tunable stats for one weapon. Fields a weapon doesn't use stay 0. */
export interface WeaponStats {
  muzzle: number; // m/s relative to the shooter
  damage: number;
  shieldDamage: number;
  interval: number; // s between shots
  heatPerShot: number; // 0 = never overheats
  coolRate: number; // heat per s
  overheatLock: number; // s locked out after overheating
  radius: number; // bolt radius (m)
  lifetime: number; // s
  ammoMax: number; // spare rounds you can carry; 0 = unlimited (heat-limited weapon)
  magSize: number; // rounds per magazine (ammo weapons)
  reloadTime: number; // s
  knockback: number; // m/s kick a hit gives an 80 kg player, along the bolt's path
  chargeTime: number; // s (pistol overcharge, Laconic Laser)
  burstTime: number; // s the Laconic Laser keeps firing once charged
  // pistol overcharge shot
  ocMuzzle: number;
  ocDamage: number;
  ocShieldDamage: number;
  ocHeat: number;
  // explosive bolts (fuel rod)
  blastRadius: number;
  blastDamage: number;
  blastKnockback: number;
  // Laconic Laser: movement and aim penalties while charging and firing
  chargeMoveScale: number;
  chargeLookScale: number;
}

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
  team: number; // players on the same team can't hurt each other unless friendlyFire
  size: number; // 1 = standard; scales the collision capsule and model
  color: number; // body colour, -1 = default for the kind
  enemyType: string; // key into ENEMY_TYPES ('' for humans and sandbox bots)
  maxHealth: number;
  maxShield: number;
  speedScale: number; // multiplies run speed
  canRespawn: boolean;
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
  weapon: number; // index into WEAPON_IDS
  owned: number[]; // weapon indices, sorted
  heat: number[]; // per weapon index, 0..1
  overheatUntil: number[]; // per weapon index (tick)
  ammo: number[]; // spare rounds per weapon index (only for ammo weapons)
  mag: number[]; // rounds in the magazine per weapon index
  reloadUntil: number; // tick the current reload finishes (0 = not reloading)
  infiniteAmmo: boolean; // campaign enemies: spare rounds never run out (they still reload)
  charge: number; // 0..1: pistol overcharge or Laconic Laser charge
  holdTicks: number;
  needRelease: boolean; // release the trigger before charging again
  burstUntil: number; // Laconic Laser: firing until this tick
  meleeReadyTick: number;
  fireReadyTick: number;
  hasJetpack: boolean;
  jetFuel: number; // 0..1
  jetting: boolean; // thrusting this tick (for visuals)
  lastGroundTick: number;
  lastJumpTick: number;
  grenades: number; // sticky
  bounceGrenades: number;
  grenadeReadyTick: number;
  prevButtons: number;
  lastInput: InputCmd;
  kills: number;
  deaths: number;
}

export type BoltKind = 'rifle' | 'redRifle' | 'pistol' | 'overcharge' | 'fuelRod' | 'cannon' | 'laconic' | 'hover';

export type ItemKind = 'health' | 'sticky' | 'bounce' | 'redRifle' | 'launcher' | 'cannon' | 'laconic' | 'hammer' | 'rifle' | 'pistol' | 'jetpack';

/** Floating item pickup (not a physics object). */
export interface Pickup {
  id: number;
  type: 'pickup';
  item: ItemKind;
  pos: Vec3;
  amount: number; // -1 = full refill; otherwise ammo / grenades / fuel*100 carried
  respawnTicks: number; // 0 = one-shot (dropped items)
  activeAt: number; // tick from which it can be collected
  expireTick: number; // -1 = never
}

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
  kind: 'cover' | 'ramp';
  angle: number; // ring angle of the box centre
  tilt: number; // rotation about the axial direction (ramps): + tips the spinward end up
  center: Vec3;
  half: Vec3; // half extents along (spinward, up, axial) at `angle`
}

export interface SpawnPoint {
  angle: number;
  z: number;
}

/**
 * Level geometry. `shape` names the kind of world; the collision shape
 * (level.ts: levelSdf), the force field (physics.ts) and the renderer
 * (client/scene.ts) switch on it. Only the spinning 'ring' exists so far.
 */
export type LevelShape = 'ring';

export interface Level {
  shape: LevelShape;
  boxes: Box[];
  stairTops: Vec3[]; // a floor point on each staircase's lookout (add stand height to place a player)
  spawns: SpawnPoint[];
  pickupSpots: { pos: Vec3; item: ItemKind }[];
  /** Rim wall height per equal angular sector, for the +Z and -Z walls. */
  wallPos: number[];
  wallNeg: number[];
}

export type SimEvent =
  | { type: 'fire'; owner: number; kind: BoltKind | ThrownKind; pos: Vec3 }
  | { type: 'grenadeBounce'; id: number; pos: Vec3; speed: number }
  | { type: 'impact'; pos: Vec3; kind: BoltKind; target: number; owner: number }
  | { type: 'hit'; target: number; attacker: number; damage: number; shieldBroken: boolean }
  | { type: 'stick'; id: number; pos: Vec3; target: number }
  | { type: 'explode'; id: number; owner: number; pos: Vec3 }
  | { type: 'kill'; killer: number; victim: number; cause: string }
  | { type: 'respawn'; id: number }
  | { type: 'outcome'; outcome: Outcome }
  | { type: 'reload'; id: number }
  | { type: 'melee'; id: number; target: number; pos: Vec3 }
  | { type: 'pickup'; id: number; item: ItemKind; player: number; pos: Vec3 }
  | { type: 'overheat'; id: number }
  | { type: 'jump'; id: number }
  | { type: 'bodyImpact'; id: number; pos: Vec3; speed: number };

export type GameMode = 'sandbox' | 'campaign';
export type Outcome = 'playing' | 'won' | 'lost';

export interface SimState {
  tick: number;
  mode: GameMode;
  levelId: string;
  outcome: Outcome; // campaign: won when every enemy is dead, lost when you die
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
  pickups: Pickup[];
  events: SimEvent[]; // emitted during the most recent step
}
