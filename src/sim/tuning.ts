// ============================================================================
//  TUNING: every default number in the game lives here.
//
//  - defaultConfig(): world, physics, movement, grenades, explosions, items.
//  - defaultWeapons(): per-weapon stats (damage, speed, heat, ammo, ...).
//  - ENEMY_TYPES: campaign enemies (size, colour, health, weapon, behaviour).
//  Level layouts (ring sizes, enemy placements) are in levels.ts.
//
//  Everything here can also be changed live from the in-game debug panel
//  (pause with Esc). Values set there are not saved: edit this file to keep them.
//  Units: metres, seconds, m/s, m/s^2. Damage is in hit points (health 100,
//  shields 70 by default).
// ============================================================================

import type { SimConfig, WeaponId, WeaponStats } from './types';

export const defaultConfig = (): SimConfig => ({
  // --- the ring ---------------------------------------------------------------
  R: 100, // floor radius (m). Each level sets its own.
  g: 9.81, // apparent gravity at the floor (m/s^2); spin rate omega = sqrt(g / R)
  halfWidth: 20, // half the ring's width along its axis (m)
  spin: true, // false = no rotation at all (Earth level)
  world: 'ring', // 'planet' = stand on the outside of a spinning ball (radius R, surface gravity g)
  planetSpin: 0.4, // planet: the spin cancels this much of g at the equator
  outerShell: 0, // planet: radius of a hollow shell round it (0 = none)
  bannedItems: [], // pickups that never appear
  startWeapons: ['rifle', 'pistol'], // the loadout everyone (re)spawns with
  startSticky: 4,
  startBounce: 4,
  startJetpack: false,
  teams: 0, // 0 = free-for-all; 2-4 teams
  teamBases: false,
  ctf: false, // capture the flag (needs team bases)
  scoreLimit: 0, // first to this many points (or captures) wins; 0 = play on for ever
  timeLimit: 0, // seconds; 0 = no time limit
  flagReturnTime: 30, // teams: give each a base (spawns, flag stand) and make the pickups even
  tower: 0, // >0: a spin tower (its half-width round the spin) instead of a ring
  diskBowl: false, // disk world: curve the surface up into a paraboloid (gravity always straight into it)
  launchPads: true, // nested spheres: pads that throw you between ball and shell
  twin: false, // two counter-rotating rings side by side
  twinGap: 1.2, // the gap at the seam between them (m)
  arena: 0, // 0 = whole ring; >0 = a walled stretch this long (m), used by the Earth level
  terrainSphere: false, // true = the floor is a band round the inside of a sphere (bowl-shaped across)
  hills: 0, // number of rolling hills on the floor
  hillHeight: 8, // tallest hill (m)
  mountains: 0, // big, wide mountains (walkable slopes)
  mountainHeight: 120, // tallest mountain (m)
  bases: 0, // two-storey bases: a room with doorways, ramps up to a roof with cover
  ridgeHeight: 0, // a ridge along the middle, this high (m): the floor's cross-section becomes a Lambda
  ridgePlateau: 12, // how rounded its top is (m)
  tube: 'none', // 'inside' / 'half' / 'outside' a torus whose tube has radius tubeRadius
  tubeRadius: 20,
  floorHoles: 0, // holes in the floor you can fall out of
  floorTexture: 'auto', // 'auto' (deck plating; grass on hills), 'deck', 'grass', 'sand', 'snow' or 'rock'
  biomes: false, // with windows: a different biome on each land strip (grass, sand, snow, rock)
  windows: 0, // O'Neill-style glass strips along the ring (you can walk on them)
  spinChange: 0, // >0: every spinPeriod s the spin winds down by this fraction (1 = to a stop, 2 = right round to full speed backwards) and back
  spinPeriod: 120,
  comboHits: 6, // Seeker Swarm: this many hits on one target, each within comboWindow s of the last,
  comboWindow: 0.6, // ...set off a "supercombine" blast on them
  comboDamage: 90,
  comboRadius: 3,
  comboKnockback: 14,
  deckHeight: 0, // >0: an upper deck this high above the floor
  planetPull: 0, // m/s^2: pull toward a planet below, fixed to the stars (sweeps round once per spin)
  planetAngle: 0, // which way the planet is (radians about the axis, non-rotating frame)
  gravity: 0, // real gravity pulling toward the floor (m/s^2): 0 on rings, 9.81 on Earth
  wallHeight: 15, // tallest rim wall (m); capped at 40% of R
  wallThickness: 1.5,
  hullThickness: 3,

  // --- physics ----------------------------------------------------------------
  centrifugal: true, // debug: switch the fictitious forces off to compare
  coriolis: true,
  dragType: 'none', // 'none' | 'linear' | 'quadratic' (air at rest relative to the floor)
  dragCoeff: 0,
  restitution: 0.35, // bounciness of balls (0 = dead, 1 = perfectly elastic)
  friction: 0.5,

  // --- weapons & grenades -------------------------------------------------------
  weapons: defaultWeapons(), // see below
  allowHoverGun: false, // debug weapon; the debug panel turns this on
  muzzleGrenade: 16, // grenade throw speed relative to the thrower (m/s)
  projectileLifetime: 60, // max life of any bolt or grenade (s)
  grenadeFuse: 1.2, // sticky: seconds after it sticks
  bounceFuse: 2.5, // bouncing: seconds after the throw
  bounceRestitution: 0.6, // bouncing grenade bounciness
  grenadeMaxFlight: 12, // a sticky that never sticks goes off after this (s)

  // --- grenade explosions (the fuel rod has its own, in its weapon stats) --------
  explosionRadius: 6,
  explosionDamage: 110, // at point blank; falls off with distance
  knockbackSpeed: 20, // point-blank kick for an 80 kg player (m/s)
  knockbackScale: 1, // multiplies ALL explosion knockback
  knockbackFalloff: 'linear', // 'none' | 'linear' | 'quadratic'
  liftBias: 0.35, // extra push toward the axis ("up")
  selfDamageScale: 0.3, // your own explosions hurt you this much (grenade jumps!)

  // --- world edge -------------------------------------------------------------------
  fallKillDistance: 25, // fall this far off the ring and you're dead (m)

  // --- items --------------------------------------------------------------------------
  pickupRespawn: 25, // level pickups come back after (s)
  dropLifetime: 30, // items dropped on death last (s)
  jetThrust: 16, // jetpack thrust toward the axis (m/s^2); the floor pulls ~9.8
  jetLateral: 6, // jetpack steering from WASD (m/s^2)
  jetBurn: 0.25, // fraction of a full tank used per second (0.25 = 4 s of thrust)

  // --- players --------------------------------------------------------------------------
  walkSpeed: 9, // (m/s) with sprint toggled off
  sprintSpeed: 15, // (m/s) sprint is on by default
  jumpSpeed: 8, // jump kick (m/s); ~3 m high on the default ring
  groundAccel: 90, // how quickly you reach running speed (m/s^2)
  airAccel: 6, // air control (m/s^2), only up to walk speed
  coyoteTime: 0.12, // a jump still works this long after leaving a surface (s)
  impactDamageSpeed: 22, // hitting a surface faster than this hurts (m/s)
  impactDamagePerMs: 6, // damage per m/s above that
  slideDecel: 12, // braking when you land faster than you can run (m/s^2)
  maxHealth: 100,
  maxShield: 70,
  shieldRegenDelay: 4, // shields start recharging this long after a hit (s)
  shieldRegenRate: 35, // shield points per second
  respawnTime: 3, // (s) sandbox only; campaign has no respawns
  // --- hover-bikes (E to ride) -----------------------------------------------------
  vehicleMinRadius: 150, // only rings at least this big get bikes
  vehicleSpacing: 120, // one bike per this many metres of ring (max 60), plus one by each spawn point
  bikeHealth: 450,
  bikeThrust: 20, // m/s^2 (W/S)
  bikeStrafe: 8, // m/s^2 (A/D)
  bikeMaxSpeed: 40, // m/s: throttle stops adding speed beyond this (the spin can add more!)
  bikeDamping: 0.08, // /s: how fast rolling forward dies away while ridden
  bikeGrip: 3.5, // /s: how fast sliding sideways dies away (so it carves round corners)
  bikeHop: 7, // Space while riding (m/s)
  bikeHoverHeight: 1.1, // m from the bike's centre to the ground it floats over
  bikeHoverStiffness: 150, // spring (1/s^2) holding it there (stiff enough for Coriolis-heavy turns)...
  bikeHoverDamping: 20, // ...and its damping (1/s): soaks up bumps and landings
  bikeHoverReach: 2.4, // m: within this of the ground it hovers (and you can steer); further up it's flying
  bikeBounce: 0.4, // restitution off walls and boxes
  bikeCrashSpeed: 40, // only crashes into walls or boxes faster than this hurt the bike (landings never do)...
  bikeCrashDamage: 6, // ...this much per m/s above it
  // The rider never takes crash or landing damage: only the explosion if the bike is destroyed.
  bikeRamSpeed: 3, // running someone over faster than this hurts them...
  bikeRamDamage: 9, // ...this much per m/s of closing speed above it
  bikeRamThrow: 0.6, // and throws them along the bike's path (x closing speed)...
  bikeRamLift: 0.35, // ...and up (3 m/s + this x closing speed)
  bikeRespawn: 20, // s before a destroyed bike reappears at its spot
  bikeBlastRadius: 6, // when a bike blows up
  bikeBlastDamage: 70,
  bikeBlastKnockback: 18,
  meleeDamage: 40, // melee (Q): a hammer-like shove
  meleeKnockback: 18, // m/s kick: enough to knock someone off the ring
  meleeRange: 2.2, // m in front of you
  meleeCooldown: 0.8, // s
  friendlyFire: true, // campaign turns this off so enemies don't shoot each other
});

