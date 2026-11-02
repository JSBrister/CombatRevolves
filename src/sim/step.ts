// The authoritative simulation step. Pure data in, pure data out (mutated in
// place). No DOM, no three.js, no Math.random, no wall clock: the tick counter
// is the only clock and the seeded RNG lives in the state.

import { clamp, closestOnSeg, segSegClosest, segSphere } from './geom';
import { levelSdf, sphereTrace, spawnPosition } from './level';
import { advanceFree, fictitiousAccel, integrate, localBasis, viewVectors } from './physics';
import { rngInt } from './rng';
import {
  BTN_FIRE, BTN_GRENADE, BTN_JUMP, BTN_SPRINT, DT, omegaOf,
  WEAPON_HOVER, WEAPON_PISTOL, WEAPON_RIFLE,
  type Bolt, type BoltKind, type Grenade, type InputCmd, type Player, type Prop, type SimConfig, type SimState,
} from './types';
import { type Vec3, add, addScaled, clone, dist, dot, len, norm, rhoOf, scale, sub } from './vec';
import {
  EYE_OFFSET, MAX_GRENADES, PLAYER_HALF_SEG, PLAYER_MASS, PLAYER_RADIUS, PLAYER_STAND, allocId, dummyHome,
} from './world';

const secs = (s: number) => Math.round(s / DT);

export const BOLT_SPECS: Record<BoltKind, { radius: number; damage: number; shieldDamage: number }> = {
  rifle: { radius: 0.12, damage: 7, shieldDamage: 7 },
  pistol: { radius: 0.15, damage: 13, shieldDamage: 13 },
  overcharge: { radius: 0.45, damage: 20, shieldDamage: 120 },
  hover: { radius: 0.25, damage: 10, shieldDamage: 10 },
};
export const GRENADE_RADIUS = 0.15;
const RIFLE_INTERVAL = 9; // ticks (~13 shots/s)
const RIFLE_HEAT_PER_SHOT = 0.045;
const RIFLE_OVERHEAT_LOCK = 2.5; // s
const PISTOL_INTERVAL = 18;
const PISTOL_CHARGE_DELAY = 30; // ticks of holding before charging starts
const PISTOL_CHARGE_TIME = 0.9; // s

export function muzzleSpeed(cfg: SimConfig, kind: BoltKind | 'grenade'): number {
  switch (kind) {
    case 'rifle': return cfg.muzzleRifle;
    case 'pistol': return cfg.muzzlePistol;
    case 'overcharge': return cfg.muzzleOvercharge;
    case 'grenade': return cfg.muzzleGrenade;
    case 'hover': return 0;
  }
}

/** Where a player's shots originate. */
export function muzzlePoint(p: Player, yaw = p.yaw, pitch = p.pitch, grenade = false): Vec3 {
  const v = viewVectors(p.pos, yaw, pitch);
  const eye = addScaled(p.pos, v.up, EYE_OFFSET);
  if (grenade) return addScaled(eye, v.aim, 0.5);
  return add(add(addScaled(eye, v.aim, 0.6), scale(v.right, 0.18)), scale(v.up, -0.12));
}

/**
 * Launch velocity rule: muzzle speed RELATIVE TO THE SHOOTER, in the rotating
 * frame: v = v_player + muzzle * aim. The hover gun is the one exception: it
 * sets v = -omega x r so the bolt is at rest in the inertial frame.
 */
export function launchVelocity(cfg: SimConfig, p: Player, kind: BoltKind | 'grenade', from: Vec3, yaw = p.yaw, pitch = p.pitch): Vec3 {
  if (kind === 'hover') {
    const w = omegaOf(cfg);
    return [w * from[1], -w * from[0], 0];
  }
  const aim = viewVectors(p.pos, yaw, pitch).aim;
  return addScaled(p.vel, aim, muzzleSpeed(cfg, kind));
}

