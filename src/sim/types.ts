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
  spin: boolean; // false: the world doesn't rotate at all (Earth)
  world: 'ring' | 'planet' | 'disk'; // 'planet': on the OUTSIDE of a spinning ball of radius R, gravity g toward its centre; 'disk': on top of a spinning disk of radius R, gravity g straight down the axis
  planetSpin: number; // planet: how much of g the spin cancels at the equator; disk: the spin's outward push at the rim, as a multiple of g. Sets the spin rate
  teams: number; // 0 = everyone for themselves; 2-4 = teams (teammates can't hurt each other)
  teamBases: boolean; // with teams: each team has a home (spawns, a flag stand) and the pickups are the same on every side
  tower: number; // ring world: >0 = a spin tower through the axis instead of a ring: the top (hub) floor's least half-width round the spin (m); the floors below are bigger
  diskBowl: boolean; // disk: the surface curves up (a paraboloid, like water in a spinning bucket) so gravity is always straight into it
  outerShell: number; // planet: >0 = a hollow shell of this radius round the ball, walkable on its inside near its equator
  launchPads: boolean; // nested spheres: launch pads between ball and shell
  twin: boolean; // two rings side by side spinning opposite ways (z < 0 at +omega, z > 0 at -omega), a gap at the seam
  twinGap: number; // width of the gap between them (m)
  arena: number; // 0 = the whole ring is playable; >0 = only this many metres of it (end walls), e.g. Earth
  terrainSphere: boolean; // floor is a band round the inside of a sphere of radius R (curves up at the edges)
  hills: number; // how many Gaussian hills on the floor (0 = flat)
  hillHeight: number; // tallest hill (m)
  mountains: number; // big, wide massifs
  mountainHeight: number; // tallest (m)
  bases: number; // grey two-storey bases (on flat ground)
  ridgeHeight: number; // a ridge along the middle of the ring, this high (m): a Lambda-shaped cross-section
  ridgePlateau: number; // how rounded the ridge's top is (m)
  /**
   * Tube worlds (the floor's cross-section is a circle of radius tubeRadius
   * touching radius R at z = 0): 'inside' a torus (a Stanford torus: the floor
   * curves up into a ceiling), a 'half' torus (an open half-pipe), or standing
   * on the 'outside' of one (a log: slip too far and you fall off).
   */
  tube: 'none' | 'inside' | 'half' | 'outside';
  tubeRadius: number;
  floorHoles: number; // holes in the floor you can fall through into space
  floorTexture: 'auto' | 'deck' | 'grass' | 'sand' | 'snow' | 'rock'; // how the floor looks (rendering only)
  biomes: boolean; // O'Neill windows: each land strip its own biome (grass, sand, snow...); mountains on the snow
  windows: number; // O'Neill-style: this many glass strips the length of the ring, alternating with land
  spinChange: number; // 0 = steady spin; >0: the spin periodically drops by this fraction (1 = stops dead, 2 = full speed backwards) and comes back
  spinPeriod: number; // s per spin-change cycle
  comboHits: number; // this many seeker hits on one target, each within comboWindow s of the last...
  comboWindow: number;
  comboDamage: number; // ...set off a supercombine: a blast this strong
  comboRadius: number;
  comboKnockback: number;
  deckHeight: number; // >0: a second deck this far above the floor, with ramps up through slots in it
  planetPull: number; // m/s^2: a uniform pull fixed relative to the stars (a planet below); it sweeps round as the ring turns
  planetAngle: number; // direction of that pull in the non-rotating frame (radians about the axis)
  gravity: number; // real gravity toward the floor (m/s^2), on top of any spin. 0 on a normal ring.
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
  // hover-bikes
  vehicleMinRadius: number; // rings at least this big get hover-bikes
  vehicleSpacing: number; // one bike per this many metres of ring
  bikeHealth: number;
  bikeThrust: number; // m/s^2
  bikeStrafe: number; // m/s^2
  bikeMaxSpeed: number; // m/s (thrust stops adding speed beyond this)
  bikeDamping: number; // fraction of speed lost per second while ridden
  bikeHop: number; // m/s
  bikeBounce: number; // restitution of the bike's collisions
  bikeCrashSpeed: number; // wall/box impacts faster than this damage the bike (landings never do)
  bikeCrashDamage: number; // per m/s above that
  bikeGrip: number; // sideways grip (1/s)
  bikeHoverHeight: number;
  bikeHoverStiffness: number;
  bikeHoverDamping: number;
  bikeHoverReach: number;
  bikeRamThrow: number;
  bikeRamLift: number;
  bikeRamSpeed: number; // closing speed above which a bike hurts whoever it hits
  bikeRamDamage: number; // per m/s above that
  bikeRespawn: number; // s
  bikeBlastRadius: number;
  bikeBlastDamage: number;
  bikeBlastKnockback: number;
  meleeDamage: number;
  meleeKnockback: number; // m/s kick
  meleeRange: number; // m in front of you
  meleeCooldown: number; // s
  friendlyFire: boolean; // false: teammates can't hurt each other (campaign enemies)
}

