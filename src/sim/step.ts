// The authoritative simulation step. Pure data in, pure data out (mutated in
// place). No DOM, no three.js, no Math.random, no wall clock: the tick counter
// is the only clock and the seeded RNG lives in the state.

import { clamp, closestOnSeg, segSegClosest, segSphere } from './geom';
import { levelSdf, liftOffset, setSdfFrame, sphereTrace, spawnPosition } from './level';
import { apart, convertBody, convertDir, frameOf, frameOmega } from './twin';
import { advanceFree, fictitiousAccel, integrate, localBasis, planetPullAt, setDisk, setPlanet, setSpinAlpha, viewVectors } from './physics';
import { rngInt, rngNext } from './rng';
import {
  BTN_FIRE, BTN_GRENADE, BTN_GRENADE2, BTN_JUMP, BTN_SPRINT, DT, STARTING_WEAPONS, WEAPON_FLAG, WEAPON_HOVER, WEAPON_IDS, WEAPON_LACONIC, BTN_MELEE, BTN_RELOAD,
  omegaOf, spinAt,
  type Bolt, type BoltKind, type Flag, type Grenade, type GrenadeKind, type InputCmd, type ItemKind, type Level, type ThrownKind,
  type Outcome, type Player, type Prop, type SimConfig, type SimState, type Vehicle, type WeaponId, type WeaponStats,
} from './types';
import { type Vec3, add, addScaled, clone, cross, dist, dot, len, norm, rhoOf, scale, sub } from './vec';
import {
  MAX_GRENADES, PLAYER_MASS, addPickup, allocId, capsuleHalfSeg, capsuleRadius, dummyHome, eyeOffset, standHeight,
} from './world';
import { BIKE_MASS, damageVehicle, dismount, handleUse, updateVehicles } from './vehicles';

const secs = (s: number) => Math.round(s / DT);

/**
 * The planet's pull for the tick being stepped (null on most levels). Set at
 * the top of step() from the state, so everything moved this tick feels the
 * same field; it is not carried between ticks.
 */
let pull: Vec3 | null = null;

export const GRENADE_RADIUS = 0.15;
const PISTOL_CHARGE_DELAY = 30; // ticks of holding before the overcharge starts building

/** Which weapon's stats a bolt kind uses. */
export const BOLT_WEAPON: Record<BoltKind, WeaponId> = {
  rifle: 'rifle', redRifle: 'redRifle', pistol: 'pistol', overcharge: 'pistol', fuelRod: 'launcher', cannon: 'cannon', laconic: 'laconic',
  rocket: 'rocket', seeker: 'seeker', pellet: 'scatter', chaos: 'chaos', bullet: 'revolver', hover: 'hover',
};
const WEAPON_BOLT: Record<Exclude<WeaponId, 'hammer' | 'flag'>, BoltKind> = {
  rifle: 'rifle', redRifle: 'redRifle', pistol: 'pistol', launcher: 'fuelRod', cannon: 'cannon', laconic: 'laconic', rocket: 'rocket', seeker: 'seeker', scatter: 'pellet', chaos: 'chaos', revolver: 'bullet', hover: 'hover',
};
/** Bolts that carry their own motor. */
export const isRocket = (kind: BoltKind) => kind === 'rocket' || kind === 'seeker';

/** Muzzle speed, damage, radius and lifetime of a bolt kind, from the live config. */
export function boltStats(cfg: SimConfig, kind: BoltKind) {
  const w = cfg.weapons[BOLT_WEAPON[kind]];
  if (kind === 'overcharge') return { muzzle: w.ocMuzzle, damage: w.ocDamage, shieldDamage: w.ocShieldDamage, radius: 0.45, lifetime: w.lifetime };
  return { muzzle: w.muzzle, damage: w.damage, shieldDamage: w.shieldDamage, radius: w.radius, lifetime: w.lifetime };
}

export function muzzleSpeed(cfg: SimConfig, kind: BoltKind | ThrownKind): number {
  if (kind === 'grenade' || kind === 'bounceGrenade') return cfg.muzzleGrenade;
  return boltStats(cfg, kind).muzzle;
}

/** Where a player's shots originate. */
export function muzzlePoint(p: Player, yaw = p.yaw, pitch = p.pitch, grenade = false): Vec3 {
  const v = viewVectors(p.pos, yaw, pitch);
  const eye = addScaled(p.pos, v.up, eyeOffset(p));
  if (grenade) return addScaled(eye, v.aim, 0.5);
  return add(add(addScaled(eye, v.aim, 0.6), scale(v.right, 0.18)), scale(v.up, -0.12));
}

/**
 * Launch velocity rule: muzzle speed RELATIVE TO THE SHOOTER, in the rotating
 * frame: v = v_player + muzzle * aim. The hover gun is the one exception: it
 * sets v = -omega x r so the bolt is at rest in the inertial frame.
 */
export function launchVelocity(cfg: SimConfig, p: Player, kind: BoltKind | ThrownKind, from: Vec3, yaw = p.yaw, pitch = p.pitch): Vec3 {
  if (kind === 'hover') {
    const w = omegaOf(cfg);
    return [w * from[1], -w * from[0], 0];
  }
  const aim = viewVectors(p.pos, yaw, pitch).aim;
  return addScaled(p.vel, aim, muzzleSpeed(cfg, kind));
}

/** Spawn helpers (also used by tests). A rocket's nose starts along `dir` (default: its velocity). */
export function spawnBolt(state: SimState, owner: number, kind: BoltKind, pos: Vec3, vel: Vec3, dir?: Vec3): Bolt {
  const spec = boltStats(state.config, kind);
  const rocket = isRocket(kind);
  const b: Bolt = {
    id: allocId(state), type: 'bolt', kind, owner, pos: clone(pos), vel: clone(vel), launchVel: clone(vel),
    radius: spec.radius, damage: spec.damage, shieldDamage: spec.shieldDamage,
    armed: owner < 0, spawnTick: state.tick, expireTick: state.tick + secs(Math.min(spec.lifetime, state.config.projectileLifetime)),
    dir: rocket ? norm(dir ?? vel) : null,
    burnUntil: rocket ? state.tick + 1 + secs(state.config.weapons[BOLT_WEAPON[kind]].burnTime) : 0, // (it first moves next tick)
    target: -1,
    speed: spec.muzzle,
  };
  state.bolts.push(b);
  return b;
}

export function spawnGrenade(state: SimState, owner: number, pos: Vec3, vel: Vec3, variant: GrenadeKind = 'sticky'): Grenade {
  const g: Grenade = {
    id: allocId(state), type: 'grenade', variant, owner, pos: clone(pos), vel: clone(vel), launchVel: clone(vel),
    radius: GRENADE_RADIUS, armed: owner < 0, stuck: null, contactNormal: null,
    // sticky: fuse starts when it sticks; bouncing: fuse starts at the throw
    fuseTick: variant === 'bounce' ? state.tick + secs(state.config.bounceFuse) : -1,
    spawnTick: state.tick, expireTick: state.tick + secs(state.config.projectileLifetime),
  };
  state.grenades.push(g);
  return g;
}

const capsuleEnds = (p: Player): [Vec3, Vec3] => {
  const up = localBasis(p.pos).up;
  const h = capsuleHalfSeg(p);
  return [addScaled(p.pos, up, -h), addScaled(p.pos, up, h)];
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
  const spin = spinAt(cfg, state.tick);
  const omega = spin.omega;
  setSpinAlpha(spin.alpha);
  setPlanet(cfg.world === 'planet' ? cfg.g * cfg.R * cfg.R : 0, omega);
  setDisk(cfg.world === 'disk' ? cfg.g : 0, omega);
  pull = planetPullAt(cfg, state.frameAngle);
  state.events = [];
  moveLifts(state);

  const byPlayer = new Map<number, InputCmd>();
  for (const cmd of inputs) byPlayer.set(cmd.playerId, cmd);

  // 1. inputs -> players (stable id order)
  for (const p of state.players) {
    const cmd = byPlayer.get(p.id);
    p.lastInput = cmd ? { ...cmd, tick } : { ...p.lastInput, tick };
  }

  // 2. player motion (E gets on/off bikes; riders move with their bike)
  for (const p of state.players) handleUse(state, p);
  for (const p of state.players) if (p.alive && p.vehicle < 0) inFrame(state, omega, p, (w) => movePlayer(state, p, w));
  updateVehicles(state, omega);
  collidePlayers(state);

  // 3. props
  for (const pr of state.props) inFrame(state, omega, pr, (w) => moveProp(state, pr, w));
  collideProps(state);

  // 4. weapons (spawned projectiles start moving next tick; their state at the
  //    end of this tick is exactly the launch state)
  for (const p of state.players) if (p.alive) { setSdfFrame(frameOf(cfg, p.pos), state.frameAngle); updateWeapons(state, p, omega); }

  // 5. projectiles
  updateBolts(state, omega);
  updateGrenades(state, omega);
  state.explosions = state.explosions.filter((e) => tick < e.endTick);

  // 6. vitals / respawn, then item pickups
  for (const p of state.players) updateVitals(state, p);
  updatePickups(state);
  if (state.flags.length) updateFlags(state, omega);
  if (state.mode === 'campaign') updateOutcome(state);
  for (const p of state.players) p.prevButtons = p.lastInput.buttons;

  state.tick++;
  state.frameAngle += omega * DT;
  return state;
}

