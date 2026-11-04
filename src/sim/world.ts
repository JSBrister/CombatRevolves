import { BIKE_RADIUS, generateLevel, levelSdf, spawnPosition } from './level';
import { localBasis } from './physics';
import { rngRange } from './rng';
import { defaultConfig } from './tuning';
import { DT, STARTING_WEAPONS, WEAPON_IDS, neutralInput, type GameMode, type ItemKind, type Player, type PlayerKind, type SimConfig, type SimState } from './types';
import type { Vec3 } from './vec';

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HALF_SEG = 0.5; // capsule segment half-length; total height 1.8 m
export const PLAYER_STAND = PLAYER_HALF_SEG + PLAYER_RADIUS; // centre height above floor
export const EYE_OFFSET = 0.7;
export const PLAYER_MASS = 80;

/** A player's collision capsule, scaled by their size. */
export const capsuleRadius = (p: Player) => PLAYER_RADIUS * p.size;
export const capsuleHalfSeg = (p: Player) => PLAYER_HALF_SEG * p.size;
export const eyeOffset = (p: Player) => EYE_OFFSET * p.size;
/** Height of the capsule centre above the floor when standing. */
export const standHeight = (size: number) => PLAYER_STAND * size;
export const MAX_GRENADES = 4; // of each type

export interface WorldOptions {
  seed?: number;
  config?: Partial<SimConfig>;
  obstacles?: boolean;
  props?: boolean;
  /** Static target dummies (default false). */
  dummies?: boolean;
  /** Rim walls with low and medium stretches (default true). False = full height all round. */
  variedWalls?: boolean;
  /** Item pickups at the level's fixed spots (default: same as `obstacles`). */
  pickups?: boolean;
  mode?: GameMode;
  levelId?: string;
  /** Number of hover-bikes (default: by ring size, see tuning.ts). */
  vehicles?: number;
}

export function createState(opts: WorldOptions = {}): SimState {
  const config = { ...defaultConfig(), ...(opts.config ?? {}) };
  const state: SimState = {
    tick: 0,
    mode: opts.mode ?? 'sandbox',
    levelId: opts.levelId ?? 'custom',
    outcome: 'playing',
    frameAngle: 0,
    rng: (opts.seed ?? 1234) >>> 0,
    nextId: 1,
    config,
    level: { shape: 'ring', terrain: null, boxes: [], stairTops: [], spawns: [], pickupSpots: [], vehicleSpots: [], wallPos: [], wallNeg: [] },
    players: [],
    bolts: [],
    grenades: [],
    props: [],
    explosions: [],
    pickups: [],
    vehicles: [],
    events: [],
  };
  state.level = generateLevel(config, state, opts.obstacles ?? true, () => allocId(state), opts.variedWalls ?? true, opts.vehicles ?? -1);
  for (const spot of state.level.vehicleSpots) addVehicle(state, spot.pos, spot.yaw);
  if (opts.pickups ?? opts.obstacles ?? true) {
    for (const spot of state.level.pickupSpots) addPickup(state, spot.item, spot.pos, -1, Math.round(config.pickupRespawn / DT), -1);
  }
  if (opts.props ?? true) {
    for (let i = 0; i < 12; i++) {
      const a = ((i + 0.5) / 12) * Math.PI * 2 + rngRange(state, -0.1, 0.1);
      const radius = rngRange(state, 0.4, 0.9);
      addProp(state, [(config.R - radius) * Math.cos(a), (config.R - radius) * Math.sin(a), rngRange(state, -14, 14)], radius);
    }
  }
  if (opts.dummies ?? false) {
    // A line of target dummies a little spinward of spawn 0, across the ring.
    for (let i = 0; i < 4; i++) {
      const id = addPlayer(state, 'dummy', `Dummy ${i + 1}`);
      const p = state.players.find((q) => q.id === id)!;
      p.homeSpawn = -1 - i;
      p.pos = dummyHome(config, p.homeSpawn);
      p.yaw = Math.PI; // facing antispinward (toward spawn 0)
    }
  }
  return state;
}

export function allocId(state: SimState): number {
  return state.nextId++;
}

export function addProp(state: SimState, pos: Vec3, radius: number, vel: Vec3 = [0, 0, 0]): number {
  const id = allocId(state);
  state.props.push({ id, type: 'prop', pos, vel, radius, mass: 60 * radius * radius * radius * 4, contactNormal: null });
  return id;
}