/** Spin rate (rad/s): sqrt(g/R) gives g at the floor; 0 when the world doesn't spin (Earth). */
/** The ring's base spin rate: sqrt(g/R), or 0 for a world that doesn't spin. */
export const omegaOf = (c: SimConfig) => (!c.spin ? 0 : c.world === 'planet' || c.world === 'disk' ? Math.sqrt((c.planetSpin * c.g) / c.R) : Math.sqrt(c.g / c.R));

/**
 * Spin schedule: the multiplier on the base spin rate at time t (seconds), and
 * its time derivative. With spinChange = 0 the spin is constant. Otherwise it
 * runs a cycle every spinPeriod seconds: full spin, a smooth spin-down to
 * (1 - spinChange) of full, a hold, and a smooth spin-up again.
 */
export function spinFactor(c: SimConfig, t: number): { f: number; df: number } {
  const A = c.spinChange, T = c.spinPeriod;
  if (!A || T <= 0) return { f: 1, df: 0 };
  const u = (((t / T) % 1) + 1) % 1;
  const ramp = 0.15; // each change takes 15% of the cycle
  const smooth = (x: number) => x * x * (3 - 2 * x), dsmooth = (x: number) => 6 * x * (1 - x);
  if (u < 0.45) return { f: 1, df: 0 };
  if (u < 0.45 + ramp) { const x = (u - 0.45) / ramp; return { f: 1 - A * smooth(x), df: (-A * dsmooth(x)) / (ramp * T) }; }
  if (u < 0.75) return { f: 1 - A, df: 0 };
  if (u < 0.75 + ramp) { const x = (u - 0.75) / ramp; return { f: 1 - A + A * smooth(x), df: (A * dsmooth(x)) / (ramp * T) }; }
  return { f: 1, df: 0 };
}

/** Spin rate and angular acceleration (Euler force) for a tick, taken at its midpoint (2nd-order accurate). */
export function spinAt(c: SimConfig, tick: number): { omega: number; alpha: number } {
  const w0 = omegaOf(c);
  if (!w0) return { omega: 0, alpha: 0 };
  const { f, df } = spinFactor(c, (tick + 0.5) * DT);
  return { omega: w0 * f, alpha: w0 * df };
}

// ---------------------------------------------------------------- input

export const BTN_FIRE = 1;
export const BTN_AIM = 2; // trajectory preview (client-only meaning, still sent)
export const BTN_JUMP = 4;
export const BTN_SPRINT = 8;
export const BTN_GRENADE = 16; // sticky grenade: hold to aim, release to throw
export const BTN_GRENADE2 = 32; // bouncing grenade: hold to aim, release to throw
export const BTN_RELOAD = 64;
export const BTN_MELEE = 128;
export const BTN_USE = 256; // get on / off a vehicle