/**
 * Run a body's update in the frame of the ring it's over (twin rings: with
 * that ring's spin and geometry), then, if it has crossed the seam, convert it
 * into the other ring's frame. A no-op wrapper on ordinary levels.
 */
function inFrame(state: SimState, omega: number, b: { pos: Vec3; vel: Vec3; dir?: Vec3 | null }, update: (w: number) => void) {
  const cfg = state.config;
  if (!cfg.twin) { update(omega); return; }
  const f = frameOf(cfg, b.pos);
  setSdfFrame(f, state.frameAngle);
  update(frameOmega(omega, f));
  const g = frameOf(cfg, b.pos);
  if (g !== f) {
    // its new position is for the end of this tick, when ring 0 has turned on by omega DT
    const th = state.frameAngle + omega * DT;
    convertBody(b.pos, b.vel, f, g, th, omega);
    if (b.dir) b.dir = convertDir(b.dir, f, g, th);
  }
}

// =========================================================================== players

function movePlayer(state: SimState, p: Player, omega: number) {
  const cfg = state.config;
  const tick = state.tick;
  const inp = p.lastInput;
  p.yaw = inp.yaw;
  p.pitch = clamp(inp.pitch, -1.55, 1.55);
  const pressed = inp.buttons & ~p.prevButtons;
  // launch pads: standing on one throws you (relative to the ground under it)
  if (p.grounded && state.level.pads) {
    for (const pad of state.level.pads) {
      if (dist(p.pos, pad.pos) > 1.2 + standHeight(p.size)) continue;
      p.vel = pad.exact ? scale(pad.up, pad.speed) : addScaled(sub(p.vel, scale(pad.up, dot(p.vel, pad.up))), pad.up, pad.speed);
      p.grounded = false;
      p.groundNormal = null;
      p.lastJumpTick = tick;
      state.events.push({ type: 'pad', id: p.id, pos: clone(pad.pos) });
      break;
    }
  }
  const vv = viewVectors(p.pos, p.yaw, 0);
  let mx = clamp(inp.moveX, -1, 1), my = clamp(inp.moveY, -1, 1);
  const ml = Math.hypot(mx, my);
  if (ml > 1) { mx /= ml; my /= ml; }
  // Charging or firing the Laconic Laser slows you right down.
  const chargeSlow = isLaconicBusy(p, tick) ? cfg.weapons.laconic.chargeMoveScale : 1;

  if (p.grounded && p.groundNormal) {
    // On the ground, input sets velocity RELATIVE TO THE FLOOR (which is the
    // rotating-frame velocity, since the floor is static in this frame).
    const n = p.groundNormal;
    const sprint = (inp.buttons & BTN_SPRINT) !== 0 && my > 0.3;
    const speed = (sprint ? cfg.sprintSpeed : cfg.walkSpeed) * chargeSlow * p.speedScale;
    let wish = add(scale(vv.forward, my * speed), scale(vv.right, mx * speed));
    wish = sub(wish, scale(n, dot(wish, n)));
    const vn = dot(p.vel, n);
    const vt = sub(p.vel, scale(n, vn));
    const dv = sub(wish, vt);
    const sliding = len(vt) > cfg.sprintSpeed + 1.5;
    const maxDv = (sliding ? cfg.slideDecel : cfg.groundAccel) * DT;
    const dvl = len(dv);
    p.vel = add(p.vel, dvl > maxDv ? scale(dv, maxDv / dvl) : dv);
  } else if (ml > 0.01) {
    // Air control: accelerate along the wish direction, but only up to walk speed.
    const up = vv.up;
    let wish = add(scale(vv.forward, my), scale(vv.right, mx));
    wish = norm(sub(wish, scale(up, dot(wish, up))));
    const along = dot(p.vel, wish);
    const add_ = Math.min(cfg.airAccel * DT, Math.max(0, cfg.walkSpeed * Math.min(1, ml) - along));
    if (add_ > 0) p.vel = addScaled(p.vel, wish, add_);
  }

  // Jump: an impulse along local up. Fictitious forces do the rest, so jump
  // height and drift depend on direction of motion. A short "coyote time"
  // keeps jumps working just after leaving a surface.
  const canJump = p.grounded || (tick - p.lastGroundTick <= secs(cfg.coyoteTime) && p.lastJumpTick < p.lastGroundTick);
  let jumped = false;
  if (pressed & BTN_JUMP && canJump) {
    p.vel = addScaled(p.vel, vv.up, cfg.jumpSpeed);
    p.grounded = false;
    p.groundNormal = null;
    p.lastJumpTick = tick;
    jumped = true;
    state.events.push({ type: 'jump', id: p.id });
  }

  // Jetpack: hold jump while airborne.
  p.jetting = false;
  if (!p.grounded && !jumped && p.hasJetpack && p.jetFuel > 0 && inp.buttons & BTN_JUMP) {
    let lateral = add(scale(vv.forward, my), scale(vv.right, mx));
    if (len(lateral) > 1) lateral = norm(lateral);
    p.vel = addScaled(addScaled(p.vel, vv.up, cfg.jetThrust * DT), lateral, cfg.jetLateral * DT);
    p.jetFuel = Math.max(0, p.jetFuel - cfg.jetBurn * DT);
    p.jetting = true;
  }

  const support = p.grounded ? p.groundNormal : null;
  const v0 = clone(p.vel);
  const r0 = clone(p.pos);
  const n = clamp(Math.ceil((len(p.vel) * DT) / 0.2), 1, 24);
  const h = DT / n;
  let ground: Vec3 | null = null;
  let impact = 0;
  for (let i = 0; i < n; i++) {
    integrate(p.pos, p.vel, h, omega, cfg, support, pull);
    const res = resolvePlayerLevel(state, p);
    if (res.ground) ground = res.ground;
    impact = Math.max(impact, res.impact);
  }
  p.grounded = ground !== null;
  p.groundNormal = ground;
  if (ground) p.lastGroundTick = tick;

  // Apparent weight = the normal force per unit mass, measured from what the
  // contact actually did this tick (includes the floor's curvature):
  // N = dv.n/dt - a_fictitious.n. Airborne = weightless.
  let target = 0;
  if (ground && !jumped) {
    const a = fictitiousAccel(r0, v0, omega, cfg, pull);
    target = Math.max(0, dot(sub(p.vel, v0), ground) / DT - dot(a, ground)) / cfg.g;
  }
  p.apparentG += (target - p.apparentG) * 0.12;

  // Slamming into something fast hurts.
  if (impact > cfg.impactDamageSpeed) {
    const dmg = (impact - cfg.impactDamageSpeed) * cfg.impactDamagePerMs;
    const credit = p.lastAttacker >= 0 && tick - p.lastDamageTick < secs(10) ? p.lastAttacker : p.id;
    state.events.push({ type: 'bodyImpact', id: p.id, pos: clone(p.pos), speed: impact });
    damagePlayer(state, p, credit, dmg, dmg, 'impact');
  }
}

/** Push the capsule (3 spheres) out of the level. Returns a walkable ground normal if touching one, and the impact speed. */
function resolvePlayerLevel(state: SimState, p: Player): { ground: Vec3 | null; impact: number } {
  const cfg = state.config;
  let ground: Vec3 | null = null;
  let impact = 0;
  let bestUp = 0.6;
  for (let iter = 0; iter < 3; iter++) {
    const up = localBasis(p.pos).up;
    let any = false;
    for (let k = -1; k <= 1; k++) {
      const c = addScaled(p.pos, up, k * capsuleHalfSeg(p));
      const hit = levelSdf(state.level, cfg, c);
      const gap = hit.d - capsuleRadius(p);
      if (gap < 0.004) {
        if (gap < 0) {
          p.pos = addScaled(p.pos, hit.n, -gap);
          any = true;
        }
        const vn = dot(p.vel, hit.n);
        if (vn < 0) {
          p.vel = addScaled(p.vel, hit.n, -vn);
          impact = Math.max(impact, -vn);
        }
        const u = dot(hit.n, up);
        if (u > bestUp) { bestUp = u; ground = hit.n; }
      }
      if (k === -1 && !ground) {
        // Wedged against a wall, the nearest surface to the foot can be the wall
        // even while standing on the floor: probe a touch lower to find the floor.
        const probe = levelSdf(state.level, cfg, addScaled(c, up, -0.03));
        if (probe.d - capsuleRadius(p) < 0.004 + 0.03 && dot(probe.n, up) > bestUp) { bestUp = dot(probe.n, up); ground = probe.n; }
      }
    }
    if (!any) break;
  }
  return { ground, impact };
}

