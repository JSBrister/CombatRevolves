import { generateLevel, spawnPosition } from './level';
import { localBasis } from './physics';
import { rngRange } from './rng';
import { defaultConfig, neutralInput, type Player, type PlayerKind, type SimConfig, type SimState } from './types';
import type { Vec3 } from './vec';

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HALF_SEG = 0.5; // capsule segment half-length; total height 1.8 m
export const PLAYER_STAND = PLAYER_HALF_SEG + PLAYER_RADIUS; // centre height above floor
export const EYE_OFFSET = 0.7;
export const PLAYER_MASS = 80;
export const MAX_GRENADES = 4;

export interface WorldOptions {
  seed?: number;
  config?: Partial<SimConfig>;
  obstacles?: boolean;
  props?: boolean;
  dummies?: boolean;
}

export function createState(opts: WorldOptions = {}): SimState {
  const config = { ...defaultConfig(), ...(opts.config ?? {}) };
  const state: SimState = {
    tick: 0,
    frameAngle: 0,
    rng: (opts.seed ?? 1234) >>> 0,
    nextId: 1,
    config,
    level: { boxes: [], spawns: [] },
    players: [],
    bolts: [],
    grenades: [],
    props: [],
    explosions: [],
    events: [],
  };
  state.level = generateLevel(config, state, opts.obstacles ?? true, () => allocId(state));
  if (opts.props ?? true) {
    for (let i = 0; i < 12; i++) {
      const a = ((i + 0.5) / 12) * Math.PI * 2 + rngRange(state, -0.1, 0.1);
      const radius = rngRange(state, 0.4, 0.9);
      addProp(state, [(config.R - radius) * Math.cos(a), (config.R - radius) * Math.sin(a), rngRange(state, -14, 14)], radius);
    }
  }
  if (opts.dummies ?? true) {
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
  const pos = spawnPosition(state.config, spawns[si], PLAYER_STAND);
  const p: Player = {
    id, type: 'player', kind, name,
    pos, vel: [0, 0, 0],
    yaw: 0, pitch: 0,
    grounded: false, groundNormal: localBasis(pos).up,
    apparentG: 1,
    alive: true, respawnTick: 0, homeSpawn: si,
    health: state.config.maxHealth, shield: state.config.maxShield,
    lastDamageTick: -1e9, lastAttacker: -1,
    weapon: 0, rifleHeat: 0, rifleOverheatUntil: 0, pistolHeat: 0, pistolCharge: 0, pistolHoldTicks: 0,
    fireReadyTick: 0, grenades: MAX_GRENADES, grenadeReadyTick: 0,
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
