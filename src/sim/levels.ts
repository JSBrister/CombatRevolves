// ============================================================================
//  LEVELS: every playable level, campaign and sandbox.
//
//  A level is a ring (its size and any config overrides), a fixed seed (so
//  the cover, staircases, walls and pickups are always laid out the same),
//  where you start, and either a fixed set of enemies (campaign) or a number
//  of free-for-all bots (sandbox). Enemy types are defined in tuning.ts.
//
//  Placement: `angle` is degrees around the ring from your start, positive =
//  spinward; `z` is metres across the ring (the floor spans about -20..20);
//  `stair: n` puts the enemy on staircase n's lookout instead.
// ============================================================================

import { localBasis } from './physics';
import { spawnPosition } from './level';
import { ENEMY_TYPES, defaultConfig } from './tuning';
import { WEAPON_IDS, type GameMode, type ItemKind, type SimConfig, type SimState, type WeaponId } from './types';
import { type Vec3, addScaled } from './vec';
import { addPlayer, createState, freeSpotNear, standHeight } from './world';
import { TEAM_COLORS, TEAM_NAMES } from './teams';

export interface EnemySpawn {
  type: keyof typeof ENEMY_TYPES;
  angle?: number; // degrees from the player start, + = spinward
  along?: number; // or metres along the floor from the start (handy on Earth, where a degree is 1.7 km)
  z?: number; // metres across the ring
  stair?: number; // or: stand on this staircase's lookout
  deck?: boolean; // stand on the upper deck (at angle/along, z) instead of the floor
  outer?: boolean; // nested spheres: on the inside of the shell (z = metres north of its equator)
}

export interface LevelDef {
  id: string;
  name: string;
  blurb: string;
  mode: GameMode;
  config: Partial<SimConfig>; // at least R; anything in tuning.ts can be overridden per level
  seed: number; // fixes the layout
  variedWalls?: boolean; // default true (low curbs you can fall off)
  props?: boolean; // default true (the bouncy balls)
  pickups?: boolean; // default true
  bots?: number; // sandbox: free-for-all bots
  vehicles?: number; // hover-bikes (default: by ring size)
  start?: { angle: number; z: number }; // degrees, metres (default 0, 0)
  sky?: 'space' | 'earth'; // what the client draws around the level (default space)
  enemies?: EnemySpawn[]; // campaign
  /**
   * Which pickups this level offers (the generated spots get these, in turn);
   * [] = none. Default: whatever the layout generates. Enemies' weapons drop
   * when they die whatever this says.
   */
  items?: ItemKind[];
  /** Tips shown one after another at the start (seconds from the start, text). */
  tips?: { at: number; text: string }[];
}

/**
 * Earth: a "ring" 100 km in radius that doesn't spin, with real 1 g gravity
 * toward the floor. Over the 120 m arena the floor curves by about 2 cm, so
 * it's flat ground: the reference for what everything "should" do.
 */
const EARTH: Partial<SimConfig> = { R: 100000, spin: false, gravity: 9.81, arena: 300, halfWidth: 90, wallHeight: 5 };