/** Spawn helpers (also used by tests). */
export function spawnBolt(state: SimState, owner: number, kind: BoltKind, pos: Vec3, vel: Vec3): Bolt {
  const spec = BOLT_SPECS[kind];
  const b: Bolt = {
    id: allocId(state), type: 'bolt', kind, owner, pos: clone(pos), vel: clone(vel), launchVel: clone(vel),
    radius: spec.radius, damage: spec.damage, shieldDamage: spec.shieldDamage,
    armed: owner < 0, spawnTick: state.tick, expireTick: state.tick + secs(state.config.projectileLifetime),
  };
  state.bolts.push(b);
  return b;
}

export function spawnGrenade(state: SimState, owner: number, pos: Vec3, vel: Vec3): Grenade {
  const g: Grenade = {
    id: allocId(state), type: 'grenade', owner, pos: clone(pos), vel: clone(vel), launchVel: clone(vel),
    radius: GRENADE_RADIUS, armed: owner < 0, stuck: null, fuseTick: -1,
    spawnTick: state.tick, expireTick: state.tick + secs(state.config.projectileLifetime),
  };
  state.grenades.push(g);
  return g;
}

const capsuleEnds = (p: Player): [Vec3, Vec3] => {
  const up = localBasis(p.pos).up;
  return [addScaled(p.pos, up, -PLAYER_HALF_SEG), addScaled(p.pos, up, PLAYER_HALF_SEG)];
};

// =========================================================================== step

/**
 * Advance the simulation by exactly one fixed tick (DT = 1/120 s), in place.
 * `inputs` are the commands for this tick; players without a command repeat
 * their last one (as a server does on packet loss). Returns the same state.
 */
export function step(state: SimState, inputs: readonly InputCmd[], tick: number = state.tick): SimState {
  if (tick !== state.tick) throw new Error(`step: expected tick ${state.tick}, got ${tick}`);
  const cfg = state.config;
  const omega = omegaOf(cfg);
  state.events = [];

  const byPlayer = new Map<number, InputCmd>();
  for (const cmd of inputs) byPlayer.set(cmd.playerId, cmd);

  // 1. inputs -> players (stable id order)
  for (const p of state.players) {
    const cmd = byPlayer.get(p.id);
    p.lastInput = cmd ? { ...cmd, tick } : { ...p.lastInput, tick };
  }

  // 2. player motion
  for (const p of state.players) if (p.alive) movePlayer(state, p, omega);
  collidePlayers(state);

  // 3. props
  for (const pr of state.props) moveProp(state, pr, omega);
  collideProps(state);

  // 4. weapons (spawned projectiles start moving next tick; their state at the
  //    end of this tick is exactly the launch state)
  for (const p of state.players) if (p.alive) updateWeapons(state, p, omega);

  // 5. projectiles
  updateBolts(state, omega);
  updateGrenades(state, omega);
  state.explosions = state.explosions.filter((e) => tick < e.endTick);

  // 6. vitals / respawn
  for (const p of state.players) updateVitals(state, p);
  for (const p of state.players) p.prevButtons = p.lastInput.buttons;

  state.tick++;
  state.frameAngle += omega * DT;
  return state;
}

// =========================================================================== players