export function addPlayer(state: SimState, kind: PlayerKind, name: string, spawnIndex?: number): number {
  const id = allocId(state);
  const spawns = state.level.spawns;
  const si = spawnIndex ?? (state.players.filter((p) => p.kind !== 'dummy').length % spawns.length);
  const pos = spawnPosition(state.config, spawns[si], PLAYER_STAND, state.level);
  const p: Player = {
    id, type: 'player', kind, name,
    team: id, size: 1, color: -1, enemyType: '',
    maxHealth: state.config.maxHealth, maxShield: state.config.maxShield, speedScale: 1, canRespawn: true,
    pos, vel: [0, 0, 0],
    yaw: 0, pitch: 0,
    grounded: false, groundNormal: localBasis(pos).up,
    apparentG: 1,
    alive: true, respawnTick: 0, homeSpawn: si,
    health: state.config.maxHealth, shield: state.config.maxShield,
    lastDamageTick: -1e9, lastAttacker: -1,
    weapon: 0, owned: [...STARTING_WEAPONS],
    heat: WEAPON_IDS.map(() => 0), overheatUntil: WEAPON_IDS.map(() => 0), ammo: WEAPON_IDS.map(() => 0),
    mag: WEAPON_IDS.map(() => 0), reloadUntil: 0, infiniteAmmo: false,
    charge: 0, holdTicks: 0, needRelease: false, burstUntil: 0, meleeReadyTick: 0, vehicle: -1,
    fireReadyTick: 0, hasJetpack: false, jetFuel: 0, jetting: false, lastGroundTick: -1e9, lastJumpTick: -1e9,
    grenades: MAX_GRENADES, bounceGrenades: MAX_GRENADES, grenadeReadyTick: 0,
    prevButtons: 0, lastInput: neutralInput(id, 0),
    kills: 0, deaths: 0,
  };
  state.players.push(p);
  return id;
}

/** Dummies (homeSpawn < 0) stand in a row 14 m spinward of spawn 0. */
export function dummyHome(cfg: SimConfig, homeSpawn: number): Vec3 {
  const i = -1 - homeSpawn;
  const ang = 14 / cfg.R;
  const r = cfg.R - PLAYER_STAND;
  return [r * Math.cos(ang), r * Math.sin(ang), -9 + i * 6];
}

export function removePlayer(state: SimState, id: number) {
  state.players = state.players.filter((p) => p.id !== id);
  for (const g of state.grenades) if (g.stuck && g.stuck.kind === 'player' && g.stuck.id === id) g.stuck = null;
}

export function addPickup(state: SimState, item: ItemKind, pos: Vec3, amount: number, respawnTicks: number, expireTick: number): number {
  const id = allocId(state);
  state.pickups.push({ id, type: 'pickup', item, pos, amount, respawnTicks, activeAt: state.tick, expireTick });
  return id;
}

/**
 * A spot near `pos` where a capsule of this size fits (fixed placements can
 * land inside cover). Searches outward along the floor; returns `pos` if clear.
 */
export function freeSpotNear(state: SimState, pos: Vec3, size: number): Vec3 {
  const b = localBasis(pos);
  const r = PLAYER_RADIUS * size, h = PLAYER_HALF_SEG * size;
  const fits = (q: Vec3) => [-1, 0, 1].every((k) => {
    const c: Vec3 = [q[0] + b.up[0] * k * h, q[1] + b.up[1] * k * h, q[2]];
    return levelSdf(state.level, state.config, c).d - r > 0.05;
  });
  if (fits(pos)) return pos;
  for (let ring = 1; ring <= 16; ring++) {
    const dist = ring * 0.5;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const q: Vec3 = [
        pos[0] + (b.spin[0] * Math.cos(a)) * dist, pos[1] + (b.spin[1] * Math.cos(a)) * dist, pos[2] + Math.sin(a) * dist,
      ];
      if (fits(q)) return q;
    }
  }
  return pos;
}

export function addVehicle(state: SimState, pos: Vec3, yaw: number): number {
  const id = allocId(state);
  const hp = state.config.bikeHealth;
  state.vehicles.push({
    id, type: 'vehicle', kind: 'bike', pos: [...pos] as Vec3, vel: [0, 0, 0], yaw, radius: BIKE_RADIUS,
    health: hp, maxHealth: hp, driver: -1, alive: true, respawnTick: 0, home: [...pos] as Vec3, homeYaw: yaw,
    contactNormal: null, lastAttacker: -1, lastDamageTick: -1e9,
  });
  return id;
}