// Weapons are addressed by a fixed slot index (also the number keys), in a
// sensible order: rifles and sidearms, then the specialists, the explosives,
// the superweapon and the melee weapon. The hover gun is debug-only.
export const WEAPON_IDS = ['rifle', 'pistol', 'revolver', 'redRifle', 'chaos', 'scatter', 'cannon', 'launcher', 'rocket', 'seeker', 'laconic', 'hammer', 'hover'] as const;
export type WeaponId = (typeof WEAPON_IDS)[number];
const wi = (id: WeaponId) => WEAPON_IDS.indexOf(id);
export const WEAPON_RIFLE = wi('rifle');
export const WEAPON_PISTOL = wi('pistol');
export const WEAPON_REVOLVER = wi('revolver');
export const WEAPON_RED = wi('redRifle');
export const WEAPON_CHAOS = wi('chaos');
export const WEAPON_SCATTER = wi('scatter');
export const WEAPON_CANNON = wi('cannon');
export const WEAPON_LAUNCHER = wi('launcher');
export const WEAPON_ROCKET = wi('rocket');
export const WEAPON_SEEKER = wi('seeker');
export const WEAPON_LACONIC = wi('laconic');
export const WEAPON_HAMMER = wi('hammer');
export const WEAPON_HOVER = wi('hover');
const NAMES: Record<WeaponId, string> = {
  rifle: 'Plasma Rifle', pistol: 'Plasma Pistol', revolver: 'Revolver', redRifle: 'Overclocked Plasma Rifle', chaos: 'Roulette Repeater',
  scatter: 'Scattergun', cannon: 'Plasma Bolt Cannon', launcher: 'Fuel Rod Launcher', rocket: 'Torch Rocket', seeker: 'Seeker Swarm',
  laconic: 'Laconic Laser', hammer: 'Grav Mallet', hover: 'Hover Gun (debug)',
};
export const WEAPON_NAMES = WEAPON_IDS.map((id) => NAMES[id]);
/** Keys 1-9, 0, - and = select the first N weapons; the hover gun is debug-panel only. */
export const PLAYER_WEAPON_SLOTS = 12;
/** The key label for a weapon slot. */
export const slotKey = (i: number) => (i < 9 ? String(i + 1) : ['0', '-', '='][i - 9]);
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
  // rockets: a constant push along the rocket's own axis (which keeps its
  // direction relative to the stars unless it steers), for burnTime seconds
  thrust: number; // m/s^2
  burnTime: number; // s
  turnRate: number; // rad/s the rocket can steer toward a target (0 = no homing)
  seekRange: number; // m: how far it looks for a target
  seekAngle: number; // degrees either side of its nose it can see
  // spreads and random speeds
  pellets: number; // shots per trigger pull (scattergun)
  spread: number; // degrees: pellets fly anywhere within this cone around your aim
  muzzleMin: number; // >0: each shot's speed is random between this and `muzzle` (Roulette Repeater)
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
  reloadWeapon: number; // which weapon is reloading (it carries on if you switch away)
  infiniteAmmo: boolean; // campaign enemies: spare rounds never run out (they still reload)
  charge: number; // 0..1: pistol overcharge or Laconic Laser charge
  holdTicks: number;
  needRelease: boolean; // release the trigger before charging again
  burstUntil: number; // Laconic Laser: firing until this tick
  meleeReadyTick: number;
  vehicle: number; // id of the vehicle being ridden, or -1
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
  needles: number; // seeker hits taken recently (enough of them in a row supercombine)
  needleTick: number; // tick of the last one
  deaths: number;
}

export type BoltKind = 'rifle' | 'redRifle' | 'pistol' | 'overcharge' | 'fuelRod' | 'cannon' | 'laconic' | 'rocket' | 'seeker' | 'pellet' | 'chaos' | 'bullet' | 'hover';

export type ItemKind = 'health' | 'sticky' | 'bounce' | 'redRifle' | 'launcher' | 'cannon' | 'laconic' | 'hammer' | 'rocket' | 'seeker' | 'scatter' | 'chaos' | 'revolver' | 'rifle' | 'pistol' | 'jetpack';

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
  /** Rockets only: the nose direction (rotating-frame unit vector), when the motor stops, and who it's chasing. */
  dir: Vec3 | null;
  burnUntil: number;
  target: number;
  /** Launch speed relative to the shooter (the Roulette Repeater colours its bolts by it). */
  speed: number;
}

export type GrenadeKind = 'sticky' | 'bounce';
export type ThrownKind = 'grenade' | 'bounceGrenade';

export type StickTarget =
  | { kind: 'world' }
  | { kind: 'player'; id: number; offset: Vec3 } // offset in target's local (spin, up, axial) basis
  | { kind: 'prop'; id: number; offset: Vec3 }
  | { kind: 'vehicle'; id: number; offset: Vec3 };

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

/** Hover-bike: a frictionless (when ridden) physics sphere with its own health. */
export interface Vehicle {
  id: number;
  type: 'vehicle';
  kind: 'bike';
  pos: Vec3; // centre of the collision sphere
  vel: Vec3;
  yaw: number; // local-frame facing
  radius: number;
  health: number;
  maxHealth: number;
  driver: number; // player id, or -1
  alive: boolean;
  respawnTick: number;
  home: Vec3;
  homeYaw: number;
  contactNormal: Vec3 | null;
  lastAttacker: number;
  lastDamageTick: number;
}

export interface Explosion {
  id: number;
  type: 'explosion';
  owner: number;
  pos: Vec3;
  radius: number;
  tick: number;
  endTick: number;
  /** What went off (grenade, fuel rod, rocket, ...): the renderer colours the blast by it. */
  cause: string;
}

/** Obstacle box: axis-aligned in the local frame of its ring angle. */
export interface Box {
  id: number;
  type: 'box';
  kind: 'cover' | 'ramp' | 'wall' | 'lift' | 'struct';
  angle: number; // ring angle of the box centre
  tilt: number; // rotation about the axial direction (ramps): + tips the spinward end up
  center: Vec3;
  half: Vec3; // half extents along (spinward, up, axial) at `angle`
  /** Twin rings: which ring this box belongs to (its coordinates are in that ring's frame). */
  ring?: 0 | 1;
  /** Optional explicit orientation: the box's own x, y (its up) and z axes in world space (used on a planet). */
  axes?: [Vec3, Vec3, Vec3];
  /** Optional turn about the local up (radians): the box's length runs along cos(yaw) spinward + sin(yaw) axial. */
  yaw?: number;
  /** A lift: `center` moves `travel` m up from `base` and back, on a cycle of `period` s (a pure function of time). */
  lift?: { base: Vec3; travel: number; period: number; phase: number };
}