export const LEVELS: LevelDef[] = [
  // ------------------------------------------------------------ campaign
  // The first level teaches what the game is about; the rest are for fun, each
  // with its own gimmick. Pickups are chosen per level (enemies drop their guns).
  {
    id: 'c1', mode: 'campaign', name: 'Basic Training', seed: 101,
    blurb: 'A standard 100 m ring and a few grunts. Learn how a spinning world bends your shots, your jumps and your grenades.',
    config: { R: 100 },
    items: ['health', 'revolver', 'sticky', 'health', 'bounce'],
    tips: [
      { at: 0.5, text: 'This ring spins. "Down" is outward, so the floor curves UP ahead of you and behind.' },
      { at: 8, text: 'Hold RIGHT MOUSE to see where a shot will really go: shots curve (Coriolis). Spinward ones dip; antispinward ones climb.' },
      { at: 17, text: 'Run against the spin (away from the arrow at the top) and you weigh less: jump! Run with it and you weigh more.' },
      { at: 26, text: 'Grenades curve too: hold G (sticky) or F (bouncing) to aim, release to throw.' },
      { at: 35, text: 'There is a revolver lying about: a normal, very fast gun. See how little its bullets curve compared with plasma.' },
      { at: 44, text: 'Kill every enemy to clear the level. Up close, Q is a shove.' },
    ],
    enemies: [
      { type: 'grunt', angle: 20, z: -6 }, { type: 'grunt', angle: 24, z: 6 },
      { type: 'grunt', angle: -25, z: 0 }, { type: 'grunt', angle: 60, z: 10 },
      { type: 'soldier', angle: 90, z: -4 },
    ],
  },
  {
    id: 'c2', mode: 'campaign', name: 'Tight Spin', seed: 202,
    blurb: 'A 40 m ring that turns every 12.7 s. Everything curves hard, including you. Close quarters: grab the scattergun.',
    config: { R: 40 },
    items: ['scatter', 'health', 'bounce'],
    enemies: [
      { type: 'grunt', angle: 45, z: -8 }, { type: 'grunt', angle: 90, z: 8 }, { type: 'grunt', angle: 180, z: 0 },
      { type: 'grunt', angle: 270, z: -8 }, { type: 'skirmisher', angle: 135, z: 0 }, { type: 'brute', angle: 220, z: 4 },
    ],
  },
  {
    id: 'c3', mode: 'campaign', name: 'Overwatch', seed: 303,
    blurb: 'A 150 m ring. Snipers hold two lookouts; a gunslinger and soldiers patrol below. A jetpack helps you get up there.',
    config: { R: 150 },
    items: ['health', 'jetpack', 'sticky', 'health'],
    enemies: [
      { type: 'sniper', stair: 0 }, { type: 'sniper', stair: 1 },
      { type: 'soldier', angle: 25, z: 8 }, { type: 'gunslinger', angle: 50, z: -8 }, { type: 'soldier', angle: -40, z: 0 },
    ],
  },
  {
    id: 'c4', mode: 'campaign', name: 'Heavy Rotation', seed: 404,
    blurb: 'A 60 m ring with two fuel-rod heavies. Their blasts will knock you clean off the edge. Take their launchers.',
    config: { R: 60 },
    items: ['health', 'sticky', 'bounce'],
    enemies: [
      { type: 'heavy', angle: 90, z: -5 }, { type: 'heavy', angle: 200, z: 5 },
      { type: 'soldier', angle: 45, z: 8 }, { type: 'skirmisher', angle: 140, z: -8 },
    ],
  },
  {
    id: 'c6', mode: 'campaign', name: 'Hill Country', seed: 606,
    blurb: 'A 200 m ring of rolling hills, 100 m wide. Hold the high ground; mind the grenades rolling down it.',
    config: { R: 200, halfWidth: 50, hills: 26, hillHeight: 9 },
    items: ['health', 'bounce', 'cannon', 'sticky'],
    enemies: [
      { type: 'soldier', along: 40, z: -15 }, { type: 'soldier', along: 55, z: 20 }, { type: 'grunt', along: 35, z: 5 },
      { type: 'grunt', along: 38, z: -5 }, { type: 'heavy', along: 90, z: 0 }, { type: 'skirmisher', along: -45, z: 10 },
      { type: 'sniper', stair: 1 },
    ],
  },
  {
    id: 'c10', mode: 'campaign', name: 'Roadkill', seed: 1010,
    blurb: 'A wide 300 m ring of bases, with hover-bikes parked about. Bikes shrug off crashes; pedestrians do not.',
    config: { R: 300, halfWidth: 50, bases: 3, hills: 8, hillHeight: 5 }, vehicles: 10,
    items: ['health', 'rocket', 'revolver', 'health'],
    tips: [{ at: 1, text: 'E gets on a hover-bike (W to go, Space to hop). Running enemies over is very effective.' }],
    enemies: [
      { type: 'grunt', along: 50, z: -10 }, { type: 'grunt', along: 55, z: 12 }, { type: 'soldier', along: 90, z: 0 },
      { type: 'rocketeer', along: 140, z: -15 }, { type: 'grunt', along: -60, z: 8 }, { type: 'soldier', along: -100, z: -12 },
      { type: 'gunslinger', along: 200, z: 20 }, { type: 'heavy', along: 260, z: 0 },
    ],
  },
  {
    id: 'c7', mode: 'campaign', name: 'Double Trouble', seed: 707,
    blurb: 'A ring with an upper deck. Swarmers up top fire homing seekers; get under the deck, or up the lifts and ramps and in close.',
    config: { R: 150, halfWidth: 25, deckHeight: 10 }, vehicles: 0,
    items: ['health', 'scatter', 'sticky', 'rocket'],
    enemies: [
      { type: 'grunt', along: 30, z: -6 }, { type: 'grunt', along: 34, z: 6 }, { type: 'soldier', along: 60, z: 0 },
      { type: 'swarmer', along: 45, z: 5, deck: true }, { type: 'swarmer', along: -50, z: -5, deck: true },
      { type: 'heavy', along: 110, z: 0 }, { type: 'skirmisher', along: -35, z: 8 },
    ],
  },
  {
    id: 'c8', mode: 'campaign', name: 'Log Jam', seed: 808,
    blurb: 'Fighting on the outside of a spinning tube, 28 m across. Every hit knocks someone toward the edge, including you.',
    config: { R: 100, halfWidth: 14, tube: 'outside', tubeRadius: 14 },
    items: ['bounce', 'health', 'hammer'],
    tips: [{ at: 1, text: 'Bouncing grenades and the Grav Mallet knock people off the log. So does everything else, to you.' }],
    enemies: [
      { type: 'grunt', along: 25, z: 0 }, { type: 'grunt', along: 28, z: 2 }, { type: 'skirmisher', along: -30, z: -2 },
      { type: 'soldier', along: 55, z: 0 }, { type: 'brute', along: -60, z: 0 }, { type: 'heavy', along: 100, z: 0 },
    ],
  },
  {
    id: 'c11', mode: 'campaign', name: 'Tube Fight', seed: 1111,
    blurb: 'Inside a 30 m tube: the floor curves up into the ceiling. Brutes with Grav Mallets come at you round the walls.',
    config: { R: 120, halfWidth: 15, tube: 'inside', tubeRadius: 15 },
    items: ['hammer', 'scatter', 'health', 'bounce'],
    enemies: [
      { type: 'brute', along: 30, z: 0 }, { type: 'grunt', along: 35, z: 4 }, { type: 'grunt', along: 38, z: -4 },
      { type: 'brute', along: -40, z: 2 }, { type: 'skirmisher', along: 70, z: 0 }, { type: 'brute', along: 110, z: -2 },
      { type: 'soldier', along: -90, z: 0 },
    ],
  },
  {
    id: 'c9', mode: 'campaign', name: 'Power Cut', seed: 909,
    blurb: 'The spin motors keep failing: every 60 s the ring winds down to a fifth of its spin, then back up. Low g is coming; so is the Euler shove.',
    config: { R: 120, spinChange: 0.8, spinPeriod: 60 },
    items: ['health', 'jetpack', 'launcher', 'sticky'],
    tips: [{ at: 1, text: 'Watch the spin readout (top left). When it winds down you weigh almost nothing: jump and float.' }],
    enemies: [
      { type: 'grunt', along: 25, z: -5 }, { type: 'grunt', along: 28, z: 5 }, { type: 'soldier', along: 45, z: 0 },
      { type: 'skirmisher', along: -35, z: 6 }, { type: 'swarmer', along: 70, z: -4 }, { type: 'heavy', along: 100, z: 0 },
      { type: 'sniper', stair: 0 },
    ],
  },
  {
    id: 'c12', mode: 'campaign', name: 'Planetfall', seed: 1212,
    blurb: 'A 150 m planet with full gravity, spinning fast. Gunslingers and rocketeers are spread round it; the horizon is very close.',
    config: { world: 'planet', R: 150, g: 9.81, planetSpin: 0.4 }, props: false,
    items: ['health', 'rocket', 'cannon', 'chaos', 'sticky', 'health'],
    tips: [{ at: 1, text: 'The ground moves east at 24 m/s and orbit is 38 m/s: throw a grenade hard east and it comes back round.' }],
    enemies: [
      { type: 'grunt', along: 30, z: 5 }, { type: 'grunt', along: 34, z: -5 }, { type: 'gunslinger', along: 70, z: 20 },
      { type: 'rocketeer', along: -60, z: -10 }, { type: 'soldier', along: 150, z: 30 }, { type: 'gunslinger', along: 300, z: -40 },
      { type: 'rocketeer', along: 470, z: 10 }, { type: 'heavy', along: 600, z: 0 },
    ],
  },
  {
    id: 'c13', mode: 'campaign', name: 'Counter-Spin', seed: 1313,
    blurb: 'Two rings spinning opposite ways. Their snipers and gunslingers are on the other one, whose floor goes past at 49 m/s.',
    config: { R: 60, halfWidth: 30, twin: true }, variedWalls: false,
    items: ['health', 'revolver', 'cannon', 'health'],
    tips: [
      { at: 1, text: 'Shots that cross the seam swerve: in the other ring\'s frame they are moving sideways at 49 m/s.' },
      { at: 10, text: 'You can cross over too, but its floor will grab you at 49 m/s. Mind the gap: it is a long way down.' },
    ],
    enemies: [
      { type: 'grunt', along: 20, z: -12 }, { type: 'grunt', along: -25, z: -18 },
      { type: 'sniper', along: 60, z: 18 }, { type: 'gunslinger', along: 120, z: 12 }, { type: 'sniper', along: 220, z: 20 },
      { type: 'soldier', along: 170, z: 14 }, { type: 'skirmisher', along: 290, z: 16 },
    ],
  },
  {
    id: 'c14', mode: 'campaign', name: 'Inside Out', seed: 1414,
    blurb: 'A dense ball inside a spinning shell. Swarmers walk the inside of the shell above you; the green pads throw you up to them.',
    config: { world: 'planet', R: 60, g: 9.81, planetSpin: 0.3, outerShell: 120 }, props: false,
    items: ['health', 'seeker', 'bounce', 'revolver'],
    tips: [{ at: 1, text: 'Green pads throw you across to the shell. Up there the spin holds you on, but only near its equator: past the orange rings you fall back down.' }],
    enemies: [
      { type: 'grunt', along: 25, z: 5 }, { type: 'grunt', along: -30, z: -5 }, { type: 'soldier', along: 80, z: 10 },
      { type: 'swarmer', along: 60, z: 5, outer: true }, { type: 'swarmer', along: 260, z: -8, outer: true },
      { type: 'rocketeer', along: 450, z: 0, outer: true }, { type: 'brute', along: 150, z: -15 },
    ],
  },
  {
    id: 'c0', mode: 'campaign', name: 'Shore Leave (Earth)', seed: 11, sky: 'earth', variedWalls: false,
    blurb: 'Back on Earth: flat ground, normal gravity, no spin. Everything you learned up there is now subtly wrong.',
    config: { ...EARTH },
    start: { angle: 0, z: 0 },
    items: ['health', 'revolver', 'rocket'],
    enemies: [
      { type: 'grunt', along: 25, z: -10 }, { type: 'grunt', along: 35, z: 8 }, { type: 'grunt', along: 45, z: 0 },
      { type: 'gunslinger', along: 90, z: 20 }, { type: 'rocketeer', along: 120, z: -20 },
    ],
  },
  // ------------------------------------------------------------ sandbox
  { id: 's-standard', mode: 'sandbox', name: 'Standard ring (100 m)', seed: 1234, config: { R: 100 }, bots: 3,
    blurb: '1 g at the floor, a 20 s spin, 31 m/s rim speed. Three bots.' },
  { id: 's-tiny', mode: 'sandbox', name: 'Tiny ring (12 m)', seed: 11, config: { R: 12 }, bots: 1,
    blurb: 'Spins every 7 s. Sprint antispinward faster than the rim and you float.' },
  { id: 's-small', mode: 'sandbox', name: 'Small ring (40 m)', seed: 12, config: { R: 40 }, bots: 2,
    blurb: 'A 12.7 s spin. Strong Coriolis: grenades curve visibly.' },
  { id: 's-large', mode: 'sandbox', name: 'Large ring (500 m)', seed: 13, config: { R: 500, bases: 4 }, bots: 4,
    blurb: 'A 45 s spin and 70 m/s rim speed. Feels almost like home.' },
  { id: 's-huge', mode: 'sandbox', name: 'Huge ring (2000 m)', seed: 14, config: { R: 2000, bases: 8, mountains: 8, mountainHeight: 60, halfWidth: 120 }, bots: 4,
    blurb: '12.6 km around. The far side is a thin line in the sky.' },
  { id: 's-hills', mode: 'sandbox', name: 'Rolling Hills (200 m)', seed: 31, config: { R: 200, halfWidth: 50, hills: 30, hillHeight: 10 }, bots: 3,
    blurb: 'A wide ring of grassy hills. Balls and bouncing grenades roll downhill, and "downhill" changes as you run.' },
  { id: 's-bowl', mode: 'sandbox', name: 'Bowl World (sphere band)', seed: 32, config: { R: 80, halfWidth: 55, terrainSphere: true, wallHeight: 3 },
    variedWalls: false, bots: 2,
    blurb: 'A band round the inside of a spinning sphere, out to 43 degrees latitude. The edges are hills you climb in weaker gravity (g cos^2 of your latitude).' },
  { id: 's-sphere', mode: 'sandbox', name: 'Inside a Sphere (160 m)', seed: 35, config: { R: 160, halfWidth: 159, terrainSphere: true, wallHeight: 64 },
    variedWalls: false, bots: 3,
    blurb: 'The whole inside of a spinning sphere. Gravity is g cos^2 of your latitude; past ~53 degrees the floor is too steep to stand on, and at the poles you float. Jetpacks and bikes recommended.' },
  { id: 's-ridge', mode: 'sandbox', name: 'The Ridge (Lambda)', seed: 36, config: { R: 240, halfWidth: 150, ridgeHeight: 120, ridgePlateau: 12 }, bots: 4,
    blurb: 'A 120 m ridge runs round the middle of a 240 m ring: the floor is a Lambda in cross-section. Gravity on the crest is half what it is at the foot, and the slopes are 40 degrees.' },
  { id: 's-oneill-small', mode: 'sandbox', name: "Little O'Neill (three biomes)", seed: 47,
    config: { R: 250, halfWidth: 350, windows: 3, biomes: true, hills: 30, hillHeight: 7, mountains: 6, mountainHeight: 40, bases: 4, wallHeight: 1000 }, bots: 6,
    blurb: "A pocket O'Neill cylinder: three land strips (meadow, desert and snowy mountains) between three glass windows, with bases to fight over. 32 s per turn." },
  { id: 's-oneill', mode: 'sandbox', name: "O'Neill Cylinder (1 km x 3 km)", seed: 37, config: { R: 1000, halfWidth: 1500, hills: 50, hillHeight: 20, mountains: 16, mountainHeight: 170, bases: 12, wallHeight: 1000, windows: 3 },
    variedWalls: false, bots: 6,
    blurb: 'A proper space colony: 2 km across, 3 km long, a minute per turn. Mountains, bases and three strips of land alternating with three glass windows you can walk on, space under your feet. Take a bike.' },
  { id: 's-swiss', mode: 'sandbox', name: 'Swiss Cheese (holes in the floor)', seed: 38, config: { R: 120, floorHoles: 18 }, bots: 3,
    blurb: 'Somebody forgot the floor plates. Fall through a hole and the spin flings you out into space; so does a good blast.' },
  { id: 's-decks', mode: 'sandbox', name: 'Double Decker (two levels)', seed: 39, config: { R: 150, halfWidth: 25, deckHeight: 10 }, bots: 4,
    blurb: 'A second deck 10 m up, with ramps through slots in it. Up top you weigh 93%; underneath it is a long, low tunnel.' },
  { id: 's-torus', mode: 'sandbox', name: 'Stanford Torus (inside a tube)', seed: 40, config: { R: 150, halfWidth: 20, tube: 'inside', tubeRadius: 20 }, bots: 3,
    blurb: 'The ring is a 40 m tube: the floor curves up on both sides into the ceiling. Run up the walls, and watch the bolts.' },
  { id: 's-halfpipe', mode: 'sandbox', name: 'Half-Pipe (half a torus)', seed: 41, config: { R: 120, halfWidth: 25, tube: 'half', tubeRadius: 25, wallHeight: 3 }, bots: 3,
    blurb: 'Half a torus, open toward the axis. Skate up the sides; over the lip there is nothing at all.' },
  { id: 's-log', mode: 'sandbox', name: 'The Log (outside a torus)', seed: 42, config: { R: 100, halfWidth: 14, tube: 'outside', tubeRadius: 14 }, bots: 2,
    blurb: 'You stand on the OUTSIDE of a spinning tube, on the side facing the axis. Stray too far either way and you slide off into space.' },
  { id: 's-spincycle', mode: 'sandbox', name: 'Spin Cycle (spin stops and starts)', seed: 43, config: { R: 100, spinChange: 1, spinPeriod: 90 }, bots: 3,
    blurb: 'Every 90 s the ring spins down to a dead stop, floats weightless for 13 s, then spins back up. While it changes, the Euler force pushes everything along the floor.' },
  { id: 's-outposts', mode: 'sandbox', name: 'Outposts (bases and mountains)', seed: 44, config: { R: 300, halfWidth: 80, bases: 6, mountains: 5, mountainHeight: 45, hills: 12, hillHeight: 6 }, bots: 5,
    blurb: 'Six grey two-storey bases between the mountains: doorways into the lower rooms, ramps up to roofs with low walls to hide behind.' },
  { id: 's-world', mode: 'sandbox', name: 'Dense Planet (outside a spinning ball)', seed: 45, config: { world: 'planet', R: 150, g: 9.81, planetSpin: 0.4 }, props: false, bots: 4,
    blurb: 'A 150 m ball with full gravity, spinning fast: you weigh 60% at the equator and 100% at the poles. Orbit is 38 m/s; throw a grenade east hard enough and it comes back round behind you.' },
  { id: 's-twin', mode: 'sandbox', name: 'Twin Rings (counter-rotating)', seed: 46, config: { R: 60, halfWidth: 30, twin: true }, variedWalls: false, bots: 4,
    blurb: 'Two rings side by side spinning opposite ways. The other ring\'s floor goes past at 49 m/s: shots across the seam swerve, and stepping over is a ride. Near the axis the speeds match.' },
  { id: 's-spheres', mode: 'sandbox', name: 'Nested Spheres (ball inside a shell)', seed: 48, config: { world: 'planet', R: 60, g: 9.81, planetSpin: 0.3, outerShell: 120 }, props: false, bots: 4,
    blurb: 'A dense ball inside a spinning shell. On the ball, gravity wins: 1 g at the poles, 0.7 g at its equator. On the inside of the shell, the spin wins near its equator (0.35 g, outward). Halfway up you weigh nothing. Launch pads throw you across.' },
  { id: 's-twin-bikes', mode: 'sandbox', name: 'Counter-Spin Raceway (twin rings, bikes)', seed: 49,
    config: { R: 150, g: 4, halfWidth: 40, twin: true }, variedWalls: false, vehicles: 16, bots: 3,
    blurb: 'Two 150 m rings at 0.4 g spinning opposite ways: the other floor goes by at 49 m/s, just under a boosted bike\'s top speed. Ride against the spin flat out, hop the seam, and land gently on the other ring.' },
  { id: 's-reversal', mode: 'sandbox', name: 'Reversal (the spin turns round)', seed: 50, config: { R: 100, spinChange: 2, spinPeriod: 80 }, bots: 3,
    blurb: 'Every 80 s the ring winds down through a dead stop to full speed BACKWARDS, holds, and comes back. Spinward becomes antispinward, and the Euler force shoves everything along the floor while it changes.' },
  { id: 's-tides', mode: 'sandbox', name: 'Tidal Spheres (nested, cycling spin)', seed: 51,
    config: { world: 'planet', R: 60, g: 9.81, planetSpin: 2, outerShell: 75, launchPads: false, spinChange: 0.92, spinPeriod: 60 }, props: false, bots: 4,
    blurb: 'A ball inside a shell, and the spin comes and goes. Spun up, only the ball\'s poles hold you; everyone else is flung up to the shell. Spun down, the shell lets go and everyone falls back to the ball.' },
  { id: 's-disk', mode: 'sandbox', name: 'Disk World (flat)', seed: 52, config: { world: 'disk', R: 100, g: 9.81, planetSpin: 1.6 }, props: false, bots: 4,
    blurb: 'On top of a spinning disk, with gravity straight down. The further out you go, the more the spin tilts "down" toward the edge: past about 83 m the floor is too steep to stand on, and you slide off into space.' },
  { id: 's-bucket', mode: 'sandbox', name: 'Spinning Bucket (Disk World, curved)', seed: 53, config: { world: 'disk', R: 100, g: 9.81, planetSpin: 1.6, diskBowl: true }, props: false, bots: 4,
    blurb: 'The same spinning disk, curved up into the shape water takes in a spinning bucket, so gravity is always straight into the ground. Walk right up the 80 m-high rim, where you weigh 1.9 g; just don\'t go over it.' },
  { id: 's-rough', mode: 'sandbox', name: 'Rough Planet (hills and mountains)', seed: 55, config: { world: 'planet', R: 120, g: 9.81, planetSpin: 0.3, hills: 50, hillHeight: 8, mountains: 5, mountainHeight: 35 }, props: false, bots: 4,
    blurb: 'A bigger ball with hills and a few mountains on it: high ground to fight over, and from the tops you can see a long way round.' },
  { id: 's-wheel', mode: 'sandbox', name: 'Wheel Station (ring, spokes and hub)', seed: 56, config: { R: 120, halfWidth: 14, wheelHub: 12 }, bots: 4, items: undefined,
    blurb: 'The classic: a ring with four spokes up to a hub round the axis. Two spokes have lifts, two have ledges to jump up (further apart as you get lighter). In the hub you walk round the inside of the drum at a tenth of a g, and the best pickups are up there.' },
  { id: 's-half', mode: 'sandbox', name: 'Half Ring (sealed at both ends)', seed: 57, config: { R: 100, halfWidth: 20, arena: Math.PI * 100 }, bots: 4,
    blurb: 'Half a ring, with bulkheads at both ends. Made for Spin Control (the teams start at the ends, the engine room is in the middle), and fine for a deathmatch: shots fired one way along it curve down and speed up, the other way they float up and slow down.' },
  { id: 's-tower', mode: 'sandbox', name: 'Spin Tower', seed: 54, config: { R: 100, g: 14.7, tower: 10 }, props: false, vehicles: 0, bots: 4,
    blurb: 'Not a ring: a tower through the axis, spinning end over end, open to the stars. You start on the big bottom floor of one arm under 1.5 g and climb ramps, floor by floor, each one smaller, to the hub at the middle, where you weigh almost nothing. Launch pads there throw you across to the other arm. Don\'t fall off the edge.' },
  { id: 's-wide', mode: 'sandbox', name: 'Wide Ring (150 m)', seed: 33, config: { R: 150, halfWidth: 70 }, bots: 4,
    blurb: '140 m across: room to flank, and to watch your shots curve sideways.' },
  { id: 's-planet', mode: 'sandbox', name: 'Skyhook (planet below)', seed: 34, config: { R: 100, planetPull: 8.8, planetAngle: Math.PI }, bots: 2,
    blurb: 'The ring turns on an axle held up by a tower from the planet below, and the planet pulls at 0.9 g. As the ring turns you go from 1.9 g to almost weightless, and the floor seems to tilt.' },
  { id: 's-hazy', mode: 'sandbox', name: 'Hazy ring (atmosphere)', seed: 16, config: { R: 100, dragType: 'quadratic', dragCoeff: 0.004 }, bots: 2,
    blurb: 'The one ring with air. Bolts slow down and droop, grenades fall short, jetpacks hit a terminal speed.' },
  { id: 's-empty', mode: 'sandbox', name: 'Empty ring (100 m)', seed: 15, config: { R: 100 }, bots: 0,
    blurb: 'No bots, no clutter: a physics playground.' },
  { id: 's-earth', mode: 'sandbox', name: 'Earth (reference)', seed: 21, config: { ...EARTH }, bots: 2, sky: 'earth', variedWalls: false,
    blurb: 'Uniform 1 g, flat ground, no spin: what everything "should" do. Compare any trick here and on a ring.' },
];