function movePlayer(state: SimState, p: Player, omega: number) {
  const cfg = state.config;
  const inp = p.lastInput;
  p.yaw = inp.yaw;
  p.pitch = clamp(inp.pitch, -1.55, 1.55);
  const pressed = inp.buttons & ~p.prevButtons;
  const vv = viewVectors(p.pos, p.yaw, 0);

  if (p.grounded && p.groundNormal) {
    // On the ground, input sets velocity RELATIVE TO THE FLOOR (which is the
    // rotating-frame velocity, since the floor is static in this frame).
    const n = p.groundNormal;
    let mx = clamp(inp.moveX, -1, 1), my = clamp(inp.moveY, -1, 1);
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    const sprint = (inp.buttons & BTN_SPRINT) !== 0 && my > 0.3;
    const speed = sprint ? cfg.sprintSpeed : cfg.walkSpeed;
    let wish = add(scale(vv.forward, my * speed), scale(vv.right, mx * speed));
    wish = sub(wish, scale(n, dot(wish, n)));
    const vn = dot(p.vel, n);
    const vt = sub(p.vel, scale(n, vn));
    const dv = sub(wish, vt);
    const sliding = len(vt) > cfg.sprintSpeed + 1.5;
    const maxDv = (sliding ? cfg.slideDecel : cfg.groundAccel) * DT;
    const dvl = len(dv);
    p.vel = add(p.vel, dvl > maxDv ? scale(dv, maxDv / dvl) : dv);
    if (pressed & BTN_JUMP) {
      // Jump = impulse along local up. Fictitious forces do the rest, so jump
      // height and drift depend on direction of motion.
      p.vel = addScaled(p.vel, vv.up, cfg.jumpSpeed);
      p.grounded = false;
      p.groundNormal = null;
      state.events.push({ type: 'jump', id: p.id });
    }
  }
  // Airborne: pure physics, no air control.

  const support = p.grounded ? p.groundNormal : null;
  const n = clamp(Math.ceil((len(p.vel) * DT) / 0.2), 1, 24);
  const h = DT / n;
  let ground: Vec3 | null = null;
  for (let i = 0; i < n; i++) {
    integrate(p.pos, p.vel, h, omega, cfg, support);
    const g = resolvePlayerLevel(state, p);
    if (g) ground = g;
  }
  p.grounded = ground !== null;
  p.groundNormal = ground;

  // Apparent weight: normal force per unit mass / g. Airborne = weightless.
  let target = 0;
  if (ground) {
    const a = fictitiousAccel(p.pos, p.vel, omega, cfg);
    target = Math.max(0, -dot(a, ground)) / cfg.g;
  }
  p.apparentG += (target - p.apparentG) * 0.12;
}

/** Push the capsule (3 spheres) out of the level. Returns a walkable ground normal if touching one. */
function resolvePlayerLevel(state: SimState, p: Player): Vec3 | null {
  const cfg = state.config;
  let ground: Vec3 | null = null;
  let bestUp = 0.6;
  for (let iter = 0; iter < 3; iter++) {
    const up = localBasis(p.pos).up;
    let any = false;
    for (let k = -1; k <= 1; k++) {
      const c = addScaled(p.pos, up, k * PLAYER_HALF_SEG);
      const hit = levelSdf(state.level, cfg, c);
      const gap = hit.d - PLAYER_RADIUS;
      if (gap < 0.004) {
        if (gap < 0) {
          p.pos = addScaled(p.pos, hit.n, -gap);
          any = true;
        }
        const vn = dot(p.vel, hit.n);
        if (vn < 0) p.vel = addScaled(p.vel, hit.n, -vn);
        const u = dot(hit.n, up);
        if (u > bestUp) { bestUp = u; ground = hit.n; }
      }
    }
    if (!any) break;
  }
  return ground;
}

function collidePlayers(state: SimState) {
  const ps = state.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      if (!b.alive) continue;
      if (dist(a.pos, b.pos) > 3) continue;
      const [a0, a1] = capsuleEnds(a), [b0, b1] = capsuleEnds(b);
      const c = segSegClosest(a0, a1, b0, b1);
      const minD = 2 * PLAYER_RADIUS;
      if (c.d2 >= minD * minD) continue;
      const pa = addScaled(a0, sub(a1, a0), c.s), pb = addScaled(b0, sub(b1, b0), c.t);
      let n = sub(pa, pb);
      const d = len(n);
      n = d > 1e-6 ? scale(n, 1 / d) : localBasis(a.pos).spin;
      const push = (minD - d) / 2;
      a.pos = addScaled(a.pos, n, push);
      b.pos = addScaled(b.pos, n, -push);
      const rel = dot(sub(a.vel, b.vel), n);
      if (rel < 0) {
        a.vel = addScaled(a.vel, n, -rel / 2);
        b.vel = addScaled(b.vel, n, rel / 2);
      }
    }
  }
}

// =========================================================================== props

