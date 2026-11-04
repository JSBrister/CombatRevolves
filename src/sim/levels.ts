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
import { ENEMY_TYPES } from './tuning';
import { WEAPON_IDS, type GameMode, type SimConfig, type SimState } from './types';
import { type Vec3, addScaled } from './vec';
import { addPlayer, createState, standHeight } from './world';

export interface EnemySpawn {
  type: keyof typeof ENEMY_TYPES;
  angle?: number; // degrees from the player start, + = spinward
  z?: number; // metres across the ring
  stair?: number; // or: stand on this staircase's lookout
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
  start?: { angle: number; z: number }; // degrees, metres (default 0, 0)
  enemies?: EnemySpawn[]; // campaign
}

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
  // ------------------------------------------------------------ sandbox
  { id: 's-standard', mode: 'sandbox', name: 'Standard ring (100 m)', seed: 1234, config: { R: 100 }, bots: 3,
    blurb: '1 g at the floor, a 20 s spin, 31 m/s rim speed. Three bots.' },
  { id: 's-tiny', mode: 'sandbox', name: 'Tiny ring (12 m)', seed: 11, config: { R: 12 }, bots: 1,
    blurb: 'Spins every 7 s. Sprint antispinward faster than the rim and you float.' },
  { id: 's-small', mode: 'sandbox', name: 'Small ring (40 m)', seed: 12, config: { R: 40 }, bots: 2,
    blurb: 'A 12.7 s spin. Strong Coriolis: grenades curve visibly.' },
  { id: 's-large', mode: 'sandbox', name: 'Large ring (500 m)', seed: 13, config: { R: 500 }, bots: 4,
    blurb: 'A 45 s spin and 70 m/s rim speed. Feels almost like home.' },
  { id: 's-huge', mode: 'sandbox', name: 'Huge ring (2000 m)', seed: 14, config: { R: 2000 }, bots: 4,
    blurb: '12.6 km around. The far side is a thin line in the sky.' },
  { id: 's-empty', mode: 'sandbox', name: 'Empty ring (100 m)', seed: 15, config: { R: 100 }, bots: 0,
    blurb: 'No bots, no clutter: a physics playground.' },
];

export const levelById = (id: string) => LEVELS.find((l) => l.id === id);

/** Floor position at `angleDeg` (from the start, + spinward) and `z`. */
function floorAt(cfg: SimConfig, startAngle: number, angleDeg: number, z: number, height: number): Vec3 {
  return spawnPosition(cfg, { angle: startAngle + (angleDeg * Math.PI) / 180, z }, height);
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
  const state = createState({
    seed: def.seed,
    config: { ...baseConfig, ...def.config, friendlyFire: !campaign },
    variedWalls: def.variedWalls ?? true,
    props: def.props ?? true,
    pickups: def.pickups ?? true,
    mode: def.mode,
    levelId: def.id,
  });
  const cfg = state.config;
  const start = def.start ?? { angle: 0, z: 0 };
  const startAngle = (start.angle * Math.PI) / 180;

  const localId = addPlayer(state, 'human', 'You');
  const me = state.players.find((p) => p.id === localId)!;
  me.pos = floorAt(cfg, 0, start.angle, start.z, standHeight(1));
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
      p.grenades = t.grenades;
      p.bounceGrenades = t.bounceGrenades;
      const top = e.stair !== undefined ? state.level.stairTops[e.stair % Math.max(1, state.level.stairTops.length)] : undefined;
      p.pos = top
        ? addScaled(top, localBasis(top).up, standHeight(t.size))
        : floorAt(cfg, startAngle, e.angle ?? 0, e.z ?? 0, standHeight(t.size));
      // face the player
      p.yaw = (e.angle ?? 0) > 0 ? Math.PI : 0;
      botIds.push(id);
    }
  } else {
    for (let i = 0; i < (def.bots ?? 0); i++) botIds.push(addPlayer(state, 'bot', `Bot ${String.fromCharCode(65 + i)}`));
  }
  return { state, localId, botIds };
}