/** Settings that describe the world itself: reset for every level. */
export const WORLD_KEYS = ['R', 'g', 'spin', 'world', 'planetSpin', 'outerShell', 'launchPads', 'diskBowl', 'wheelHub', 'wheelSpokes', 'tower', 'teams', 'teamBases', 'ctf', 'spinControl', 'scoreLimit', 'timeLimit', 'bannedItems', 'startWeapons', 'startSticky', 'startBounce', 'startJetpack', 'startGrapple', 'twin', 'twinGap', 'gravity', 'arena', 'halfWidth', 'wallHeight', 'dragType', 'dragCoeff', 'terrainSphere', 'hills', 'hillHeight', 'mountains', 'mountainHeight', 'bases', 'ridgeHeight', 'ridgePlateau', 'tube', 'tubeRadius', 'floorHoles', 'deckHeight', 'spinChange', 'spinPeriod', 'windows', 'biomes', 'floorTexture', 'planetPull', 'planetAngle'] as const;

export const levelById = (id: string) => LEVELS.find((l) => l.id === id);

/** Floor position at `angleDeg` (from the start, + spinward) and `z`. */
function floorAt(state: SimState, startAngle: number, angleDeg: number, z: number, height: number): Vec3 {
  return spawnPosition(state.config, { angle: startAngle + (angleDeg * Math.PI) / 180, z }, height, state.level);
}