function moveProp(state: SimState, pr: Prop, omega: number) {
  const cfg = state.config;
  const support = pr.contactNormal;
  const n = clamp(Math.ceil((len(pr.vel) * DT) / (0.4 * pr.radius)), 1, 32);
  const h = DT / n;
  let contact: Vec3 | null = null;
  for (let i = 0; i < n; i++) {
    integrate(pr.pos, pr.vel, h, omega, cfg, support);
    for (let iter = 0; iter < 2; iter++) {
      const hit = levelSdf(state.level, cfg, pr.pos);
      const gap = hit.d - pr.radius;
      if (gap >= 0.002) break;
      if (gap < 0) {
        const before = pr.pos;
        pr.pos = addScaled(pr.pos, hit.n, -gap);
        conserveJacobi(pr.vel, before, pr.pos, omega, cfg);
      }
      const vn = dot(pr.vel, hit.n);
      if (vn < 0) bounce(state, pr, hit.n, vn, cfg);
      // Only a resting/sliding contact supports the body next tick; one it is
      // bouncing away from must not cancel the centrifugal force.
      if (Math.abs(dot(pr.vel, hit.n)) < 0.25) contact = hit.n;
      if (gap >= 0) break;
    }
  }
  // rolling resistance while in contact
  if (contact) {
    const vn = dot(pr.vel, contact);
    const vt = sub(pr.vel, scale(contact, vn));
    const l = len(vt);
    if (l > 0) pr.vel = add(scale(contact, vn), scale(vt, Math.max(0, l - 1.0 * DT) / l));
  }
  pr.contactNormal = contact;
  despawnIfSpaced(state, pr.pos, pr.vel, () => (pr.radius = -1));
}

/**
 * The push-out after a discrete penetration moves the body against the
 * centrifugal potential. A static surface does no work in the rotating frame,
 * so compensate the kinetic energy to keep the Jacobi integral unchanged.
 */
function conserveJacobi(v: Vec3, from: Vec3, to: Vec3, omega: number, cfg: SimConfig) {
  if (!cfg.centrifugal) return;
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (v2 < 1e-12) return;
  const dPot = omega * omega * (to[0] * to[0] + to[1] * to[1] - from[0] * from[0] - from[1] * from[1]);
  const k = Math.sqrt(Math.max(0, v2 + dPot) / v2);
  v[0] *= k; v[1] *= k; v[2] *= k;
}

function bounce(state: SimState, pr: Prop, n: Vec3, vn: number, cfg: SimConfig) {
  const e = -vn > 1.5 ? cfg.restitution : 0;
  const vt = sub(pr.vel, scale(n, vn));
  const vtl = len(vt);
  const jn = (1 + e) * -vn;
  const f = vtl > 0 ? Math.max(0, vtl - cfg.friction * jn) / vtl : 0;
  pr.vel = add(scale(vt, f), scale(n, -vn * e));
  if (-vn > 3) state.events.push({ type: 'bodyImpact', id: pr.id, pos: clone(pr.pos), speed: -vn });
}

function collideProps(state: SimState) {
  const props = state.props;
  for (let i = 0; i < props.length; i++) {
    const a = props[i];
    for (let j = i + 1; j < props.length; j++) {
      const b = props[j];
      const d = dist(a.pos, b.pos), minD = a.radius + b.radius;
      if (d >= minD || d < 1e-9) continue;
      const n = scale(sub(a.pos, b.pos), 1 / d);
      const wa = b.mass / (a.mass + b.mass), wb = a.mass / (a.mass + b.mass);
      a.pos = addScaled(a.pos, n, (minD - d) * wa);
      b.pos = addScaled(b.pos, n, -(minD - d) * wb);
      const rel = dot(sub(a.vel, b.vel), n);
      if (rel < 0) {
        const j2 = (1 + state.config.restitution) * rel;
        a.vel = addScaled(a.vel, n, -j2 * wa);
        b.vel = addScaled(b.vel, n, j2 * wb);
      }
    }
    for (const p of state.players) {
      if (!p.alive) continue;
      const [p0, p1] = capsuleEnds(p);
      const c = closestOnSeg(a.pos, p0, p1);
      const dv = sub(a.pos, c.point);
      const d = len(dv), minD = a.radius + PLAYER_RADIUS;
      if (d >= minD || d < 1e-9) continue;
      const n = scale(dv, 1 / d);
      const wa = PLAYER_MASS / (a.mass + PLAYER_MASS), wp = a.mass / (a.mass + PLAYER_MASS);
      a.pos = addScaled(a.pos, n, (minD - d) * wa);
      p.pos = addScaled(p.pos, n, -(minD - d) * wp);
      const rel = dot(sub(a.vel, p.vel), n);
      if (rel < 0) {
        a.vel = addScaled(a.vel, n, -rel * (1 + 0.3) * wa);
        p.vel = addScaled(p.vel, n, rel * (1 + 0.3) * wp);
      }
    }
  }
  state.props = state.props.filter((p) => p.radius > 0);
}

