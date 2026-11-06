// Hover-bikes. A bike is a physics sphere with its own health: frictionless
// while ridden (so momentum, the spin and slopes all matter), a normal sliding
// object when parked. Crashes hurt the bike (and, harder ones, the rider);
// running people over hurts them; shots and blasts damage it; at zero health
// it explodes, throws the rider off, and respawns at its spot later.

import { closestOnSeg } from './geom';
import { levelSdf, setSdfFrame } from './level';
import { apart, convertBody, convertDir, frameOf, frameOmega } from './twin';
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
        v.contactNormal = localBasis(v.pos).up; // (asleep until disturbed)
      }
      continue;
    }
    const rider = v.driver >= 0 ? state.players.find((p) => p.id === v.driver && p.alive) : undefined;
    if (v.driver >= 0 && !rider) v.driver = -1;
    // A parked bike that has settled sleeps (big levels have dozens): it wakes
    // when anything moves it (a shot, a blast, a mallet, someone getting on).
    if (!rider && v.contactNormal && v.vel[0] * v.vel[0] + v.vel[1] * v.vel[1] + v.vel[2] * v.vel[2] < 1e-4) {
      v.vel = [0, 0, 0];
      ramPlayers(state, v, undefined);
      continue;
    }
    // twin rings: simulate it in the frame of the ring it's over (that ring's spin and geometry)
    const frame = frameOf(cfg, v.pos);
    setSdfFrame(frame, state.frameAngle);
    const w = frameOmega(omega, frame);
    const up = localBasis(v.pos).up;
    // Hover: a damped spring holds the bike at a ride height over whatever
    // floor-like surface is under it (floor, ramp, hillside), so it glides
    // over bumps and lips instead of rolling and bouncing on its sphere.
    const probe = levelSdf(state.level, cfg, v.pos);
    const hovering = probe.d < cfg.bikeHoverReach && dot(probe.n, up) > 0.55;
    v.contactNormal = hovering ? probe.n : null;
    if (hovering) {
      const n = probe.n;
      const vn = dot(v.vel, n);
      let a = cfg.bikeHoverStiffness * (cfg.bikeHoverHeight - probe.d) - cfg.bikeHoverDamping * vn;
      a = Math.max(a, -4); // (it holds you down only gently over a crest)
      v.vel = addScaled(v.vel, n, a * DT);
      // grip: sideways sliding dies away fast, rolling forward barely at all
      const vt = sub(v.vel, scale(n, dot(v.vel, n)));
      const vv = viewVectors(v.pos, v.yaw, 0);
      const fwd = norm(sub(vv.forward, scale(n, dot(vv.forward, n))));
      const side = norm(sub(vv.right, scale(n, dot(vv.right, n))));
      const vf = dot(vt, fwd), vs = dot(vt, side);
      const grip = rider ? cfg.bikeGrip : 6; // parked: it just settles
      const roll = rider ? cfg.bikeDamping : 6;
      if (!rider) v.vel = addScaled(v.vel, n, -dot(v.vel, n) * (1 - Math.exp(-4 * DT))); // (and stops bobbing)
      v.vel = addScaled(addScaled(v.vel, side, -vs * (1 - Math.exp(-grip * DT))), fwd, -vf * (1 - Math.exp(-roll * DT)));
    }
    if (rider) {
      const inp = rider.lastInput;
      v.yaw = inp.yaw; // it faces where you look
      if (hovering) {
        const n = probe.n;
        const vv = viewVectors(v.pos, v.yaw, 0);
        const fwd = norm(sub(vv.forward, scale(n, dot(vv.forward, n))));
        const right = norm(sub(vv.right, scale(n, dot(vv.right, n))));
        const boost = inp.buttons & BTN_SPRINT ? 1.25 : 1;
        let thrust = inp.moveY * cfg.bikeThrust * boost;
        if (thrust > 0 && dot(v.vel, fwd) > cfg.bikeMaxSpeed * boost) thrust = 0;
        v.vel = add(v.vel, add(scale(fwd, thrust * DT), scale(right, inp.moveX * cfg.bikeStrafe * DT)));
        const pressed = inp.buttons & ~rider.prevButtons;
        if (pressed & BTN_JUMP) v.vel = addScaled(v.vel, n, cfg.bikeHop);
      }
    }
    // Collisions: walls and boxes only hurt it in a really big crash, landings never.
    // The rider is never hurt by either.
    let damage = 0;
    // (the hover spring holds it up: no contact support force, or gravity would be cancelled while it floats)
    v.contactNormal = null;
    moveSphereBody(state.level, cfg, w, v, cfg.bikeBounce, DT, undefined, 0, (speed, n) => {
      if (dot(n, up) > 0.6) return; // (floor-like: a landing)
      if (speed > cfg.bikeCrashSpeed) damage = Math.max(damage, (speed - cfg.bikeCrashSpeed) * cfg.bikeCrashDamage);
    });
    v.contactNormal = hovering ? probe.n : v.contactNormal;
    // crossed the seam between twin rings: convert it (exactly) into the other ring's frame
    const to = frameOf(cfg, v.pos);
    if (to !== frame) {
      const th = state.frameAngle + omega * DT; // (its new position is for the end of the tick)
      convertBody(v.pos, v.vel, frame, to, th, omega);
      if (v.contactNormal) v.contactNormal = convertDir(v.contactNormal, frame, to, th);
    }
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
    if (!p.alive || p.vehicle >= 0 || p === rider || apart(cfg, p.pos, v.pos)) continue;
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
    // A parked bike is just a heavy object: you bump into it (and nudge it).
    // Only a ridden bike that is itself moving at you runs you over, and then
    // the damage and the throw grow with the closing speed.
    const bikeApproach = -dot(v.vel, n);
    const hit = !!rider && bikeApproach > cfg.bikeRamSpeed && closing > cfg.bikeRamSpeed;
    const j = (1 + (hit ? 0.3 : 0)) * closing;
    v.vel = addScaled(v.vel, n, j * wb * (hit ? 0.3 : 1));
    p.vel = addScaled(p.vel, n, -j * wp);
    if (hit) {
      const heading = len(v.vel) > 1e-6 ? norm(v.vel) : scale(n, -1);
      p.vel = addScaled(addScaled(p.vel, heading, cfg.bikeRamThrow * closing), up, 3 + cfg.bikeRamLift * closing);
      p.grounded = false;
      p.groundNormal = null;
      const dmg = (closing - cfg.bikeRamSpeed) * cfg.bikeRamDamage;
      damagePlayer(state, p, rider?.id ?? -1, dmg, dmg, 'roadkill');
    }
  }
}

export const seatHeight = SEAT_HEIGHT;
export type { Vec3 };