export interface StartedLevel {
  state: SimState;
  localId: number;
  botIds: number[]; // every AI-driven player (sandbox bots and campaign enemies)
}

/** A level's bots shared out between the teams, so they come out even with you counted (on `myTeam`). */
export function splitBots(bots: number, teams: number, myTeam: number): number[] {
  const total = bots + 1, base = Math.floor(total / teams), extra = total % teams;
  // (the odd ones out go to the teams after yours, so yours isn't the big one)
  return Array.from({ length: teams }, (_, t) => base + ((t - myTeam - 1 + teams) % teams < extra ? 1 : 0) - (t === myTeam ? 1 : 0)).map((n) => Math.max(0, n));
}

/** Who's playing (deathmatch): your name and colour, and teams. */
export interface GameSetup {
  name?: string;
  color?: number; // -1 = default
  teams?: number; // 0 = free-for-all, 2-4 teams
  myTeam?: number;
  /** Bots: free-for-all, [count]; with teams, the count on each team. Default: the level's own number (split between the teams). */
  bots?: number[];
  bases?: boolean; // with teams, give each team a base (where the level allows); default true
  ctf?: boolean; // capture the flag (teams with bases)
  spinControl?: boolean; // spin control (2 teams with bases)
  /** Pickups and loadout (unset: the usual). */
  bannedItems?: ItemKind[];
  startWeapons?: WeaponId[];
  startSticky?: number;
  startBounce?: number;
  startJetpack?: boolean;
  startGrapple?: boolean;
  scoreLimit?: number; // first to this score (captures, in capture the flag) wins; 0 or unset: no limit
  timeLimit?: number; // seconds; 0 or unset: no limit
}