/** Bodies that leave the ring band moving away never come back (straight inertial lines). */
function despawnIfSpaced(state: SimState, pos: Vec3, vel: Vec3, kill: () => void) {
  const cfg = state.config;
  const zLim = cfg.halfWidth + cfg.wallThickness + 4;
  if ((Math.abs(pos[2]) > zLim && pos[2] * vel[2] > 0) || rhoOf(pos) > cfg.R + cfg.hullThickness + 4) kill();
}

// =========================================================================== weapons

function updateWeapons(state: SimState, p: Player, omega: number) {
  const cfg = state.config;
  const tick = state.tick;
  const inp = p.lastInput;
  const btn = inp.buttons;
  const pressed = btn & ~p.prevButtons;
  const released = p.prevButtons & ~btn;

  if (inp.weapon !== p.weapon && inp.weapon >= 0 && inp.weapon <= 2) {
    p.weapon = inp.weapon;
    p.pistolCharge = 0;
    p.pistolHoldTicks = 0;
    p.fireReadyTick = Math.max(p.fireReadyTick, tick + secs(0.25));
  }

  // passive cooling
  const firingRifle = p.weapon === WEAPON_RIFLE && (btn & BTN_FIRE) !== 0 && tick >= p.rifleOverheatUntil;
  if (!firingRifle) p.rifleHeat = Math.max(0, p.rifleHeat - (tick < p.rifleOverheatUntil ? 1 / RIFLE_OVERHEAT_LOCK : 0.45) * DT);
  p.pistolHeat = Math.max(0, p.pistolHeat - 0.3 * DT);

  if (p.weapon === WEAPON_RIFLE) {
    if (firingRifle && tick >= p.fireReadyTick) {
      fireBolt(state, p, 'rifle');
      p.fireReadyTick = tick + RIFLE_INTERVAL;
      p.rifleHeat += RIFLE_HEAT_PER_SHOT;
      if (p.rifleHeat >= 1) {
        p.rifleHeat = 1;
        p.rifleOverheatUntil = tick + secs(RIFLE_OVERHEAT_LOCK);
        state.events.push({ type: 'overheat', id: p.id });
      }
    }
  } else if (p.weapon === WEAPON_PISTOL) {
    if (pressed & BTN_FIRE) {
      p.pistolHoldTicks = 0;
      p.pistolCharge = 0;
      if (tick >= p.fireReadyTick && p.pistolHeat < 1) {
        fireBolt(state, p, 'pistol');
        p.fireReadyTick = tick + PISTOL_INTERVAL;
        p.pistolHeat = Math.min(1, p.pistolHeat + 0.08);
      }
    } else if (btn & BTN_FIRE) {
      p.pistolHoldTicks++;
      if (p.pistolHoldTicks > PISTOL_CHARGE_DELAY && p.pistolHeat < 1) p.pistolCharge = Math.min(1, p.pistolCharge + DT / PISTOL_CHARGE_TIME);
    }
    if (released & BTN_FIRE) {
      if (p.pistolCharge >= 1) {
        fireBolt(state, p, 'overcharge');
        p.pistolHeat = Math.min(1, p.pistolHeat + 0.35);
        p.fireReadyTick = tick + secs(0.4);
      }
      p.pistolCharge = 0;
      p.pistolHoldTicks = 0;
    }
  } else if (p.weapon === WEAPON_HOVER) {
    if (pressed & BTN_FIRE && tick >= p.fireReadyTick) {
      fireBolt(state, p, 'hover');
      p.fireReadyTick = tick + 15;
    }
  }

  // Grenade: hold to aim (client shows preview), release to throw.
  if (released & BTN_GRENADE && p.grenades > 0 && tick >= p.grenadeReadyTick) {
    const from = muzzlePoint(p, p.yaw, p.pitch, true);
    spawnGrenade(state, p.id, from, launchVelocity(cfg, p, 'grenade', from));
    p.grenades--;
    p.grenadeReadyTick = tick + secs(0.6);
    state.events.push({ type: 'fire', owner: p.id, kind: 'grenade', pos: from });
  }
  void omega;
}

