// Hover-bikes. A bike is a physics sphere with its own health: frictionless
// while ridden (so momentum, the spin and slopes all matter), a normal sliding
// object when parked. Crashes hurt the bike (and, harder ones, the rider);
// running people over hurts them; shots and blasts damage it; at zero health
// it explodes, throws the rider off, and respawns at its spot later.

import { closestOnSeg } from './geom';
import { localBasis, viewVectors } from './physics';
import { BTN_JUMP, BTN_SPRINT, BTN_USE, DT, type Player, type SimState, type Vehicle } from './types';
import { type Vec3, add, addScaled, clone, dist, dot, len, norm, scale, sub } from './vec';
import { capsuleRadius, capsuleHalfSeg, PLAYER_MASS } from './world';
import { damagePlayer, detonate, moveSphereBody } from './step';

export const BIKE_MASS = 250;
const MOUNT_RANGE = 2.6;
const SEAT_HEIGHT = 0.9; // rider capsule centre above the bike's centre

const secs = (s: number) => Math.round(s / DT);

/** E: get on the nearest free bike in reach, or get off the one you're on. */
export function handleUse(state: SimState, p: Player) {
  const pressed = p.lastInput.buttons & ~p.prevButtons;
  if (!(pressed & BTN_USE) || !p.alive) return;
  if (p.vehicle >= 0) return dismount(state, p);
  let best: Vehicle | null = null;
  let bd = MOUNT_RANGE;
  for (const v of state.vehicles) {
    if (!v.alive || v.driver >= 0) continue;
    const d = dist(v.pos, p.pos);
    if (d < bd) { bd = d; best = v; }
  }
  if (!best) return;
  best.driver = p.id;
  p.vehicle = best.id;
  p.grounded = false;
  p.groundNormal = null;
  state.events.push({ type: 'mount', id: p.id, vehicle: best.id, on: true });
}

export function dismount(state: SimState, p: Player) {
  const v = state.vehicles.find((q) => q.id === p.vehicle);
  p.vehicle = -1;
  if (!v) return;
  v.driver = -1;
  // step off to the right, keeping the bike's velocity
  const vv = viewVectors(v.pos, v.yaw, 0);
  p.pos = addScaled(addScaled(v.pos, vv.right, 1.6), vv.up, 0.6);
  p.vel = clone(v.vel);
  state.events.push({ type: 'mount', id: p.id, vehicle: v.id, on: false });
}

export function damageVehicle(state: SimState, v: Vehicle, attacker: number, damage: number) {
  if (!v.alive || damage <= 0) return;
  v.health -= damage;
  v.lastAttacker = attacker;
  v.lastDamageTick = state.tick;
  state.events.push({ type: 'vehicleHit', id: v.id, damage, pos: clone(v.pos) });
  if (v.health > 0) return;
  // boom
  v.alive = false;
  v.health = 0;
  v.respawnTick = state.tick + secs(state.config.bikeRespawn);
  const rider = state.players.find((q) => q.id === v.driver);
  if (rider) {
    dismount(state, rider);
    rider.vel = addScaled(rider.vel, localBasis(rider.pos).up, 8);
  }
  v.driver = -1;
  state.events.push({ type: 'vehicleDestroyed', id: v.id, pos: clone(v.pos) });
  const cfg = state.config;
  detonate(state, v.pos, attacker, v.id, { radius: cfg.bikeBlastRadius, damage: cfg.bikeBlastDamage, knockback: cfg.bikeBlastKnockback }, 'bike explosion');
  for (const g of state.grenades) if (g.stuck && g.stuck.kind === 'vehicle' && g.stuck.id === v.id) g.stuck = null;
}