/**
 * Build a level. `baseConfig` (e.g. the debug panel's live values) is applied
 * first, then the level's own overrides on top, then `setup` (deathmatch only).
 */
export function startLevel(def: LevelDef, baseConfig: Partial<SimConfig> = {}, setup: GameSetup = {}): StartedLevel {
  const campaign = def.mode === 'campaign';
  // World settings always come from the defaults plus this level, never from
  // whatever level ran before (other debug tweaks do carry over).
  const defaults = defaultConfig();
  const world: Partial<SimConfig> = {};
  for (const k of WORLD_KEYS) (world as Record<string, unknown>)[k] = defaults[k];
  const teams = campaign ? 0 : Math.max(0, Math.min(4, setup.teams ?? 0));
  const teamPlay = teams >= 2;
  const state = createState({
    seed: def.seed,
    config: { ...baseConfig, ...world, ...def.config, friendlyFire: !campaign && !teamPlay, teams: teamPlay ? teams : 0, teamBases: teamPlay && ((setup.bases ?? true) || !!setup.ctf || !!setup.spinControl), ctf: teamPlay && !!setup.ctf && !setup.spinControl, spinControl: teams === 2 && !!setup.spinControl, scoreLimit: campaign ? 0 : Math.max(0, setup.scoreLimit ?? 0),
      ...(campaign ? {} : {
        ...(setup.bannedItems ? { bannedItems: [...setup.bannedItems] } : {}),
        ...(setup.startWeapons ? { startWeapons: [...setup.startWeapons] } : {}),
        ...(setup.startSticky !== undefined ? { startSticky: setup.startSticky } : {}),
        ...(setup.startBounce !== undefined ? { startBounce: setup.startBounce } : {}),
        ...(setup.startJetpack !== undefined ? { startJetpack: setup.startJetpack } : {}),
        ...(setup.startGrapple !== undefined ? { startGrapple: setup.startGrapple } : {}),
      }), timeLimit: campaign ? 0 : Math.max(0, setup.timeLimit ?? 0) },
    variedWalls: def.variedWalls ?? true,
    props: def.props ?? true,
    pickups: def.pickups ?? true,
    mode: def.mode,
    levelId: def.id,
    // campaign levels keep a few bikes (the deathmatch swarm is for free-for-alls)
    vehicles: def.vehicles ?? (campaign ? ((def.config.R ?? 0) >= (baseConfig.vehicleMinRadius ?? defaults.vehicleMinRadius) ? 4 : 0) : undefined),
  });
  const cfg = state.config;
  // this level's choice of pickups
  if (def.items) {
    const items = def.items;
    state.pickups = items.length ? state.pickups.map((pk, i) => ({ ...pk, item: items[i % items.length] })) : [];
  }
  // default start: angle 0, or near one end of an arena (so the enemies are ahead of you)
  const start = def.start ?? { angle: cfg.arena > 0 ? ((-cfg.arena / 2 + 8) / cfg.R) * (180 / Math.PI) : 0, z: cfg.twin ? -cfg.halfWidth / 2 : cfg.world === 'planet' && cfg.planetSpin > 1 ? 1.25 * cfg.R : 0 }; // (twin: on ring A; a planet whose spin beats its gravity: near a pole)
  const startAngle = (start.angle * Math.PI) / 180;

  const localId = addPlayer(state, 'human', 'You');
  const me = state.players.find((p) => p.id === localId)!;
  me.pos = freeSpotNear(state, floorAt(state, 0, start.angle, start.z, standHeight(1)), 1);
  if (campaign) {
    me.team = 0;
    me.canRespawn = false;
  }

  const botIds: number[] = [];
  if (campaign) {
    const counts: Record<string, number> = {};
    for (const e of def.enemies ?? []) {
      const t = ENEMY_TYPES[e.type];
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      const id = addPlayer(state, 'bot', `${t.name} ${counts[e.type]}`);
      const p = state.players.find((q) => q.id === id)!;
      p.team = 1;
      p.enemyType = e.type;
      p.size = t.size;
      p.color = t.color;
      p.maxHealth = p.health = t.health;
      p.maxShield = p.shield = t.shield;
      p.speedScale = t.speedScale;
      p.canRespawn = false;
      const w = WEAPON_IDS.indexOf(t.weapon);
      p.owned = [w];
      p.weapon = w;
      p.ammo[w] = cfg.weapons[t.weapon].ammoMax;
      p.mag[w] = cfg.weapons[t.weapon].magSize;
      p.infiniteAmmo = true; // never runs dry, but still has to reload
      p.grenades = t.grenades;
      p.bounceGrenades = t.bounceGrenades;
      const dk = e.deck ? state.level.decks?.[0] : undefined;
      if (dk) {
        const a = startAngle + (e.along !== undefined ? e.along / cfg.R : ((e.angle ?? 0) * Math.PI) / 180);
        const r = dk.r - standHeight(t.size);
        p.pos = freeSpotNear(state, [r * Math.cos(a), r * Math.sin(a), e.z ?? 0], t.size);
        p.yaw = (e.along ?? e.angle ?? 0) > 0 ? Math.PI : 0;
        botIds.push(id);
        continue;
      }
      if (e.outer && cfg.outerShell > 0) {
        const lon = startAngle + (e.along !== undefined ? e.along / cfg.outerShell : ((e.angle ?? 0) * Math.PI) / 180);
        p.pos = freeSpotNear(state, spawnPosition(cfg, { angle: lon, z: e.z ?? 0, outer: true }, standHeight(t.size), state.level), t.size);
        botIds.push(id);
        continue;
      }
      const top = e.stair !== undefined ? state.level.stairTops[e.stair % Math.max(1, state.level.stairTops.length)] : undefined;
      p.pos = freeSpotNear(state, top
        ? addScaled(top, localBasis(top).up, standHeight(t.size))
        : floorAt(state, startAngle, e.along !== undefined ? (e.along / cfg.R) * (180 / Math.PI) : (e.angle ?? 0), e.z ?? 0, standHeight(t.size)), t.size);
      // face the player
      p.yaw = (e.angle ?? 0) > 0 ? Math.PI : 0;
      botIds.push(id);
    }
  } else if (teamPlay) {
    // teams: you, then each team's bots; everyone in their team's colour
    const myTeam = Math.max(0, Math.min(teams - 1, setup.myTeam ?? 0));
    me.team = myTeam;
    me.color = TEAM_COLORS[myTeam];
    const perTeam = setup.bots ?? splitBots(def.bots ?? 0, teams, myTeam);
    for (let t = 0; t < teams; t++) {
      for (let i = 0; i < Math.max(0, perTeam[t] ?? 0); i++) {
        const id = addPlayer(state, 'bot', `${TEAM_NAMES[t]} bot ${i + 1}`);
        const b = state.players.find((q) => q.id === id)!;
        b.team = t;
        b.color = TEAM_COLORS[t];
        botIds.push(id);
      }
    }
    // with bases, everyone starts at home
    if (state.level.bases) {
      const k = new Map<number, number>();
      for (const p of state.players) {
        const base = state.level.bases.find((b) => b.team === p.team);
        if (!base) continue;
        const i = k.get(p.team) ?? 0;
        k.set(p.team, i + 1);
        const sp = base.spawns[i % base.spawns.length];
        p.pos = freeSpotNear(state, spawnPosition(cfg, sp, standHeight(p.size), state.level), p.size);
        p.homeSpawn = 0;
      }
    }
  } else {
    const n = setup.bots?.[0] ?? def.bots ?? 0;
    for (let i = 0; i < n; i++) botIds.push(addPlayer(state, 'bot', `Bot ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''}`));
  }
  if (setup.name?.trim()) me.name = setup.name.trim().slice(0, 16);
  if (!teamPlay && setup.color !== undefined) me.color = setup.color;
  return { state, localId, botIds };
}

/**
 * A player joins a running match (multiplayer): on the team asked for (or the
 * smallest), in its colour, at its base if there are bases. Returns their id.
 */
export function joinPlayer(state: SimState, who: { name?: string; color?: number; team?: number }): number {
  const cfg = state.config;
  const id = addPlayer(state, 'human', (who.name ?? '').trim().slice(0, 16) || 'Player');
  const p = state.players.find((q) => q.id === id)!;
  if (cfg.teams >= 2) {
    const count = (t: number) => state.players.filter((q) => q.id !== id && q.team === t && q.kind !== 'dummy').length;
    let team = who.team !== undefined && who.team >= 0 && who.team < cfg.teams ? who.team : 0;
    if (who.team === undefined || who.team < 0 || who.team >= cfg.teams) for (let t = 1; t < cfg.teams; t++) if (count(t) < count(team)) team = t;
    p.team = team;
    p.color = TEAM_COLORS[team];
    const base = state.level.bases?.find((b) => b.team === team);
    if (base) p.pos = freeSpotNear(state, spawnPosition(cfg, base.spawns[count(team) % base.spawns.length], standHeight(p.size), state.level), p.size);
  } else if (who.color !== undefined) p.color = who.color;
  return id;
}
