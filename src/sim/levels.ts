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
import { WEAPON_IDS, type GameMode, type SimConfig, type SimState } from './types';
import { type Vec3, addScaled } from './vec';
import { addPlayer, createState, freeSpotNear, standHeight } from './world';

export interface EnemySpawn {
  type: keyof typeof ENEMY_TYPES;
  angle?: number; // degrees from the player start, + = spinward
  along?: number; // or metres along the floor from the start (handy on Earth, where a degree is 1.7 km)
  z?: number; // metres across the ring
  stair?: number; // or: stand on this staircase's lookout
  deck?: boolean; // stand on the upper deck (at angle/along, z) instead of the floor
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
}

/**
 * Earth: a "ring" 100 km in radius that doesn't spin, with real 1 g gravity
 * toward the floor. Over the 120 m arena the floor curves by about 2 cm, so
 * it's flat ground: the reference for what everything "should" do.
 */
const EARTH: Partial<SimConfig> = { R: 100000, spin: false, gravity: 9.81, arena: 300, halfWidth: 90, wallHeight: 5 };

export const LEVELS: LevelDef[] = [
  // ------------------------------------------------------------ campaign
  {
    id: 'c1', mode: 'campaign', name: 'First Contact', seed: 101,
    blurb: 'A standard 100 m ring. Four grunts and a soldier. Mind the Coriolis drift on your shots.',
    config: { R: 100 },
    enemies: [
      { type: 'grunt', angle: 20, z: -6 }, { type: 'grunt', angle: 24, z: 6 },
      { type: 'grunt', angle: -25, z: 0 }, { type: 'grunt', angle: 60, z: 10 },
      { type: 'soldier', angle: 90, z: -4 },
    ],
  },
  {
    id: 'c2', mode: 'campaign', name: 'Tight Spin', seed: 202,
    blurb: 'A 40 m ring that turns every 12.7 s. Everything curves hard, including you.',
    config: { R: 40 },
    enemies: [
      { type: 'grunt', angle: 45, z: -8 }, { type: 'grunt', angle: 90, z: 8 }, { type: 'grunt', angle: 180, z: 0 },
      { type: 'grunt', angle: 270, z: -8 }, { type: 'skirmisher', angle: 135, z: 0 },
    ],
  },
  {
    id: 'c3', mode: 'campaign', name: 'Overwatch', seed: 303,
    blurb: 'A 150 m ring. Snipers hold two lookouts; soldiers patrol below. Lasers barely curve.',
    config: { R: 150 },
    enemies: [
      { type: 'sniper', stair: 0 }, { type: 'sniper', stair: 1 },
      { type: 'soldier', angle: 25, z: 8 }, { type: 'soldier', angle: 50, z: -8 }, { type: 'soldier', angle: -40, z: 0 },
    ],
  },
  {
    id: 'c4', mode: 'campaign', name: 'Heavy Rotation', seed: 404,
    blurb: 'A 60 m ring with two fuel-rod heavies. Their blasts will knock you clean off the edge.',
    config: { R: 60 },
    enemies: [
      { type: 'heavy', angle: 90, z: -5 }, { type: 'heavy', angle: 200, z: 5 },
      { type: 'soldier', angle: 45, z: 8 }, { type: 'skirmisher', angle: 140, z: -8 },
    ],
  },
  {
    id: 'c5', mode: 'campaign', name: 'The Big Wheel', seed: 505,
    blurb: 'A 400 m ring: near-flat, slow spin, long sightlines. Everyone is here.',
    config: { R: 400 },
    enemies: [
      { type: 'grunt', angle: 6, z: -8 }, { type: 'grunt', angle: 7, z: 8 }, { type: 'soldier', angle: 12, z: 0 },
      { type: 'skirmisher', angle: -10, z: 5 }, { type: 'sniper', stair: 0 }, { type: 'sniper', stair: 3 },
      { type: 'heavy', angle: 25, z: 0 }, { type: 'soldier', angle: 35, z: -10 }, { type: 'grunt', angle: -20, z: -5 },
    ],
  },
  {
    id: 'c6', mode: 'campaign', name: 'Hill Country', seed: 606,
    blurb: 'A 200 m ring of rolling hills, 100 m wide. Hold the high ground; mind the grenades rolling down it.',
    config: { R: 200, halfWidth: 50, hills: 26, hillHeight: 9 },
    enemies: [
      { type: 'soldier', along: 40, z: -15 }, { type: 'soldier', along: 55, z: 20 }, { type: 'grunt', along: 35, z: 5 },
      { type: 'grunt', along: 38, z: -5 }, { type: 'heavy', along: 90, z: 0 }, { type: 'skirmisher', along: -45, z: 10 },
      { type: 'sniper', stair: 1 },
    ],
  },
  {
    id: 'c7', mode: 'campaign', name: 'Double Trouble', seed: 707,
    blurb: 'A ring with an upper deck. Swarmers up top fire homing seekers; get under the deck, or up the ramps and in close.',
    config: { R: 150, halfWidth: 25, deckHeight: 10 }, vehicles: 0,
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
    enemies: [
      { type: 'grunt', along: 25, z: 0 }, { type: 'grunt', along: 28, z: 2 }, { type: 'skirmisher', along: -30, z: -2 },
      { type: 'soldier', along: 55, z: 0 }, { type: 'swarmer', along: -60, z: 0 }, { type: 'heavy', along: 100, z: 0 },
    ],
  },
  {
    id: 'c9', mode: 'campaign', name: 'Power Cut', seed: 909,
    blurb: 'The spin motors keep failing: every 60 s the ring winds down to a fifth of its spin, then back up. Low g is coming; so is the Euler shove.',
    config: { R: 120, spinChange: 0.8, spinPeriod: 60 },
    enemies: [
      { type: 'grunt', along: 25, z: -5 }, { type: 'grunt', along: 28, z: 5 }, { type: 'soldier', along: 45, z: 0 },
      { type: 'skirmisher', along: -35, z: 6 }, { type: 'swarmer', along: 70, z: -4 }, { type: 'heavy', along: 100, z: 0 },
      { type: 'sniper', stair: 0 },
    ],
  },
  {
    id: 'c0', mode: 'campaign', name: 'Shore Leave (Earth)', seed: 11, sky: 'earth', variedWalls: false,
    blurb: 'Back on Earth: flat ground, normal gravity, no spin. Three grunts. Everything you learned up there is now subtly wrong.',
    config: { ...EARTH },
    start: { angle: 0, z: 0 },
    enemies: [{ type: 'grunt', along: 25, z: -10 }, { type: 'grunt', along: 35, z: 8 }, { type: 'grunt', along: 45, z: 0 }],
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
export const WORLD_KEYS = ['R', 'g', 'spin', 'world', 'planetSpin', 'gravity', 'arena', 'halfWidth', 'wallHeight', 'dragType', 'dragCoeff', 'terrainSphere', 'hills', 'hillHeight', 'mountains', 'mountainHeight', 'bases', 'ridgeHeight', 'ridgePlateau', 'tube', 'tubeRadius', 'floorHoles', 'deckHeight', 'spinChange', 'spinPeriod', 'windows', 'planetPull', 'planetAngle'] as const;

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

/**
 * Build a level. `baseConfig` (e.g. the debug panel's live values) is applied
 * first, then the level's own overrides on top.
 */
export function startLevel(def: LevelDef, baseConfig: Partial<SimConfig> = {}): StartedLevel {
  const campaign = def.mode === 'campaign';
  // World settings always come from the defaults plus this level, never from
  // whatever level ran before (other debug tweaks do carry over).
  const defaults = defaultConfig();
  const world: Partial<SimConfig> = {};
  for (const k of WORLD_KEYS) (world as Record<string, unknown>)[k] = defaults[k];
  const state = createState({
    seed: def.seed,
    config: { ...baseConfig, ...world, ...def.config, friendlyFire: !campaign },
    variedWalls: def.variedWalls ?? true,
    props: def.props ?? true,
    pickups: def.pickups ?? true,
    mode: def.mode,
    levelId: def.id,
    vehicles: def.vehicles,
  });
  const cfg = state.config;
  // default start: angle 0, or near one end of an arena (so the enemies are ahead of you)
  const start = def.start ?? { angle: cfg.arena > 0 ? ((-cfg.arena / 2 + 8) / cfg.R) * (180 / Math.PI) : 0, z: 0 };
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
      const top = e.stair !== undefined ? state.level.stairTops[e.stair % Math.max(1, state.level.stairTops.length)] : undefined;
      p.pos = freeSpotNear(state, top
        ? addScaled(top, localBasis(top).up, standHeight(t.size))
        : floorAt(state, startAngle, e.along !== undefined ? (e.along / cfg.R) * (180 / Math.PI) : (e.angle ?? 0), e.z ?? 0, standHeight(t.size)), t.size);
      // face the player
      p.yaw = (e.angle ?? 0) > 0 ? Math.PI : 0;
      botIds.push(id);
    }
  } else {
    for (let i = 0; i < (def.bots ?? 0); i++) botIds.push(addPlayer(state, 'bot', `Bot ${String.fromCharCode(65 + i)}`));
  }
  return { state, localId, botIds };
}