function fireBolt(state: SimState, p: Player, kind: BoltKind) {
  const from = muzzlePoint(p);
  spawnBolt(state, p.id, kind, from, launchVelocity(state.config, p, kind, from));
  state.events.push({ type: 'fire', owner: p.id, kind, pos: from });
}

// =========================================================================== projectiles

interface SweepHit {
  s: number;
  pos: Vec3;
  player: Player | null;
  prop: Prop | null;
}

/** Sweep a small sphere over p0->p1 against level, players and props; earliest hit wins. */
function sweep(state: SimState, p0: Vec3, p1: Vec3, radius: number, owner: number, armed: boolean): SweepHit | null {
  let best: SweepHit | null = null;
  const lh = sphereTrace(state.level, state.config, p0, p1, radius);
  if (lh) best = { s: lh.s, pos: lh.pos, player: null, prop: null };
  const segLen = dist(p0, p1);
  for (const pl of state.players) {
    if (!pl.alive || (pl.id === owner && !armed)) continue;
    if (dist(pl.pos, p0) > segLen + 3) continue;
    const [a, b] = capsuleEnds(pl);
    const c = segSegClosest(p0, p1, a, b);
    const rr = radius + PLAYER_RADIUS;
    if (c.d2 < rr * rr && (!best || c.s < best.s)) {
      best = { s: c.s, pos: addScaled(p0, sub(p1, p0), c.s), player: pl, prop: null };
    }
  }
  for (const pr of state.props) {
    const s = segSphere(p0, p1, pr.pos, pr.radius + radius);
    if (s !== null && (!best || s < best.s)) best = { s, pos: addScaled(p0, sub(p1, p0), s), player: null, prop: pr };
  }
  return best;
}

function stillInsideOwner(state: SimState, pos: Vec3, radius: number, owner: number): boolean {
  const pl = state.players.find((q) => q.id === owner);
  if (!pl || !pl.alive) return false;
  const [a, b] = capsuleEnds(pl);
  return dist(closestOnSeg(pos, a, b).point, pos) < radius + PLAYER_RADIUS + 0.05;
}

function updateBolts(state: SimState, omega: number) {
  const cfg = state.config;
  const keep: Bolt[] = [];
  for (const b of state.bolts) {
    if (b.spawnTick === state.tick) { keep.push(b); continue; }
    if (state.tick >= b.expireTick) continue;
    const p0 = clone(b.pos);
    advanceFree(b.pos, b.vel, DT, omega, cfg);
    const hit = sweep(state, p0, b.pos, b.radius, b.owner, b.armed);
    if (hit) {
      if (hit.player) {
        damagePlayer(state, hit.player, b.owner, b.damage, b.shieldDamage, b.kind);
      } else if (hit.prop) {
        const k = (b.kind === 'overcharge' ? 4 : 0.6) / hit.prop.mass;
        hit.prop.vel = addScaled(hit.prop.vel, sub(b.vel, hit.prop.vel), k);
        hit.prop.contactNormal = null;
      }
      state.events.push({ type: 'impact', pos: hit.pos, kind: b.kind, target: hit.player?.id ?? hit.prop?.id ?? -1 });
      continue;
    }
    if (!b.armed && !stillInsideOwner(state, b.pos, b.radius, b.owner)) b.armed = true;
    let dead = false;
    despawnIfSpaced(state, b.pos, b.vel, () => (dead = true));
    if (!dead) keep.push(b);
  }
  state.bolts = keep;
}