function collidePlayers(state: SimState) {
  const ps = state.players;
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i];
    if (!a.alive || a.vehicle >= 0) continue;
    for (let j = i + 1; j < ps.length; j++) {
      const b = ps[j];
      if (!b.alive || b.vehicle >= 0) continue;
      if (apart(state.config, a.pos, b.pos) || dist(a.pos, b.pos) > 3) continue;
      const [a0, a1] = capsuleEnds(a), [b0, b1] = capsuleEnds(b);
      const c = segSegClosest(a0, a1, b0, b1);
      const minD = capsuleRadius(a) + capsuleRadius(b);
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

export interface SphereBody {
  pos: Vec3;
  vel: Vec3;
  radius: number;
  contactNormal: Vec3 | null;
}

/**
 * Move a bouncy sphere against the static level for one tick: sub-stepped
 * integration (with a support force while resting/sliding), discrete push-out,
 * restitution + Coulomb friction. Shared by props, bouncing grenades and the
 * bouncing-grenade trajectory preview. Returns the largest impact speed.
 */
export function moveSphereBody(
  level: Level, cfg: SimConfig, omega: number, b: SphereBody, restitution: number, dt = DT, extra: Vec3 | null = pull, mu = cfg.friction,
  onImpact?: (speed: number, n: Vec3) => void,
): number {
  const support = b.contactNormal;
  const n = clamp(Math.ceil((len(b.vel) * dt) / (0.4 * b.radius)), 1, 32);
  const h = dt / n;
  let contact: Vec3 | null = null;
  let maxImpact = 0;
  for (let i = 0; i < n; i++) {
    integrate(b.pos, b.vel, h, omega, cfg, support, extra);
    for (let iter = 0; iter < 2; iter++) {
      const hit = levelSdf(level, cfg, b.pos);
      const gap = hit.d - b.radius;
      if (gap >= 0.002) break;
      if (gap < 0) {
        const before = b.pos;
        b.pos = addScaled(b.pos, hit.n, -gap);
        conserveJacobi(b.vel, before, b.pos, omega, cfg);
      }
      const vn = dot(b.vel, hit.n);
      if (vn < 0) {
        maxImpact = Math.max(maxImpact, -vn);
        onImpact?.(-vn, hit.n);
        reflect(b.vel, hit.n, vn, -vn > 1.5 ? restitution : 0, mu);
      }
      // Only a resting/sliding contact supports the body next tick; one it is
      // bouncing away from must not cancel the centrifugal force.
      if (Math.abs(dot(b.vel, hit.n)) < 0.25) contact = hit.n;
      if (gap >= 0) break;
    }
  }
  // rolling resistance while in contact (none for frictionless bodies)
  if (contact && mu > 0) {
    const vn = dot(b.vel, contact);
    const vt = sub(b.vel, scale(contact, vn));
    const l = len(vt);
    if (l > 0) b.vel = add(scale(contact, vn), scale(vt, Math.max(0, l - 1.0 * dt) / l));
  }
  b.contactNormal = contact;
  return maxImpact;
}

/** Reflect v (in place) off a surface with normal n, given vn = v.n < 0. Coulomb friction on the tangential part. */
function reflect(v: Vec3, n: Vec3, vn: number, e: number, mu: number) {
  const vt = sub(v, scale(n, vn));
  const vtl = len(vt);
  const jn = (1 + e) * -vn;
  const f = vtl > 0 ? Math.max(0, vtl - mu * jn) / vtl : 0;
  v[0] = vt[0] * f - n[0] * vn * e;
  v[1] = vt[1] * f - n[1] * vn * e;
  v[2] = vt[2] * f - n[2] * vn * e;
}

function moveProp(state: SimState, pr: Prop, omega: number) {
  const impact = moveSphereBody(state.level, state.config, omega, pr, state.config.restitution);
  if (impact > 3) state.events.push({ type: 'bodyImpact', id: pr.id, pos: clone(pr.pos), speed: impact });
  despawnIfSpaced(state, pr.pos, pr.vel, () => (pr.radius = -1), state.config.fallKillDistance);
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
      const d = len(dv), minD = a.radius + capsuleRadius(p);
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
function despawnIfSpaced(state: SimState, pos: Vec3, vel: Vec3, kill: () => void, margin = 4) {
  const cfg = state.config;
  if (cfg.world === 'disk') {
    // fallen off: well below the disk, or far out, and still going
    if ((pos[2] < -150 && vel[2] < 0) || (rhoOf(pos) > 3 * cfg.R && dot(pos, vel) > 0)) kill();
    return;
  }
  if (cfg.tower > 0) {
    // flung off the tower: out past the bottom floor, or off the end of it along the axis, and still going
    if ((rhoOf(pos) > cfg.R + 10 && dot([pos[0], pos[1], 0], vel) > 0) || (Math.abs(pos[2]) > cfg.R && pos[2] * vel[2] > 0)) kill();
    return;
  }
  if (cfg.world === 'planet') {
    if (cfg.outerShell > 0) return; // shut in by the shell: nothing gets away
    // gone for good: well out and still climbing (escape speed is only sqrt(2gR))
    if (Math.hypot(pos[0], pos[1], pos[2]) > 4 * cfg.R && dot(pos, vel) > 0) kill();
    return;
  }
  const zLim = cfg.halfWidth + cfg.wallThickness + margin;
  if ((Math.abs(pos[2]) > zLim && pos[2] * vel[2] > 0) || rhoOf(pos) > cfg.R + cfg.hullThickness + margin) kill();
}

/** Distance by which a point lies outside the ring band (0 if inside it). */
export function distanceOffRing(cfg: SimConfig, pos: Vec3): number {
  if (cfg.world === 'disk') return Math.max(0, -pos[2] - 20, rhoOf(pos) - (cfg.R + 30)); // off the edge and falling
  if (cfg.tower > 0) return Math.max(0, rhoOf(pos) - (cfg.R + 10), Math.abs(pos[2]) - cfg.R); // off the tower, into space
  if (cfg.world === 'planet') return cfg.outerShell > 0 ? 0 : Math.max(0, Math.hypot(pos[0], pos[1], pos[2]) - 3 * cfg.R); // flung off into space
  if (cfg.tube === 'outside') {
    // how far off the log's surface
    return Math.max(0, Math.hypot(rhoOf(pos) - (cfg.R + cfg.tubeRadius), pos[2]) - cfg.tubeRadius);
  }
  if (cfg.tube === 'inside') return 0; // closed: nowhere to fall
  const dz = Math.abs(pos[2]) - (cfg.halfWidth + cfg.wallThickness);
  const dr = rhoOf(pos) - (cfg.R + cfg.hullThickness);
  return Math.max(0, dz, dr);
}

// =========================================================================== weapons

/** True while the Laconic Laser is charging or streaming (movement and aim are slowed). */
export const isLaconicBusy = (p: Player, tick: number) => p.weapon === WEAPON_LACONIC && (p.charge > 0 || tick < p.burstUntil);

export const isOwned = (cfg: SimConfig, p: Player, w: number) => p.owned.includes(w) || (w === WEAPON_HOVER && cfg.allowHoverGun);

function updateWeapons(state: SimState, p: Player, omega: number) {
  const cfg = state.config;
  const tick = state.tick;
  const inp = p.lastInput;
  const btn = inp.buttons;
  const pressed = btn & ~p.prevButtons;
  const released = p.prevButtons & ~btn;
  const bursting = tick < p.burstUntil;

  // Switch to the requested weapon if we own it (not mid-stream).
  if (!bursting && p.carrying < 0 && inp.weapon !== p.weapon && inp.weapon >= 0 && inp.weapon < WEAPON_IDS.length && isOwned(cfg, p, inp.weapon)) {
    p.weapon = inp.weapon;
    p.charge = 0;
    p.holdTicks = 0;
    p.needRelease = false;
    p.fireReadyTick = Math.max(p.fireReadyTick, tick + secs(0.25));
  }
  if (!isOwned(cfg, p, p.weapon)) p.weapon = p.owned[0] ?? 0;
  if (p.carrying >= 0) p.weapon = WEAPON_FLAG; // (you hold the flag until you drop it)

  const wi = p.weapon;
  const id = WEAPON_IDS[wi];
  const st = cfg.weapons[id];
  const held = (btn & BTN_FIRE) !== 0;
  const locked = tick < p.overheatUntil[wi];
  const usesAmmo = st.magSize > 0;

  // Reloading: finish (a reload carries on if you switch away), or start one
  // (R, or automatically on an empty magazine).
  if (p.reloadUntil && tick >= p.reloadUntil) {
    const rw = p.reloadWeapon >= 0 ? p.reloadWeapon : wi;
    const want = cfg.weapons[WEAPON_IDS[rw]].magSize - p.mag[rw];
    const got = Math.max(0, p.infiniteAmmo ? want : Math.min(want, p.ammo[rw]));
    p.mag[rw] += got;
    if (!p.infiniteAmmo) p.ammo[rw] -= got;
    p.reloadUntil = 0;
    p.reloadWeapon = -1;
  }
  if (usesAmmo) {
    const canReload = p.mag[wi] < st.magSize && (p.infiniteAmmo || p.ammo[wi] > 0);
    if (!p.reloadUntil && canReload && (p.mag[wi] === 0 || pressed & BTN_RELOAD)) {
      p.reloadUntil = tick + Math.max(1, secs(st.reloadTime));
      p.reloadWeapon = wi;
      state.events.push({ type: 'reload', id: p.id });
    }
  }
  const reloading = p.reloadUntil > 0 && p.reloadWeapon === wi;
  const hasAmmo = !usesAmmo || p.mag[wi] > 0;
  const ready = tick >= p.fireReadyTick && !locked && !reloading && hasAmmo && p.heat[wi] < 1;

  // Passive cooling (the active weapon doesn't cool while its trigger is held or it is streaming).
  for (let i = 0; i < WEAPON_IDS.length; i++) {
    if (i === wi && ((held && !locked) || bursting)) continue;
    const ws = cfg.weapons[WEAPON_IDS[i]];
    const rate = tick < p.overheatUntil[i] ? 1 / Math.max(0.1, ws.overheatLock) : ws.coolRate;
    p.heat[i] = Math.max(0, p.heat[i] - rate * DT);
  }

  const shoot = (kind: BoltKind, heat: number, interval: number) => {
    fireBolt(state, p, kind);
    p.fireReadyTick = tick + Math.max(1, secs(interval));
    if (usesAmmo) p.mag[wi]--;
    if (heat > 0) {
      p.heat[wi] += heat;
      if (p.heat[wi] >= 1 - 1e-9) {
        p.heat[wi] = 1;
        p.overheatUntil[wi] = tick + secs(st.overheatLock);
        state.events.push({ type: 'overheat', id: p.id });
      }
    }
  };

  switch (id) {
    case 'rifle':
    case 'redRifle':
    case 'seeker': // hold for a stream of homing rockets
    case 'chaos':
      if (held && ready) shoot(WEAPON_BOLT[id], st.heatPerShot, st.interval);
      break;
    case 'launcher':
    case 'cannon':
    case 'rocket':
    case 'scatter':
    case 'revolver':
    case 'hover':
      if (pressed & BTN_FIRE && ready) shoot(WEAPON_BOLT[id], st.heatPerShot, st.interval);
      break;
    case 'pistol':
      // Tap to fire; keep holding to build an overcharge, release to let it go.
      if (pressed & BTN_FIRE) {
        p.holdTicks = 0;
        p.charge = 0;
        if (ready) shoot('pistol', st.heatPerShot, st.interval);
      } else if (held) {
        p.holdTicks++;
        if (p.holdTicks > PISTOL_CHARGE_DELAY && p.heat[wi] < 1) p.charge = Math.min(1, p.charge + DT / Math.max(0.05, st.chargeTime));
      }
      if (released & BTN_FIRE) {
        if (p.charge >= 1 && !locked) shoot('overcharge', st.ocHeat, 0.4);
        p.charge = 0;
        p.holdTicks = 0;
      }
      break;
    case 'flag':
      // the flag: swung like the mallet, but much weaker
      if (pressed & BTN_FIRE && ready) {
        p.fireReadyTick = tick + Math.max(1, secs(st.interval));
        swing(state, p, st.damage, st.knockback, st.blastRadius, 0.25, 'flag', true);
      }
      break;
    case 'hammer':
      // Swing: hits everyone in a wide arc in front of you.
      if (pressed & BTN_FIRE && ready) {
        p.fireReadyTick = tick + Math.max(1, secs(st.interval));
        swing(state, p, st.damage, st.knockback, st.blastRadius, 0.25, 'mallet', true);
      }
      break;
    case 'laconic':
      // Hold to charge; once charged it streams for burstTime whether you hold or not.
      if (bursting) {
        if (tick >= p.fireReadyTick) shoot('laconic', st.heatPerShot, st.interval);
        if (tick + 1 >= p.burstUntil) { p.heat[wi] = 1; p.overheatUntil[wi] = tick + secs(st.overheatLock); }
        break;
      }
      if (!held) { p.charge = 0; p.needRelease = false; break; }
      if (p.needRelease || !ready) { p.charge = 0; break; }
      p.charge = Math.min(1, p.charge + DT / Math.max(0.05, st.chargeTime));
      if (p.charge >= 1) {
        p.charge = 0;
        p.needRelease = true;
        p.burstUntil = tick + Math.max(1, secs(st.burstTime));
        shoot('laconic', st.heatPerShot, st.interval);
      }
      break;
  }

  // Melee (any weapon): a short-range shove with a lot of knockback. Holding the flag, Q tosses it instead.
  if (pressed & BTN_MELEE && p.carrying >= 0) dropFlag(state, p, true);
  else if (pressed & BTN_MELEE && tick >= p.meleeReadyTick && !bursting) melee(state, p);

  // Grenade: hold to aim (client shows preview), release to throw.
  if (released & BTN_GRENADE && p.grenades > 0 && tick >= p.grenadeReadyTick) {
    const from = muzzlePoint(p, p.yaw, p.pitch, true);
    spawnGrenade(state, p.id, from, launchVelocity(cfg, p, 'grenade', from));
    p.grenades--;
    p.grenadeReadyTick = tick + secs(0.6);
    state.events.push({ type: 'fire', owner: p.id, kind: 'grenade', pos: from });
  } else if (released & BTN_GRENADE2 && p.bounceGrenades > 0 && tick >= p.grenadeReadyTick) {
    const from = muzzlePoint(p, p.yaw, p.pitch, true);
    spawnGrenade(state, p.id, from, launchVelocity(cfg, p, 'bounceGrenade', from), 'bounce');
    p.bounceGrenades--;
    p.grenadeReadyTick = tick + secs(0.6);
    state.events.push({ type: 'fire', owner: p.id, kind: 'bounceGrenade', pos: from });
  }
  void omega;
}

function melee(state: SimState, p: Player) {
  const cfg = state.config;
  p.meleeReadyTick = state.tick + secs(cfg.meleeCooldown);
  swing(state, p, cfg.meleeDamage, cfg.meleeKnockback, cfg.meleeRange, 0.4, 'melee', false);
}

/**
 * A close-range blow in front of `p`: damage plus a big kick along the aim
 * (with some lift). `all` hits everyone in the arc, otherwise just the nearest.
 */
function swing(state: SimState, p: Player, damage: number, knockback: number, reach: number, minDot: number, cause: string, all: boolean) {
  const cfg = state.config;
  const v = viewVectors(p.pos, p.yaw, p.pitch);
  const eye = addScaled(p.pos, v.up, eyeOffset(p) * 0.5);
  const kick = norm(addScaled(v.aim, v.up, cfg.liftBias));
  const hits: Player[] = [];
  let nearest: Player | null = null;
  let bestD = Infinity;
  for (const q of state.players) {
    if (q.id === p.id || !q.alive || apart(state.config, q.pos, p.pos)) continue;
    const [a, b] = capsuleEnds(q);
    const to = sub(closestOnSeg(eye, a, b).point, eye);
    const d = len(to) - capsuleRadius(q);
    if (d > reach || dot(norm(to), v.aim) < minDot) continue;
    hits.push(q);
    if (d < bestD) { bestD = d; nearest = q; }
  }
  for (const q of all ? hits : nearest ? [nearest] : []) {
    q.vel = addScaled(q.vel, kick, knockback);
    q.grounded = false;
    q.groundNormal = null;
    damagePlayer(state, q, p.id, damage, damage, cause);
  }
  for (const pr of state.props) {
    const to = sub(pr.pos, eye);
    if (len(to) - pr.radius > reach || dot(norm(to), v.aim) < minDot) continue;
    pr.vel = addScaled(pr.vel, kick, Math.min(60, knockback * (PLAYER_MASS / pr.mass)));
    pr.contactNormal = null;
  }
  if (all) {
    // the mallet hits everything in the arc: bikes...
    for (const vh of state.vehicles) {
      if (!vh.alive || vh.driver === p.id) continue;
      const to = sub(vh.pos, eye);
      if (len(to) - vh.radius > reach || dot(norm(to), v.aim) < minDot) continue;
      vh.vel = addScaled(vh.vel, kick, knockback * (PLAYER_MASS / BIKE_MASS));
      vh.contactNormal = null;
      damageVehicle(state, vh, p.id, damage);
    }
    // ...and loose grenades, batted away along your aim (they're yours now)
    for (const g of state.grenades) {
      if (g.stuck) continue;
      const to = sub(g.pos, eye);
      if (len(to) > reach + 0.5 || dot(norm(to), v.aim) < minDot) continue;
      g.vel = addScaled(p.vel, v.aim, Math.max(25, knockback));
      g.owner = p.id;
      g.armed = true;
      g.contactNormal = null;
    }
  }
  state.events.push({
    type: 'melee', id: p.id, target: nearest?.id ?? -1, pos: addScaled(eye, v.aim, reach * 0.6),
    mallet: all, from: eye, aim: v.aim, up: v.up, reach, cone: minDot,
  });
}

function fireBolt(state: SimState, p: Player, kind: BoltKind) {
  const ws = state.config.weapons[BOLT_WEAPON[kind]];
  if (ws.spread > 0 || ws.muzzleMin > 0) return fireSpread(state, p, kind, ws);
  const from = muzzlePoint(p);
  // a rocket's nose points where you aim, whatever your own motion adds to its launch velocity
  const b = spawnBolt(state, p.id, kind, from, launchVelocity(state.config, p, kind, from), viewVectors(p.pos, p.yaw, p.pitch).aim);
  // the pistol's overcharged shot picks a target at launch (someone near where you aimed)
  if (kind === 'overcharge') b.target = seekTarget(state, b, viewVectors(p.pos, p.yaw, p.pitch).aim, ws)?.id ?? -1;
  state.events.push({ type: 'fire', owner: p.id, kind, pos: from });
}

// =========================================================================== projectiles

interface SweepHit {
  s: number;
  pos: Vec3;
  player: Player | null;
  prop: Prop | null;
  vehicle?: Vehicle;
}

/** Sweep a small sphere over p0->p1 against level (optional), players and props; earliest hit wins. */
function sweep(state: SimState, p0: Vec3, p1: Vec3, radius: number, owner: number, armed: boolean, withLevel = true): SweepHit | null {
  let best: SweepHit | null = null;
  const lh = withLevel ? sphereTrace(state.level, state.config, p0, p1, radius) : null;
  if (lh) best = { s: lh.s, pos: lh.pos, player: null, prop: null };
  const segLen = dist(p0, p1);
  for (const pl of state.players) {
    if (!pl.alive || (pl.id === owner && !armed)) continue;
    if (apart(state.config, pl.pos, p0) || dist(pl.pos, p0) > segLen + 3) continue;
    const [a, b] = capsuleEnds(pl);
    const c = segSegClosest(p0, p1, a, b);
    const rr = radius + capsuleRadius(pl);
    if (c.d2 < rr * rr && (!best || c.s < best.s)) {
      best = { s: c.s, pos: addScaled(p0, sub(p1, p0), c.s), player: pl, prop: null };
    }
  }
  for (const pr of state.props) {
    const s = segSphere(p0, p1, pr.pos, pr.radius + radius);
    if (s !== null && (!best || s < best.s)) best = { s, pos: addScaled(p0, sub(p1, p0), s), player: null, prop: pr };
  }
  for (const v of state.vehicles) {
    if (!v.alive) continue;
    // a rider's own bike doesn't block their shots until the bolt is clear of them
    const riderOwn = state.players.some((q) => q.id === owner && q.vehicle === v.id);
    if (riderOwn && !armed) continue;
    const s = segSphere(p0, p1, v.pos, v.radius + radius);
    if (s !== null && (!best || s < best.s)) best = { s, pos: addScaled(p0, sub(p1, p0), s), player: null, prop: null, vehicle: v };
  }
  return best;
}

function stillInsideOwner(state: SimState, pos: Vec3, radius: number, owner: number): boolean {
  const pl = state.players.find((q) => q.id === owner);
  if (!pl || !pl.alive) return false;
  const [a, b] = capsuleEnds(pl);
  return dist(closestOnSeg(pos, a, b).point, pos) < radius + capsuleRadius(pl) + 0.05;
}

function updateBolts(state: SimState, omega: number) {
  const cfg = state.config;
  const keep: Bolt[] = [];
  for (const b of state.bolts) {
    if (b.spawnTick === state.tick) { keep.push(b); continue; }
    const ws = cfg.weapons[BOLT_WEAPON[b.kind]];
    if (state.tick >= b.expireTick) {
      // rockets blow up when they time out; plasma just fizzles
      if (b.dir && ws.blastRadius > 0) detonate(state, b.pos, b.owner, b.id, { radius: ws.blastRadius, damage: ws.blastDamage, knockback: ws.blastKnockback }, b.kind);
      continue;
    }
    const p0 = clone(b.pos);
    const f = frameOf(cfg, b.pos);
    setSdfFrame(f, state.frameAngle);
    const w = frameOmega(omega, f);
    if (b.dir) moveRocket(state, b, ws, w);
    else {
      advanceFree(b.pos, b.vel, DT, w, cfg, pull);
      if (b.kind === 'overcharge' && b.target >= 0) steerBolt(state, b, ws);
    }
    const hit = sweep(state, p0, b.pos, b.radius, b.owner, b.armed);
    if (!hit && cfg.twin && frameOf(cfg, b.pos) !== f) {
      const th = state.frameAngle + omega * DT; // (its new position is for the end of the tick)
      const g = frameOf(cfg, b.pos);
      convertBody(b.pos, b.vel, f, g, th, omega);
      if (b.dir) b.dir = convertDir(b.dir, f, g, th);
    }
    if (hit) {
      if (hit.player) {
        // every hit gives a small kick along the bolt's path (relative to the target)
        const kb = cfg.weapons[BOLT_WEAPON[b.kind]].knockback * (b.kind === 'overcharge' ? 4 : 1);
        if (kb > 0) hit.player.vel = addScaled(hit.player.vel, norm(sub(b.vel, hit.player.vel)), kb);
        damagePlayer(state, hit.player, b.owner, b.damage, b.shieldDamage, b.kind);
        if (b.kind === 'seeker') supercombine(state, hit.player, b.owner);
      } else if (hit.vehicle) {
        const kb = cfg.weapons[BOLT_WEAPON[b.kind]].knockback * (PLAYER_MASS / BIKE_MASS);
        hit.vehicle.vel = addScaled(hit.vehicle.vel, norm(sub(b.vel, hit.vehicle.vel)), kb);
        damageVehicle(state, hit.vehicle, b.owner, b.damage);
      } else if (hit.prop) {
        const k = (b.kind === 'overcharge' ? 4 : 0.6) / hit.prop.mass;
        hit.prop.vel = addScaled(hit.prop.vel, sub(b.vel, hit.prop.vel), k);
        hit.prop.contactNormal = null;
      }
      state.events.push({ type: 'impact', pos: hit.pos, kind: b.kind, target: hit.player?.id ?? hit.prop?.id ?? hit.vehicle?.id ?? -1, owner: b.owner });
      if (ws.blastRadius > 0 && (b.kind === 'fuelRod' || b.dir)) {
        detonate(state, hit.pos, b.owner, b.id, { radius: ws.blastRadius, damage: ws.blastDamage, knockback: ws.blastKnockback }, b.kind === 'fuelRod' ? 'fuel rod' : b.kind);
      }
      continue;
    }
    if (!b.armed && !stillInsideOwner(state, b.pos, b.radius, b.owner)) b.armed = true;
    let dead = false;
    despawnIfSpaced(state, b.pos, b.vel, () => (dead = true));
    if (!dead) keep.push(b);
  }
  state.bolts = keep;
}

/**
 * Shots with a spread (each pellet somewhere in a cone round your aim) and/or
 * a random speed. Uses the sim's own seeded RNG, so replays are exact.
 */
function fireSpread(state: SimState, p: Player, kind: BoltKind, ws: WeaponStats) {
  const v = viewVectors(p.pos, p.yaw, p.pitch);
  const from = muzzlePoint(p);
  const upA = cross(v.right, v.aim); // perpendicular to the aim, roughly "up"
  const maxT = (ws.spread * Math.PI) / 180;
  for (let i = 0; i < Math.max(1, ws.pellets); i++) {
    const t = maxT * Math.sqrt(rngNext(state)), phi = 2 * Math.PI * rngNext(state); // uniform over the cone's disc
    const off = add(scale(v.right, Math.cos(phi)), scale(upA, Math.sin(phi)));
    const dir = norm(add(scale(v.aim, Math.cos(t)), scale(off, Math.sin(t))));
    const speed = ws.muzzleMin > 0 ? ws.muzzleMin + (ws.muzzle - ws.muzzleMin) * rngNext(state) : ws.muzzle;
    const b = spawnBolt(state, p.id, kind, from, addScaled(p.vel, dir, speed));
    b.speed = speed;
  }
  state.events.push({ type: 'fire', owner: p.id, kind, pos: from });
}

/**
 * Lifts move on a fixed schedule. Anyone standing on one moves with it (the
 * level push-out alone would leave you hopping as it goes down).
 */
function moveLifts(state: SimState) {
  const t = (state.tick + 1) * DT;
  for (const b of state.level.boxes) {
    if (!b.lift) continue;
    const up = localBasis(b.lift.base).up;
    const next = addScaled(b.lift.base, up, liftOffset(b.lift, t));
    const delta = sub(next, b.center);
    if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) continue;
    const spin: Vec3 = [-up[1], up[0], 0];
    const down = dot(delta, up) < 0;
    for (const p of state.players) {
      if (!p.alive || p.vehicle >= 0) continue;
      const d = sub(p.pos, b.center);
      const inside = Math.abs(dot(d, spin)) < b.half[0] + 0.3 && Math.abs(d[2]) < b.half[2] + 0.3;
      const lu = dot(d, up) - b.half[1] - standHeight(p.size);
      if (inside && lu > -0.3 && lu < 0.35) { p.pos = add(p.pos, delta); continue; }
      // caught underneath as it comes down: squashed (pushing you out would push you through the floor)
      if (down && inside) {
        const dn = sub(p.pos, next);
        const below = -dot(dn, up) - b.half[1]; // from its underside down to your centre
        const top = capsuleHalfSeg(p) + capsuleRadius(p); // your centre up to the top of your head (it touches: you can't get out from under)
        if (below > -0.2 && below < top + 0.05) kill(state, p, p.lastAttacker >= 0 && state.tick - p.lastDamageTick < secs(5) ? p.lastAttacker : p.id, 'crushed');
      }
    }
    b.center = next;
  }
}

/** Seeker hits in quick succession on one target add up to a big blast on them. */
function supercombine(state: SimState, q: Player, owner: number) {
  const cfg = state.config;
  q.needles = state.tick - q.needleTick <= secs(cfg.comboWindow) ? q.needles + 1 : 1;
  q.needleTick = state.tick;
  if (q.needles < cfg.comboHits || !q.alive) return;
  q.needles = 0;
  state.events.push({ type: 'supercombine', id: q.id, pos: clone(q.pos) });
  detonate(state, q.pos, owner, -1, { radius: cfg.comboRadius, damage: cfg.comboDamage, knockback: cfg.comboKnockback }, 'supercombine');
}

/**
 * A rocket: real physics plus its motor. Nothing turns it, so its nose keeps
 * its direction relative to the stars: in the ring's frame that direction
 * turns at -omega about the axis. While the motor burns it pushes along the
 * nose. A homing rocket also steers its nose (at up to turnRate) so that its
 * velocity relative to the target lines up with the line of sight: it cancels
 * sideways drift rather than just pointing at you, which is how it can hit.
 */
function moveRocket(state: SimState, b: Bolt, ws: WeaponStats, omega: number) {
  const dir = b.dir!;
  // inertial orientation: rotate by -omega*DT about +Z
  const c = Math.cos(-omega * DT), sn = Math.sin(-omega * DT);
  let d: Vec3 = [c * dir[0] - sn * dir[1], sn * dir[0] + c * dir[1], dir[2]];
  if (ws.turnRate > 0) {
    // keep a lock while the target is still ahead of the rocket's motion; otherwise look for one
    let tgt: Player | null = null;
    if (b.target >= 0) {
      const q = state.players.find((x) => x.id === b.target);
      if (q && q.alive) {
        const to = sub(q.pos, b.pos);
        if (len(to) < ws.seekRange * 1.5 && dot(to, sub(b.vel, q.vel)) > 0 && state.tick < b.burnUntil) tgt = q;
      }
    }
    // it only acquires a target in the first moments of flight, within its narrow cone
    if (!tgt && state.tick - b.spawnTick < secs(0.25)) tgt = seekTarget(state, b, d, ws);
    b.target = tgt?.id ?? -1;
    if (tgt) {
      const los = norm(sub(tgt.pos, b.pos));
      const rel = sub(b.vel, tgt.vel);
      const drift = sub(rel, scale(los, dot(rel, los))); // velocity across the line of sight
      // the acceleration we'd like: kill the drift, keep closing. It steers by
      // what it sees and knows nothing about the spin, so the spin still bends
      // its path: you have to aim it about right yourself.
      const want = norm(sub(scale(los, 0.4 * ws.thrust), scale(drift, 3)));
      d = turnToward(d, want, ws.turnRate * DT);
    }
  }
  b.dir = d;
  const burning = state.tick < b.burnUntil;
  const push: Vec3 | null = burning ? scale(d, ws.thrust) : null;
  const extra = push ? (pull ? add(push, pull) : push) : pull;
  integrate(b.pos, b.vel, DT, omega, state.config, null, extra);
}

/**
 * A gently homing bolt (the pistol's overcharge): no motor, so it turns its
 * velocity toward the target (relative to the target's motion) at up to
 * turnRate, keeping its speed. It gives up once the target is behind it.
 */
function steerBolt(state: SimState, b: Bolt, ws: WeaponStats) {
  const q = state.players.find((x) => x.id === b.target);
  if (!q || !q.alive || apart(state.config, q.pos, b.pos)) { b.target = -1; return; }
  const rel = sub(b.vel, q.vel);
  const to = sub(q.pos, b.pos);
  const speed = len(rel);
  if (speed < 1e-6 || dot(to, rel) <= 0) { b.target = -1; return; }
  const turned = turnToward(scale(rel, 1 / speed), norm(to), ws.turnRate * DT);
  b.vel = add(q.vel, scale(turned, speed));
}

/** Nearest enemy of the rocket's owner within its seeker cone. */
function seekTarget(state: SimState, b: Bolt, nose: Vec3, ws: WeaponStats): Player | null {
  const owner = state.players.find((q) => q.id === b.owner);
  const cosMax = Math.cos((ws.seekAngle * Math.PI) / 180);
  let best: Player | null = null;
  let bestD = ws.seekRange;
  for (const q of state.players) {
    if (!q.alive || q.id === b.owner || q.kind === 'dummy' || apart(state.config, q.pos, b.pos)) continue;
    if (owner && q.team === owner.team && !state.config.friendlyFire) continue;
    const to = sub(q.pos, b.pos);
    const d = len(to);
    if (d > bestD || d < 1e-6 || dot(to, nose) / d < cosMax) continue;
    bestD = d;
    best = q;
  }
  return best;
}

/** Rotate unit vector `a` toward unit vector `b` by at most `maxAngle`. */
function turnToward(a: Vec3, b: Vec3, maxAngle: number): Vec3 {
  const cosT = Math.max(-1, Math.min(1, dot(a, b)));
  const t = Math.acos(cosT);
  if (t <= maxAngle || t < 1e-9) return b;
  // slerp by maxAngle / t
  const f = maxAngle / t, st = Math.sin(t);
  const ka = Math.sin((1 - f) * t) / st, kb = Math.sin(f * t) / st;
  return norm(add(scale(a, ka), scale(b, kb)));
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
      } else if (st.kind === 'vehicle') {
        const v = state.vehicles.find((q) => q.id === st.id);
        if (v && v.alive) { g.pos = add(v.pos, st.offset); g.vel = clone(v.vel); } else g.stuck = null;
      }
    } else if (g.variant === 'bounce') {
      if (g.spawnTick !== tick) {
        const p0 = clone(g.pos);
        const gf = frameOf(cfg, g.pos);
        setSdfFrame(gf, state.frameAngle);
        const impact = moveSphereBody(state.level, cfg, frameOmega(omega, gf), g, cfg.bounceRestitution);
        if (cfg.twin && frameOf(cfg, g.pos) !== gf) convertBody(g.pos, g.vel, gf, frameOf(cfg, g.pos), state.frameAngle + omega * DT, omega);
        if (impact > 1) state.events.push({ type: 'grenadeBounce', id: g.id, pos: clone(g.pos), speed: impact });
        // ...then bounce off players and props (relative to their motion)
        const hit = sweep(state, p0, g.pos, g.radius, g.owner, g.armed, false);
        if (hit && (hit.player || hit.prop || hit.vehicle)) {
          const centre = hit.player ? closestOnSeg(hit.pos, ...capsuleEnds(hit.player)).point : hit.vehicle ? hit.vehicle.pos : hit.prop!.pos;
          const n = norm(sub(hit.pos, centre));
          const vt = hit.player ? hit.player.vel : hit.vehicle ? hit.vehicle.vel : hit.prop!.vel;
          const rel = sub(g.vel, vt);
          const vn = dot(rel, n);
          if (vn < 0) {
            reflect(rel, n, vn, cfg.bounceRestitution, cfg.friction);
            g.vel = add(vt, rel);
            state.events.push({ type: 'grenadeBounce', id: g.id, pos: clone(hit.pos), speed: -vn });
          }
          g.pos = hit.pos;
          g.contactNormal = null;
        }
        if (!g.armed && !stillInsideOwner(state, g.pos, g.radius, g.owner)) g.armed = true;
        let dead = false;
        despawnIfSpaced(state, g.pos, g.vel, () => (dead = true), cfg.fallKillDistance);
        if (dead) continue;
      }
    } else if (g.spawnTick !== tick) {
      const p0 = clone(g.pos);
      const gf = frameOf(cfg, g.pos);
      setSdfFrame(gf, state.frameAngle);
      advanceFree(g.pos, g.vel, DT, frameOmega(omega, gf), cfg, pull);
      const hit = sweep(state, p0, g.pos, g.radius, g.owner, g.armed);
      if (hit) {
        g.pos = hit.pos;
        if (hit.player) {
          const b = localBasis(hit.player.pos);
          const d = sub(hit.pos, hit.player.pos);
          g.stuck = { kind: 'player', id: hit.player.id, offset: [dot(d, b.spin), dot(d, b.up), dot(d, b.axial)] };
          g.vel = clone(hit.player.vel);
        } else if (hit.vehicle) {
          g.stuck = { kind: 'vehicle', id: hit.vehicle.id, offset: sub(hit.pos, hit.vehicle.pos) };
          g.vel = clone(hit.vehicle.vel);
        } else if (hit.prop) {
          g.stuck = { kind: 'prop', id: hit.prop.id, offset: sub(hit.pos, hit.prop.pos) };
          g.vel = clone(hit.prop.vel);
        } else {
          g.stuck = { kind: 'world' };
          g.vel = [0, 0, 0];
        }
        if (g.fuseTick < 0) g.fuseTick = tick + secs(cfg.grenadeFuse);
        state.events.push({ type: 'stick', id: g.id, pos: clone(g.pos), target: hit.player?.id ?? hit.prop?.id ?? hit.vehicle?.id ?? -1 });
      } else {
        if (cfg.twin && frameOf(cfg, g.pos) !== gf) convertBody(g.pos, g.vel, gf, frameOf(cfg, g.pos), state.frameAngle + omega * DT, omega);
        if (!g.armed && !stillInsideOwner(state, g.pos, g.radius, g.owner)) g.armed = true;
        if (tick - g.spawnTick > secs(cfg.grenadeMaxFlight)) explode = true;
        let dead = false;
        despawnIfSpaced(state, g.pos, g.vel, () => (dead = true));
        if (dead) continue;
      }
    }
    if (g.fuseTick >= 0 && tick >= g.fuseTick) explode = true;
    if (tick >= g.expireTick) continue;
    if (explode) detonate(state, g.pos, g.owner, g.id, undefined, g.variant === 'bounce' ? 'bouncing grenade' : 'grenade');
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
export interface Blast {
  radius: number;
  damage: number;
  knockback: number; // point-blank delta-v for an 80 kg player (before knockbackScale)
}