/** Fills in the fields a weapon doesn't use. */
const w = (o: Partial<WeaponStats>): WeaponStats => ({
  muzzle: 25, damage: 7, shieldDamage: 7, interval: 0.1, heatPerShot: 0, coolRate: 0.4, overheatLock: 2.5,
  radius: 0.12, lifetime: 60, ammoMax: 0, magSize: 0, reloadTime: 0, knockback: 0.5, chargeTime: 0, burstTime: 0,
  ocMuzzle: 0, ocDamage: 0, ocShieldDamage: 0, ocHeat: 0,
  blastRadius: 0, blastDamage: 0, blastKnockback: 0, chargeMoveScale: 1, chargeLookScale: 1,
  thrust: 0, burnTime: 0, turnRate: 0, seekRange: 0, seekAngle: 0, pellets: 1, spread: 0, muzzleMin: 0, ...o,
});

/**
 * Shot speeds are high enough that bolts barely curve at close range: over a
 * distance D a bolt at speed v sags about g D^2 / (2 v^2) and Coriolis bends
 * it up to omega D^2 / v. At 80 m/s that is ~0.1 m + 0.4 m over 10 m on the
 * standard ring; across the ring it still curves a lot.
 *
 * Weapon stats. Field meanings (see WeaponStats in types.ts):
 *   muzzle        bolt speed relative to the shooter (m/s)
 *   damage        health damage per hit; shieldDamage = damage to shields
 *   interval      seconds between shots
 *   heatPerShot   0..1 of the heat bar per shot (0 = never overheats; 1 = overheats every shot)
 *   coolRate      heat bar per second when not firing
 *   overheatLock  seconds you're locked out after overheating
 *   radius        bolt size (m), lifetime = how long a bolt lives (s)
 *   magSize       rounds per magazine; ammoMax = spare rounds you can carry (0 = no ammo, heat only)
 *   reloadTime    seconds to reload (R, or automatic when the magazine is empty)
 *   knockback     kick a hit gives an 80 kg player (m/s), along the bolt's path
 *   chargeTime    pistol overcharge / Laconic Laser charge time (s)
 *   burstTime     Laconic Laser: how long the stream lasts once charged (s)
 *   oc*           the pistol's overcharged shot
 *   blast*        explosion on impact (fuel rod)
 *   chargeMoveScale / chargeLookScale  Laconic Laser: movement and aim speed while charging and firing
 *   thrust, burnTime  rockets: constant push (m/s^2) along the rocket's nose for burnTime s. The nose
 *                 starts where you aim (not along the launch velocity) and keeps its direction
 *                 relative to the stars, so in the ring's frame it slowly turns against the spin.
 *   turnRate, seekRange, seekAngle  homing: how fast the nose can turn (rad/s) toward the nearest
 *                 enemy within seekRange and seekAngle degrees of the nose
 *   pellets, spread  scattergun: shots per pull, scattered within `spread` degrees of your aim
 *   muzzleMin     >0: every shot's speed is random between muzzleMin and muzzle
 */