export interface SpawnPoint {
  angle: number;
  z: number;
  outer?: boolean; // planet with an outer shell: on the inside of the shell rather than on the ball
  floor?: number; // spin tower: the radius of the floor it's on (default: the end wall, R)
}

/** A launch pad: step on it and it throws you along `up` at `speed` (relative to the ground). */
export interface Pad {
  pos: Vec3; // centre, on the ground
  up: Vec3;
  speed: number;
  exact?: boolean; // throw at exactly up * speed (forgetting how you were moving), not just set the speed along up
}

/**
 * Level geometry. `shape` names the kind of world; the collision shape
 * (level.ts: levelSdf), the force field (physics.ts) and the renderer
 * (client/scene.ts) switch on it. Only the spinning 'ring' exists so far.
 */
export type LevelShape = 'ring' | 'planet' | 'disk' | 'tower';

/**
 * A spin tower's floor: a curved slab whose walking surface is at radius r (in both arms), reaching `w` either
 * side across (round the spin) and `d` either side along the axis, with openings (in the arm's own (across, along-axis) coordinates).
 */
export interface TowerFloor { r: number; thickness: number; w: number; d: number; holes: { y: number; z: number; hy: number; hz: number }[] }
/** A spin tower: two arms of floors stepping in toward the axis, the bottom (biggest) one first. */
export interface Tower {
  floors: TowerFloor[];
  /** Straight walls across the middle (planes at y = +-w, spinward and antispinward, |x| <= x, |z| <= d): near the axis the spin pulls you into them, so you walk on them. */
  walls?: { w: number; x: number; d: number };
}

/** A rectangular opening in a floor or deck, centred at (angle, z): halfArc metres along the ring (at radius R), halfZ across. */
export interface Hole {
  angle: number;
  z: number;
  halfArc: number;
  halfZ: number;
}

export interface Deck {
  r: number; // radius of the walking surface
  thickness: number;
  holes: Hole[];
}

/** A Gaussian hill on the floor. */
/** A team's home: where its players (re)spawn, and its flag stand (on the ground, for capture the flag). */
export interface TeamBase { team: number; pos: Vec3; spawns: SpawnPoint[] }

/** A Gaussian bump: peak height and spread (sigma, metres along the surface). */
export interface Bump { c: [number, number, number]; height: number; radius: number }

export interface Hill {
  angle: number; // ring angle of its peak
  z: number;
  height: number; // m
  radius: number; // m (Gaussian sigma)
}

export interface Level {
  shape: LevelShape;
  terrain: {
    sphere: boolean; hills: Hill[]; ridge?: { height: number; plateau: number };
    tube?: { kind: 'inside' | 'half' | 'outside'; radius: number };
  } | null; // null = flat cylinder floor
  /** Openings in the main floor (and hull): fall through into space. */
  holes?: Hole[];
  /** Glass strips in the floor (walkable; the renderer shows space through them): centre angle and half-width in metres. */
  windows?: { angle: number; halfArc: number }[];
  /** Upper decks: a thin floor at radius r (its walking surface), with openings. */
  decks?: Deck[];
  /** Launch pads. */
  pads?: Pad[];
  /** Team bases (with cfg.teams and cfg.teamBases): where each team spawns, and its flag stand. */
  bases?: TeamBase[];
  /** Spin tower geometry. */
  tower?: Tower;
  /** Hills and mountains on a planet (c: unit vector to the peak) or a disk (c: the peak's (x, y) on the disk): Gaussian bumps on the surface. */
  bumps?: Bump[];
  boxes: Box[];
  stairTops: Vec3[]; // a floor point on each staircase's lookout (add stand height to place a player)
  spawns: SpawnPoint[];
  pickupSpots: { pos: Vec3; item: ItemKind }[];
  vehicleSpots: { pos: Vec3; yaw: number }[];
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
  | { type: 'mount'; id: number; vehicle: number; on: boolean }
  | { type: 'vehicleHit'; id: number; damage: number; pos: Vec3 }
  | { type: 'vehicleDestroyed'; id: number; pos: Vec3 }
  | { type: 'supercombine'; id: number; pos: Vec3 }
  | { type: 'pad'; id: number; pos: Vec3 }
  | { type: 'melee'; id: number; target: number; pos: Vec3; mallet: boolean; from: Vec3; aim: Vec3; up: Vec3; reach: number; cone: number }
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
  vehicles: Vehicle[];
  events: SimEvent[]; // emitted during the most recent step
}