export function detonate(state: SimState, c: Vec3, owner: number, sourceId: number, blast?: Blast, cause = 'grenade') {
  const cfg = state.config;
  const b = blast ?? { radius: cfg.explosionRadius, damage: cfg.explosionDamage, knockback: cfg.knockbackSpeed };
  const rad = b.radius;
  const id = allocId(state);
  state.explosions.push({ id, type: 'explosion', owner, pos: clone(c), radius: rad, tick: state.tick, endTick: state.tick + secs(0.7), cause });
  state.events.push({ type: 'explode', id: sourceId, owner, pos: clone(c) });
  const kb = b.knockback * cfg.knockbackScale;

  for (const p of state.players) {
    if (!p.alive || apart(cfg, p.pos, c)) continue; // (blasts don't reach across the seam between twin rings)
    const [e0, e1] = capsuleEnds(p);
    const q = closestOnSeg(c, e0, e1).point;
    const d = Math.max(0, dist(c, q) - capsuleRadius(p));
    if (d >= rad) continue;
    const f = falloff(cfg, d / rad);
    const up = localBasis(p.pos).up;
    const dir = knockDir(sub(p.pos, c), up, cfg.liftBias);
    p.vel = addScaled(p.vel, dir, kb * f);
    p.grounded = false;
    p.groundNormal = null;
    const dmg = b.damage * f * (p.id === owner ? cfg.selfDamageScale : 1);
    if (dmg > 0) damagePlayer(state, p, owner, dmg, dmg, cause);
  }
  for (const v of state.vehicles) {
    if (!v.alive || v.id === sourceId) continue;
    const d = Math.max(0, dist(c, v.pos) - v.radius);
    if (d >= rad) continue;
    const f = falloff(cfg, d / rad);
    v.vel = addScaled(v.vel, knockDir(sub(v.pos, c), localBasis(v.pos).up, cfg.liftBias), kb * f * (PLAYER_MASS / BIKE_MASS) * 2);
    v.contactNormal = null;
    damageVehicle(state, v, owner, b.damage * f * 1.5);
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
  if (!state.config.friendlyFire && attacker !== p.id) {
    const a = state.players.find((q) => q.id === attacker);
    if (a && a.team === p.team) return;
  }
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
  if (p.vehicle >= 0) dismount(state, p);
  if (p.carrying >= 0) dropFlag(state, p, false);
  p.alive = false;
  p.health = 0;
  p.deaths++;
  p.respawnTick = state.tick + secs(state.config.respawnTime);
  const k = state.players.find((q) => q.id === killer);
  if (k && k.id !== p.id) k.kills++;
  state.events.push({ type: 'kill', killer, victim: p.id, cause });
  dropItems(state, p);
  for (const g of state.grenades) if (g.stuck && g.stuck.kind === 'player' && g.stuck.id === p.id) g.stuck = null;
}

/** Drop special weapons, jetpack and grenades as floating pickups on the floor below. */
function dropItems(state: SimState, p: Player) {
  const cfg = state.config;
  if (distanceOffRing(cfg, p.pos) > 0) return; // lost to space with them
  const drops: { item: ItemKind; amount: number }[] = [];
  for (const w of p.owned) {
    if (STARTING_WEAPONS.includes(w)) continue;
    const id = WEAPON_IDS[w];
    const ws = cfg.weapons[id];
    const rounds = p.infiniteAmmo ? ws.magSize + ws.ammoMax : p.mag[w] + p.ammo[w];
    if (ws.magSize > 0 && rounds <= 0) continue;
    if (id === 'hover') continue;
    drops.push({ item: id as ItemKind, amount: ws.magSize > 0 ? rounds : -1 });
  }
  if (p.hasJetpack && p.jetFuel > 0.05) drops.push({ item: 'jetpack', amount: Math.round(p.jetFuel * 100) });
  if (p.grenades > 0) drops.push({ item: 'sticky', amount: p.grenades });
  if (p.bounceGrenades > 0) drops.push({ item: 'bounce', amount: p.bounceGrenades });
  if (!drops.length) return;
  // find the floor below (down = away from the axis)
  const b = localBasis(p.pos);
  const hit = sphereTrace(state.level, cfg, p.pos, addScaled(p.pos, b.up, -60), 0.3);
  if (!hit) return;
  const base = addScaled(hit.pos, b.up, 0.7);
  drops.forEach((d, i) => {
    const a = (i / drops.length) * Math.PI * 2;
    const r = drops.length > 1 ? 0.9 : 0;
    const pos = add(base, add(scale(b.spin, Math.cos(a) * r), scale(b.axial, Math.sin(a) * r)));
    addPickup(state, d.item, pos, d.amount, 0, state.tick + secs(cfg.dropLifetime));
  });
}

/** Campaign: won when every enemy is dead, lost when the human dies. Decided once. */
function updateOutcome(state: SimState) {
  if (state.outcome !== 'playing') return;
  const humans = state.players.filter((p) => p.kind === 'human');
  const enemies = state.players.filter((p) => p.enemyType !== '');
  let outcome: Outcome = 'playing';
  if (humans.length && humans.every((p) => !p.alive)) outcome = 'lost';
  else if (enemies.length && enemies.every((p) => !p.alive)) outcome = 'won';
  if (outcome === 'playing') return;
  state.outcome = outcome;
  state.events.push({ type: 'outcome', outcome });
}

// =========================================================================== pickups

const PICKUP_RANGE = 1.3;

/** Apply an item to a player. Returns false (and the item stays) if it would do nothing. */
export function applyItem(cfg: SimConfig, p: Player, item: ItemKind, amount: number): boolean {
  const full = amount < 0;
  switch (item) {
    case 'health':
      if (p.health >= p.maxHealth) return false;
      p.health = p.maxHealth;
      return true;
    case 'sticky':
      if (p.grenades >= MAX_GRENADES) return false;
      p.grenades = full ? MAX_GRENADES : Math.min(MAX_GRENADES, p.grenades + amount);
      return true;
    case 'bounce':
      if (p.bounceGrenades >= MAX_GRENADES) return false;
      p.bounceGrenades = full ? MAX_GRENADES : Math.min(MAX_GRENADES, p.bounceGrenades + amount);
      return true;
    case 'jetpack': {
      const fuel = full ? 1 : amount / 100;
      if (p.hasJetpack && p.jetFuel >= fuel) return false;
      p.hasJetpack = true;
      p.jetFuel = Math.max(p.jetFuel, fuel);
      return true;
    }
    default: {
      // a weapon: new ones are added; ammo weapons you already have are refilled
      // Ammo weapons: `amount` is total rounds (magazine first, then spares).
      const w = WEAPON_IDS.indexOf(item as WeaponId);
      const st = cfg.weapons[item as WeaponId];
      const total = full ? st.magSize + st.ammoMax : Math.min(st.magSize + st.ammoMax, amount);
      if (!p.owned.includes(w)) {
        p.owned = [...p.owned, w].sort((a, b) => a - b);
        p.mag[w] = Math.min(st.magSize, total);
        p.ammo[w] = total - p.mag[w];
        p.heat[w] = 0;
        return true;
      }
      const have = p.mag[w] + p.ammo[w];
      if (st.magSize > 0 && have < st.magSize + st.ammoMax) {
        const after = Math.min(st.magSize + st.ammoMax, Math.max(have, total));
        p.ammo[w] = after - p.mag[w]; // tops up the spares; reload as usual
        return true;
      }
      return false;
    }
  }
}

function updatePickups(state: SimState) {
  const cfg = state.config;
  const tick = state.tick;
  const keep = [];
  for (const it of state.pickups) {
    if (it.expireTick >= 0 && tick >= it.expireTick) continue;
    if (tick >= it.activeAt) {
      for (const p of state.players) {
        if (!p.alive || p.kind === 'dummy' || p.enemyType !== '' || apart(cfg, p.pos, it.pos) || dist(p.pos, it.pos) > PICKUP_RANGE) continue;
        if (!applyItem(cfg, p, it.item, it.amount)) continue;
        state.events.push({ type: 'pickup', id: it.id, item: it.item, player: p.id, pos: clone(it.pos) });
        it.activeAt = it.respawnTicks > 0 ? tick + it.respawnTicks : Infinity;
        break;
      }
    }
    if (it.respawnTicks === 0 && it.activeAt === Infinity) continue; // one-shot, taken
    keep.push(it);
  }
  state.pickups = keep;
}

function updateVitals(state: SimState, p: Player) {
  const cfg = state.config;
  if (p.alive) {
    if (state.tick - p.lastDamageTick > secs(cfg.shieldRegenDelay) && p.shield < p.maxShield)
      p.shield = Math.min(p.maxShield, p.shield + cfg.shieldRegenRate * DT);
    // Fell (or was blasted) off the ring: dead once far enough from it.
    const spaced = distanceOffRing(cfg, p.pos) > cfg.fallKillDistance;
    if (spaced) kill(state, p, p.lastAttacker >= 0 && state.tick - p.lastDamageTick < secs(15) ? p.lastAttacker : p.id, 'spaced');
    return;
  }
  if (state.tick < p.respawnTick || !p.canRespawn) return;
  // respawn
  const spawns = state.level.spawns;
  let si = p.homeSpawn;
  if (p.kind !== 'dummy') si = rngInt(state, spawns.length);
  const base = state.level.bases?.find((b) => b.team === p.team);
  p.pos = p.homeSpawn < 0 ? dummyHome(cfg, p.homeSpawn)
    : base ? spawnPosition(cfg, base.spawns[rngInt(state, base.spawns.length)], standHeight(p.size), state.level) // at your team's base
    : spawnPosition(cfg, spawns[si], standHeight(p.size), state.level);
  p.vel = [0, 0, 0];
  p.alive = true;
  p.health = p.maxHealth;
  p.shield = p.maxShield;
  p.grounded = false;
  p.groundNormal = localBasis(p.pos).up;
  p.owned = [...STARTING_WEAPONS];
  p.weapon = STARTING_WEAPONS[0];
  p.heat = WEAPON_IDS.map(() => 0);
  p.overheatUntil = WEAPON_IDS.map(() => 0);
  p.ammo = WEAPON_IDS.map(() => 0);
  p.mag = WEAPON_IDS.map(() => 0);
  p.reloadUntil = 0;
  p.reloadWeapon = -1;
  p.burstUntil = 0;
  p.charge = 0;
  p.holdTicks = 0;
  p.needRelease = false;
  p.hasJetpack = false;
  p.jetFuel = 0;
  p.grenades = MAX_GRENADES;
  p.bounceGrenades = MAX_GRENADES;
  p.lastAttacker = -1;
  state.events.push({ type: 'respawn', id: p.id });
}


// =========================================================================== capture the flag

const FLAG_REACH = 1.8; // touch a flag from this far (centre to centre)
const CAPTURE_REACH = 4; // bring the enemy flag this close to your own (at home) to score

/** The flag carried by `p` comes off: dropped where they are (they died), or tossed forward along their aim (Q). */
export function dropFlag(state: SimState, p: Player, toss: boolean) {
  const f = state.flags.find((x) => x.team === p.carrying);
  p.carrying = -1;
  p.owned = p.owned.filter((w) => w !== WEAPON_FLAG);
  if (p.weapon === WEAPON_FLAG) p.weapon = p.owned[0] ?? 0;
  if (!f) return;
  const up = localBasis(p.pos).up;
  f.state = 'dropped';
  f.carrier = -1;
  f.droppedTick = state.tick;
  f.contactNormal = null;
  f.pos = addScaled(p.pos, up, 0.6);
  f.vel = clone(p.vel);
  if (toss) {
    // a gentle throw along your aim (a pass to a teammate, or over a gap)
    const aim = viewVectors(p.pos, p.yaw, p.pitch).forward;
    f.pos = addScaled(f.pos, aim, 0.8);
    f.vel = addScaled(addScaled(f.vel, aim, 9), up, 2);
  }
  f.noGrab = p.id;
  f.noGrabUntil = state.tick + secs(toss ? 1 : 0.5);
  state.events.push({ type: 'flag', what: 'dropped', flagTeam: f.team, by: p.id, pos: clone(f.pos) });
}

function flagHome(state: SimState, f: Flag, by: number) {
  f.state = 'home';
  f.carrier = -1;
  f.pos = clone(f.home);
  f.vel = [0, 0, 0];
  f.contactNormal = null;
  state.events.push({ type: 'flag', what: 'returned', flagTeam: f.team, by, pos: clone(f.home) });
}

/**
 * Flags: carried ones go with their carriers; dropped ones fall and roll, and
 * go home after a while (or at once if lost to space). Touching the enemy's
 * flag takes it; touching your own dropped flag sends it home; bringing the
 * enemy's flag to your own, while yours is at home, scores.
 */
function updateFlags(state: SimState, omega: number) {
  const cfg = state.config;
  for (const f of state.flags) {
    if (f.state === 'carried') {
      const c = state.players.find((q) => q.id === f.carrier);
      if (!c || !c.alive || c.carrying !== f.team) { f.state = 'dropped'; f.carrier = -1; f.droppedTick = state.tick; continue; }
      f.pos = addScaled(c.pos, localBasis(c.pos).up, 0.9 * c.size);
      f.vel = clone(c.vel);
    } else if (f.state === 'dropped') {
      inFrame(state, omega, f, (w) => moveSphereBody(state.level, cfg, w, f, 0.2));
      if (distanceOffRing(cfg, f.pos) > cfg.fallKillDistance || state.tick - f.droppedTick > secs(cfg.flagReturnTime)) flagHome(state, f, -1);
    }
  }
  if (state.winner >= 0) return; // (game over: the flags just sit there)
  for (const p of state.players) {
    if (!p.alive || p.kind === 'dummy') continue;
    for (const f of state.flags) {
      if (f.state === 'carried') continue;
      if (dist(p.pos, f.pos) > FLAG_REACH + 0.5 * (p.size - 1)) continue;
      if (f.team === p.team) {
        if (f.state === 'dropped') flagHome(state, f, p.id); // saved it
        continue;
      }
      if (p.carrying >= 0 || (f.noGrab === p.id && state.tick < f.noGrabUntil)) continue;
      // take it: it's your weapon now, until you drop it
      f.state = 'carried';
      f.carrier = p.id;
      p.carrying = f.team;
      if (!p.owned.includes(WEAPON_FLAG)) p.owned.push(WEAPON_FLAG);
      p.weapon = WEAPON_FLAG;
      p.reloadUntil = 0;
      p.charge = 0;
      state.events.push({ type: 'flag', what: 'taken', flagTeam: f.team, by: p.id, pos: clone(f.pos) });
    }
    // home with the enemy's flag, and yours is there: a capture
    if (p.carrying >= 0) {
      const mine = state.flags.find((x) => x.team === p.team);
      if (mine && mine.state === 'home' && dist(p.pos, mine.home) < CAPTURE_REACH) {
        const theirs = state.flags.find((x) => x.team === p.carrying)!;
        p.carrying = -1;
        p.owned = p.owned.filter((w) => w !== WEAPON_FLAG);
        p.weapon = p.owned[0] ?? 0;
        state.captures[p.team] = (state.captures[p.team] ?? 0) + 1;
        state.events.push({ type: 'flag', what: 'captured', flagTeam: theirs.team, by: p.id, pos: clone(p.pos) });
        theirs.state = 'home';
        theirs.carrier = -1;
        theirs.pos = clone(theirs.home);
        theirs.vel = [0, 0, 0];
        if (state.captures[p.team] >= cfg.ctfCaptures) {
          state.winner = p.team;
          state.events.push({ type: 'ctfWin', team: p.team });
        }
      }
    }
  }
}