function updateGrenades(state: SimState, omega: number) {
  const cfg = state.config;
  const tick = state.tick;
  const keep: Grenade[] = [];
  for (const g of state.grenades) {
    let explode = false;
    if (g.stuck) {
      const st = g.stuck;
      if (st.kind === 'player') {
        const pl = state.players.find((q) => q.id === st.id);
        if (pl && pl.alive) {
          const b = localBasis(pl.pos);
          g.pos = add(pl.pos, add(add(scale(b.spin, st.offset[0]), scale(b.up, st.offset[1])), scale(b.axial, st.offset[2])));
          g.vel = clone(pl.vel);
        } else g.stuck = null; // host gone: fly free with last velocity, fuse keeps burning
      } else if (st.kind === 'prop') {
        const pr = state.props.find((q) => q.id === st.id);
        if (pr) { g.pos = add(pr.pos, st.offset); g.vel = clone(pr.vel); } else g.stuck = null;
      }
    } else if (g.spawnTick !== tick) {
      const p0 = clone(g.pos);
      advanceFree(g.pos, g.vel, DT, omega, cfg);
      const hit = sweep(state, p0, g.pos, g.radius, g.owner, g.armed);
      if (hit) {
        g.pos = hit.pos;
        if (hit.player) {
          const b = localBasis(hit.player.pos);
          const d = sub(hit.pos, hit.player.pos);
          g.stuck = { kind: 'player', id: hit.player.id, offset: [dot(d, b.spin), dot(d, b.up), dot(d, b.axial)] };
          g.vel = clone(hit.player.vel);
        } else if (hit.prop) {
          g.stuck = { kind: 'prop', id: hit.prop.id, offset: sub(hit.pos, hit.prop.pos) };
          g.vel = clone(hit.prop.vel);
        } else {
          g.stuck = { kind: 'world' };
          g.vel = [0, 0, 0];
        }
        if (g.fuseTick < 0) g.fuseTick = tick + secs(cfg.grenadeFuse);
        state.events.push({ type: 'stick', id: g.id, pos: clone(g.pos), target: hit.player?.id ?? hit.prop?.id ?? -1 });
      } else {
        if (!g.armed && !stillInsideOwner(state, g.pos, g.radius, g.owner)) g.armed = true;
        if (tick - g.spawnTick > secs(cfg.grenadeMaxFlight)) explode = true;
        let dead = false;
        despawnIfSpaced(state, g.pos, g.vel, () => (dead = true));
        if (dead) continue;
      }
    }
    if (g.fuseTick >= 0 && tick >= g.fuseTick) explode = true;
    if (tick >= g.expireTick) continue;
    if (explode) detonate(state, g.pos, g.owner, g.id);
    else keep.push(g);
  }
  state.grenades = keep;
}

export function falloff(cfg: SimConfig, x: number): number {
  if (x >= 1) return 0;
  const t = Math.max(0, x);
  switch (cfg.knockbackFalloff) {
    case 'none': return 1;
    case 'linear': return 1 - t;
    case 'quadratic': return (1 - t) * (1 - t);
  }
}

/**
 * Explosion: impulse to every player and prop within the radius, pointing away
 * from the blast (optionally biased toward the axis), scaled by falloff of the
 * distance to the body's surface. Owner is included (grenade jumping).
 */