/** Drive, move and collide every bike, then carry riders along. */
export function updateVehicles(state: SimState, omega: number) {
  const cfg = state.config;
  const tick = state.tick;
  for (const v of state.vehicles) {
    if (!v.alive) {
      // respawn at home once nobody is standing on the spot
      if (tick >= v.respawnTick && !state.players.some((p) => p.alive && dist(p.pos, v.home) < 3)) {
        v.alive = true;
        v.health = v.maxHealth;
        v.pos = clone(v.home);
        v.vel = [0, 0, 0];
        v.yaw = v.homeYaw;
        v.contactNormal = null;
      }
      continue;
    }
    const rider = v.driver >= 0 ? state.players.find((p) => p.id === v.driver && p.alive) : undefined;
    if (v.driver >= 0 && !rider) v.driver = -1;
    if (rider) {
      const inp = rider.lastInput;
      v.yaw = inp.yaw; // it faces where you look
      const n = v.contactNormal;
      if (n) {
        const vv = viewVectors(v.pos, v.yaw, 0);
        const fwd = norm(sub(vv.forward, scale(n, dot(vv.forward, n))));
        const right = norm(sub(vv.right, scale(n, dot(vv.right, n))));
        const boost = inp.buttons & BTN_SPRINT ? 1.25 : 1;
        let thrust = inp.moveY * cfg.bikeThrust * boost;
        if (thrust > 0 && dot(v.vel, fwd) > cfg.bikeMaxSpeed * boost) thrust = 0;
        v.vel = add(v.vel, add(scale(fwd, thrust * DT), scale(right, inp.moveX * cfg.bikeStrafe * DT)));
        const pressed = inp.buttons & ~rider.prevButtons;
        if (pressed & BTN_JUMP) { v.vel = addScaled(v.vel, vv.up, cfg.bikeHop); v.contactNormal = null; }
      }
      const k = Math.max(0, 1 - cfg.bikeDamping * DT);
      v.vel = scale(v.vel, k);
    }
    // frictionless while ridden; a normal sliding object when parked. Walls and
    // boxes hurt it above bikeCrashSpeed; landings (anything floor-like) only
    // well above that, so jumps are encouraged. The rider is never hurt by either.
    const up = localBasis(v.pos).up;
    let damage = 0;
    moveSphereBody(state.level, cfg, omega, v, cfg.bikeBounce, DT, undefined, rider ? 0 : cfg.friction, (speed, n) => {
      const limit = dot(n, up) > 0.6 ? cfg.bikeLandingSpeed : cfg.bikeCrashSpeed;
      if (speed > limit) damage = Math.max(damage, (speed - limit) * cfg.bikeCrashDamage);
    });
    if (damage > 0) {
      damageVehicle(state, v, v.lastAttacker >= 0 && tick - v.lastDamageTick < secs(10) ? v.lastAttacker : rider?.id ?? -1, damage);
      if (!v.alive) continue;
    }
    ramPlayers(state, v, rider);
  }
  // riders sit on their bikes
  for (const p of state.players) {
    if (p.vehicle < 0) continue;
    const v = state.vehicles.find((q) => q.id === p.vehicle);
    if (!v || !v.alive || !p.alive) { if (p.alive) p.vehicle = -1; continue; }
    p.pos = addScaled(v.pos, localBasis(v.pos).up, SEAT_HEIGHT * p.size);
    p.vel = clone(v.vel);
    p.grounded = false;
    p.groundNormal = null;
  }
}

/** Bike vs people on foot: push apart by mass; fast enough and it hurts. */
function ramPlayers(state: SimState, v: Vehicle, rider: Player | undefined) {
  const cfg = state.config;
  for (const p of state.players) {
    if (!p.alive || p.vehicle >= 0 || p === rider) continue;
    if (dist(p.pos, v.pos) > 4) continue;
    const up = localBasis(p.pos).up;
    const h = capsuleHalfSeg(p);
    const c = closestOnSeg(v.pos, addScaled(p.pos, up, -h), addScaled(p.pos, up, h)).point;
    const dv = sub(v.pos, c);
    const d = len(dv), minD = v.radius + capsuleRadius(p);
    if (d >= minD || d < 1e-9) continue;
    const n = scale(dv, 1 / d); // from the player toward the bike
    const wb = PLAYER_MASS / (BIKE_MASS + PLAYER_MASS), wp = BIKE_MASS / (BIKE_MASS + PLAYER_MASS);
    v.pos = addScaled(v.pos, n, (minD - d) * wb);
    p.pos = addScaled(p.pos, n, -(minD - d) * wp);
    const closing = -dot(sub(v.vel, p.vel), n);
    if (closing <= 0) continue;
    const j = (1 + 0.3) * closing;
    v.vel = addScaled(v.vel, n, j * wb);
    p.vel = addScaled(addScaled(p.vel, n, -j * wp), up, closing > cfg.bikeRamSpeed ? 0.3 * closing : 0);
    p.grounded = false;
    p.groundNormal = null;
    if (closing > cfg.bikeRamSpeed) {
      const dmg = (closing - cfg.bikeRamSpeed) * cfg.bikeRamDamage;
      damagePlayer(state, p, rider?.id ?? -1, dmg, dmg, 'roadkill');
    }
  }
}

export const seatHeight = SEAT_HEIGHT;
export type { Vec3 };