export const defaultWeapons = (): Record<WeaponId, WeaponStats> => ({
  rifle: w({ muzzle: 80, damage: 7, shieldDamage: 7, interval: 0.075, heatPerShot: 0.045, coolRate: 0.45, overheatLock: 2.5,
    radius: 0.12, knockback: 0.6 }),
  // the overcharged shot (hold, release) is a little faster than a tap, and homes in a little (turnRate / seek*)
  pistol: w({ muzzle: 90, damage: 13, shieldDamage: 13, interval: 0.15, heatPerShot: 0.08, coolRate: 0.3, overheatLock: 2,
    radius: 0.15, knockback: 1.5, chargeTime: 0.9, ocMuzzle: 95, ocDamage: 20, ocShieldDamage: 120, ocHeat: 0.35,
    turnRate: 1.6, seekRange: 45, seekAngle: 25 }),
  // a normal gun, for comparison: tiny, very fast bullets barely curve at all
  revolver: w({ muzzle: 900, damage: 34, shieldDamage: 30, interval: 0.32, radius: 0.05, knockback: 1.5, lifetime: 1.5,
    magSize: 6, ammoMax: 36, reloadTime: 2.2 }),
  redRifle: w({ muzzle: 110, damage: 7, shieldDamage: 7, interval: 0.06, heatPerShot: 0.075, coolRate: 0.5, overheatLock: 3,
    radius: 0.1, knockback: 0.5 }),
  launcher: w({ muzzle: 45, damage: 30, shieldDamage: 30, interval: 0.6, radius: 0.3, knockback: 4,
    magSize: 3, ammoMax: 9, reloadTime: 2.2, blastRadius: 5, blastDamage: 100, blastKnockback: 22 }),
  // "sniper": one hard, fast, magenta bolt, then it overheats briefly
  cannon: w({ muzzle: 200, damage: 75, shieldDamage: 75, interval: 0.2, heatPerShot: 1, coolRate: 1.5, overheatLock: 1.1,
    radius: 0.28, knockback: 7 }),
  // superweapon: charge, then a half-second stream of very fast red bolts
  laconic: w({ muzzle: 3000, damage: 17, shieldDamage: 17, interval: 1 / 30, heatPerShot: 1 / 15, coolRate: 0.5,
    overheatLock: 3, radius: 0.22, lifetime: 1, knockback: 0.6, chargeTime: 1.2, burstTime: 0.5,
    chargeMoveScale: 0.25, chargeLookScale: 0.25 }),
  // melee weapon: a big swing that hits everyone in front of you (reach = blastRadius)
  hammer: w({ muzzle: 0, damage: 90, shieldDamage: 90, interval: 0.9, knockback: 28, blastRadius: 3.2, radius: 0 }),
  // a real rocket: leaves fairly slowly, then pushes itself along its nose for 1.5 s
  rocket: w({ muzzle: 20, damage: 40, shieldDamage: 40, interval: 0.7, radius: 0.22, knockback: 4, lifetime: 8,
    magSize: 2, ammoMax: 8, reloadTime: 2.5, thrust: 70, burnTime: 1.5, blastRadius: 5, blastDamage: 110, blastKnockback: 20 }),
  // a stream of little homing rockets: each steers its nose at the nearest enemy in front of it
  // the motor only burns briefly, and it steers without knowing about the spin: aim it properly
  seeker: w({ muzzle: 20, damage: 9, shieldDamage: 12, interval: 0.13, radius: 0.12, knockback: 0.8, lifetime: 5,
    magSize: 16, ammoMax: 48, reloadTime: 2.2, thrust: 40, burnTime: 0.8, turnRate: 3, seekRange: 40, seekAngle: 20,
    blastRadius: 1.2, blastDamage: 6, blastKnockback: 1.5 }),
  // a spray of slow pellets: brutal up close; further out the spin pulls the spray apart
  scatter: w({ muzzle: 55, damage: 8, shieldDamage: 9, interval: 0.75, radius: 0.08, knockback: 0.7, lifetime: 1.5,
    magSize: 6, ammoMax: 24, reloadTime: 2.4, pellets: 10, spread: 7 }),
  // novelty: fast fire, but every shot leaves at a random speed (coloured by it), so each one curves differently
  chaos: w({ muzzle: 220, muzzleMin: 15, damage: 6, shieldDamage: 6, interval: 0.06, heatPerShot: 0.035, coolRate: 0.45,
    overheatLock: 2.5, radius: 0.11, knockback: 0.4, spread: 0.6 }),
  // the flag, held: swing it like the mallet, but it's only a flag
  flag: w({ muzzle: 0, damage: 22, shieldDamage: 22, interval: 0.7, knockback: 9, blastRadius: 2.6, radius: 0 }),
  hover: w({ muzzle: 0, damage: 10, shieldDamage: 10, interval: 0.125, radius: 0.25, knockback: 1 }),
});