export function detonate(state: SimState, c: Vec3, owner: number, sourceId: number) {
  const cfg = state.config;
  const rad = cfg.explosionRadius;
  const id = allocId(state);
  state.explosions.push({ id, type: 'explosion', owner, pos: clone(c), radius: rad, tick: state.tick, endTick: state.tick + secs(0.7) });
  state.events.push({ type: 'explode', id: sourceId, owner, pos: clone(c) });
  const kb = cfg.knockbackSpeed * cfg.knockbackScale;

  for (const p of state.players) {
    if (!p.alive) continue;
    const [a, b] = capsuleEnds(p);
    const q = closestOnSeg(c, a, b).point;
    const d = Math.max(0, dist(c, q) - PLAYER_RADIUS);
    if (d >= rad) continue;
    const f = falloff(cfg, d / rad);
    const up = localBasis(p.pos).up;
    const dir = knockDir(sub(p.pos, c), up, cfg.liftBias);
    p.vel = addScaled(p.vel, dir, kb * f);
    p.grounded = false;
    p.groundNormal = null;
    const dmg = cfg.explosionDamage * f * (p.id === owner ? cfg.selfDamageScale : 1);
    if (dmg > 0) damagePlayer(state, p, owner, dmg, dmg, 'grenade');
  }
  for (const pr of state.props) {
    const d = Math.max(0, dist(c, pr.pos) - pr.radius);
    if (d >= rad) continue;
    const f = falloff(cfg, d / rad);
    const dir = knockDir(sub(pr.pos, c), localBasis(pr.pos).up, cfg.liftBias);
    pr.vel = addScaled(pr.vel, dir, Math.min(60, kb * f * (PLAYER_MASS / pr.mass)));
    pr.contactNormal = null;
  }
}

export function knockDir(away: Vec3, up: Vec3, liftBias: number): Vec3 {
  const a = len(away) > 1e-6 ? norm(away) : up;
  return norm(addScaled(a, up, liftBias));
}

// =========================================================================== damage / vitals

export function damagePlayer(state: SimState, p: Player, attacker: number, damage: number, shieldDamage: number, cause: string) {
  if (!p.alive) return;
  let healthDmg = damage;
  let shieldBroken = false;
  if (p.shield > 0 && shieldDamage > 0) {
    const absorbed = Math.min(p.shield, shieldDamage);
    p.shield -= absorbed;
    healthDmg = damage * (1 - absorbed / shieldDamage);
    shieldBroken = p.shield <= 0;
  }
  p.health -= healthDmg;
  p.lastDamageTick = state.tick;
  p.lastAttacker = attacker;
  state.events.push({ type: 'hit', target: p.id, attacker, damage, shieldBroken });
  if (p.health <= 0) kill(state, p, attacker, cause);
}

function kill(state: SimState, p: Player, killer: number, cause: string) {
  p.alive = false;
  p.health = 0;
  p.deaths++;
  p.respawnTick = state.tick + secs(state.config.respawnTime);
  const k = state.players.find((q) => q.id === killer);
  if (k && k.id !== p.id) k.kills++;
  state.events.push({ type: 'kill', killer, victim: p.id, cause });
}

function updateVitals(state: SimState, p: Player) {
  const cfg = state.config;
  if (p.alive) {
    if (state.tick - p.lastDamageTick > secs(cfg.shieldRegenDelay) && p.shield < cfg.maxShield)
      p.shield = Math.min(cfg.maxShield, p.shield + cfg.shieldRegenRate * DT);
    let spaced = false;
    despawnIfSpaced(state, p.pos, p.vel, () => (spaced = true));
    if (spaced) kill(state, p, p.lastAttacker >= 0 && state.tick - p.lastDamageTick < secs(15) ? p.lastAttacker : p.id, 'spaced');
    return;
  }
  if (state.tick < p.respawnTick) return;
  // respawn
  const spawns = state.level.spawns;
  let si = p.homeSpawn;
  if (p.kind !== 'dummy') si = rngInt(state, spawns.length);
  p.pos = p.homeSpawn < 0 ? dummyHome(cfg, p.homeSpawn) : spawnPosition(cfg, spawns[si], PLAYER_STAND);
  p.vel = [0, 0, 0];
  p.alive = true;
  p.health = cfg.maxHealth;
  p.shield = cfg.maxShield;
  p.grounded = false;
  p.groundNormal = localBasis(p.pos).up;
  p.rifleHeat = 0; p.rifleOverheatUntil = 0; p.pistolHeat = 0; p.pistolCharge = 0;
  p.grenades = MAX_GRENADES;
  p.lastAttacker = -1;
  state.events.push({ type: 'respawn', id: p.id });
}