// ---------------------------------------------------------------- enemies

export type Behaviour =
  | 'chase' // runs at you until in range, then strafes
  | 'strafe' // keeps its distance, side-steps a lot
  | 'hold'; // stays where it was placed (snipers on stairs)

export interface EnemyType {
  name: string;
  color: number; // body colour (hex)
  size: number; // 1 = player-sized; scales the collision capsule too
  health: number;
  shield: number;
  speedScale: number; // multiplies run speed
  weapon: WeaponId; // its only weapon (dropped when it dies, if not a starting one); infinite spare ammo
  grenades: number; // sticky
  bounceGrenades: number;
  behaviour: Behaviour;
  range: number; // engages you within this distance (m)
  aimError: number; // random aim wobble (radians)
  aimSkill: number; // 0 = aims straight at you; 1 = leads you and corrects for the spin (simulates its own shot)
}

export const ENEMY_TYPES: Record<string, EnemyType> = {
  grunt: {
    name: 'Grunt', color: 0xe08a2a, size: 0.75, health: 45, shield: 0, speedScale: 0.6, weapon: 'pistol',
    grenades: 1, bounceGrenades: 0, behaviour: 'chase', range: 30, aimError: 0.12, aimSkill: 0,
  },
  soldier: {
    name: 'Soldier', color: 0x8a3ad0, size: 1, health: 100, shield: 70, speedScale: 0.8, weapon: 'rifle',
    grenades: 1, bounceGrenades: 1, behaviour: 'strafe', range: 40, aimError: 0.06, aimSkill: 0.6,
  },
  swarmer: {
    name: 'Swarmer', color: 0xff6ad8, size: 0.9, health: 80, shield: 50, speedScale: 0.9, weapon: 'seeker',
    grenades: 0, bounceGrenades: 1, behaviour: 'strafe', range: 45, aimError: 0.08, aimSkill: 0,
  },
  skirmisher: {
    name: 'Skirmisher', color: 0xd03a3a, size: 0.9, health: 70, shield: 40, speedScale: 1.2, weapon: 'redRifle',
    grenades: 0, bounceGrenades: 2, behaviour: 'chase', range: 35, aimError: 0.08, aimSkill: 0.5,
  },
  heavy: {
    name: 'Heavy', color: 0xe8e6dc, size: 1.5, health: 250, shield: 100, speedScale: 0.45, weapon: 'launcher',
    grenades: 0, bounceGrenades: 0, behaviour: 'chase', range: 45, aimError: 0.05, aimSkill: 0.85,
  },
  // a crack shot with a plain revolver: slow, deliberate, deadly at range
  gunslinger: {
    name: 'Gunslinger', color: 0xf0c830, size: 0.95, health: 80, shield: 40, speedScale: 0.9, weapon: 'revolver',
    grenades: 0, bounceGrenades: 1, behaviour: 'strafe', range: 60, aimError: 0.03, aimSkill: 0.9,
  },
  // charges you with a Grav Mallet
  brute: {
    name: 'Brute', color: 0x26282e, size: 1.25, health: 160, shield: 60, speedScale: 1.1, weapon: 'hammer',
    grenades: 0, bounceGrenades: 0, behaviour: 'chase', range: 40, aimError: 0.05, aimSkill: 0,
  },
  // fires Torch Rockets
  rocketeer: {
    name: 'Rocketeer', color: 0x2a4ab0, size: 1.05, health: 100, shield: 60, speedScale: 0.7, weapon: 'rocket',
    grenades: 1, bounceGrenades: 0, behaviour: 'strafe', range: 55, aimError: 0.05, aimSkill: 0,
  },
  sniper: {
    name: 'Sniper', color: 0x3ad0d0, size: 0.95, health: 60, shield: 30, speedScale: 0, weapon: 'cannon',
    grenades: 0, bounceGrenades: 0, behaviour: 'hold', range: 90, aimError: 0.015, aimSkill: 1,
  },
};
