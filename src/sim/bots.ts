// Scripted bots. A bot is just a function state -> InputCmd: it drives its
// player through exactly the same input path as a human. Pure and
// deterministic (uses a stateless hash, never the sim RNG or Math.random), so
// a server can run bots without disturbing replays.

import { advanceFree, localBasis } from './physics';
import { boltStats, launchVelocity, muzzlePoint } from './step';
import { hash01 } from './rng';
import { BTN_FIRE, BTN_GRENADE, BTN_GRENADE2, BTN_JUMP, BTN_MELEE, BTN_SPRINT, DT, WEAPON_HAMMER, WEAPON_HOVER, WEAPON_IDS, omegaOf, type BoltKind, type InputCmd, type Player, type SimState } from './types';
import { type Vec3, addScaled, clone, cross, dot, len, norm, sub } from './vec';
import { ENEMY_TYPES } from './tuning';
import { eyeOffset } from './world';

/** Local-frame yaw/pitch that points from `from` toward `to` (straight line, ignoring physics). */
export function aimAt(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const b = localBasis(from);
  const d = sub(to, from);
  const ft = dot(d, b.spin), fz = dot(d, b.axial), fu = dot(d, b.up);
  return { yaw: Math.atan2(fz, ft), pitch: Math.atan2(fu, Math.hypot(ft, fz)) };
}

/**
 * Aim that actually hits: fire a simulated bolt with the real launch rule and
 * physics, find where it passes closest to the target (extrapolated along its
 * velocity), and Newton-iterate yaw/pitch on that miss, with the Jacobian
 * estimated by nudging the aim. Converges in two or three rounds.
 */
export function solveAim(state: SimState, me: Player, target: Player, kind: BoltKind): { yaw: number; pitch: number } {
  const cfg = state.config;
  const omega = omegaOf(cfg);
  const eye = addScaled(me.pos, localBasis(me.pos).up, eyeOffset(me));
  const los = sub(target.pos, eye);
  const range = len(los);
  const speed = Math.max(1, boltStats(cfg, kind).muzzle);
  const steps = Math.min(500, Math.ceil((range / speed / DT) * 2.5) + 10);
  // two directions across the line of sight to measure the miss in
  const L = norm(los);
  const e1 = norm(cross(L, localBasis(eye).up));
  const e2 = cross(e1, L);
  const missOf = (yaw: number, pitch: number): [number, number] => {
    const from = muzzlePoint(me, yaw, pitch);
    const r = clone(from);
    const v = launchVelocity(cfg, me, kind, from, yaw, pitch);
    let best = Infinity;
    let miss: Vec3 = [0, 0, 0];
    for (let i = 1; i <= steps; i++) {
      advanceFree(r, v, DT, omega, cfg);
      const d = sub(addScaled(target.pos, target.vel, i * DT), r); // assume they keep going
      const dl = len(d);
      if (dl < best) { best = dl; miss = d; } else if (dl > best + 2) break;
    }
    return [dot(miss, e1), dot(miss, e2)];
  };
  let aim = aimAt(eye, target.pos);
  const h = 0.002;
  for (let iter = 0; iter < 4; iter++) {
    const f = missOf(aim.yaw, aim.pitch);
    if (Math.hypot(f[0], f[1]) < 0.05) break;
    const fy = missOf(aim.yaw + h, aim.pitch), fp = missOf(aim.yaw, aim.pitch + h);
    const j11 = (fy[0] - f[0]) / h, j21 = (fy[1] - f[1]) / h, j12 = (fp[0] - f[0]) / h, j22 = (fp[1] - f[1]) / h;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-9) break;
    let dy = -(j22 * f[0] - j12 * f[1]) / det;
    let dp = -(-j21 * f[0] + j11 * f[1]) / det;
    const m = Math.max(Math.abs(dy), Math.abs(dp));
    if (m > 0.4) { dy *= 0.4 / m; dp *= 0.4 / m; } // don't swing wildly
    aim = { yaw: aim.yaw + dy, pitch: Math.max(-1.5, Math.min(1.5, aim.pitch + dp)) };
  }
  return aim;
}

export function botInput(state: SimState, playerId: number): InputCmd {
  const tick = state.tick;
  const me = state.players.find((p) => p.id === playerId)!;
  const cmd: InputCmd = { playerId, tick, moveX: 0, moveY: 0, yaw: me.yaw, pitch: me.pitch, buttons: 0, weapon: me.weapon };
  if (!me.alive) return cmd;
  const R = state.config.R;
  // Campaign enemies follow their type; sandbox bots are free-for-all wanderers.
  const type = me.enemyType ? ENEMY_TYPES[me.enemyType] : undefined;
  const range = type?.range ?? 45;
  const aimError = type?.aimError ?? 0.04;
  const behaviour = type?.behaviour ?? 'wander';

  // Idle: sandbox bots wander (a new waypoint every ~5 s); enemies wait where placed.
  const epoch = Math.floor(tick / 600);
  if (behaviour === 'wander') {
    const wpAng = Math.atan2(me.pos[1], me.pos[0]) + (hash01(playerId, epoch, 1) - 0.5) * (60 / R);
    const wpZ = (hash01(playerId, epoch, 2) - 0.5) * 30;
    const wp: Vec3 = [R * Math.cos(wpAng), R * Math.sin(wpAng), wpZ];
    const toWp = aimAt(me.pos, wp);
    cmd.yaw = toWp.yaw;
    cmd.pitch = 0;
    cmd.moveY = 1;
  }
  if (hash01(playerId, epoch, 3) < 0.3) cmd.buttons |= BTN_SPRINT;

  // Target: nearest living opponent (other team, not a dummy) within range.
  let target = null as (typeof state.players)[number] | null;
  let best = range;
  for (const p of state.players) {
    if (p.id === playerId || !p.alive || p.kind === 'dummy' || p.team === me.team) continue;
    const d = len(sub(p.pos, me.pos));
    if (d < best) { best = d; target = p; }
  }
  if (target) {
    const eye: Vec3 = [...me.pos] as Vec3;
    const up = localBasis(me.pos).up;
    for (let i = 0; i < 3; i++) eye[i] += up[i] * eyeOffset(me);
    // Weapon first (the aim depends on how fast its bolts fly).
    if (type) {
      cmd.weapon = WEAPON_IDS.indexOf(type.weapon);
    } else {
      // Pick one of the weapons we own for a few seconds at a time; prefer the new toys.
      const options = me.owned.filter((w) => w !== WEAPON_HOVER && (w !== WEAPON_HAMMER || best < 4));
      const special = options.filter((w) => w > 1 && (state.config.weapons[WEAPON_IDS[w]].magSize === 0 || me.mag[w] + me.ammo[w] > 0));
      const pool = special.length && hash01(playerId, tick >> 10, 10) < 0.6 ? special : options;
      cmd.weapon = pool[Math.floor(hash01(playerId, tick >> 10, 7) * pool.length)] ?? 0;
    }
    const id = WEAPON_IDS[cmd.weapon];
    // Straight at you, or (with aim skill) a solved shot that leads you and allows for the spin.
    const straight = aimAt(eye, target.pos);
    const skill = type?.aimSkill ?? 0.3;
    let aim = straight;
    if (skill > 0 && id !== 'hammer') {
      const kind: BoltKind = id === 'launcher' ? 'fuelRod' : id === 'pistol' ? 'pistol' : (id as BoltKind);
      const solved = solveAim(state, me, target, kind);
      const dyaw = Math.atan2(Math.sin(solved.yaw - straight.yaw), Math.cos(solved.yaw - straight.yaw));
      aim = { yaw: straight.yaw + skill * dyaw, pitch: straight.pitch + skill * (solved.pitch - straight.pitch) };
    }
    cmd.yaw = aim.yaw + (hash01(playerId, tick >> 4, 4) - 0.5) * 2 * aimError;
    cmd.pitch = aim.pitch + (hash01(playerId, tick >> 4, 5) - 0.5) * 1.2 * aimError;
    const side = hash01(playerId, tick >> 7, 6) < 0.5 ? -1 : 1;
    if (behaviour === 'wander') {
      cmd.moveY = best > 15 ? 1 : 0;
      cmd.moveX = side;
    } else if (behaviour === 'chase') {
      cmd.moveY = best > range * 0.4 ? 1 : 0;
      cmd.moveX = best < range * 0.6 ? side : 0;
    } else if (behaviour === 'strafe') {
      cmd.moveY = best > range * 0.75 ? 1 : best < range * 0.35 ? -1 : 0;
      cmd.moveX = side;
    }
    const burst = (tick >> 5) % 4 !== 0;
    if (id === 'rifle' || id === 'redRifle') {
      if (burst && me.heat[cmd.weapon] < 0.85) cmd.buttons |= BTN_FIRE;
    } else if (id === 'laconic') {
      if ((tick >> 8) % 2 === 0) cmd.buttons |= BTN_FIRE; // hold to charge; it streams by itself
    } else if (id === 'cannon') {
      if ((tick >> 4) % 4 === 0) cmd.buttons |= BTN_FIRE; // one careful shot at a time
    } else if (id === 'hammer') {
      if (best < 3.5 && (tick >> 3) % 4 === 0) cmd.buttons |= BTN_FIRE;
      cmd.moveY = 1; // close in
    } else if (id === 'launcher') {
      if ((tick >> 4) % 8 === 0) cmd.buttons |= BTN_FIRE;
    } else if ((tick >> 3) % 3 === 0) cmd.buttons |= BTN_FIRE; // pistol: tap tap
    if (best < 2.5) cmd.buttons |= (tick >> 3) % 2 ? BTN_MELEE : 0; // too close: shove
    // Grenade: hold for 0.25 s then release, every ~8 s, if close.
    const gPhase = (tick + playerId * 97) % 960;
    if (best < 28 && gPhase < 30) {
      const sticky = me.grenades > 0 && (me.bounceGrenades === 0 || hash01(playerId, (tick / 960) | 0, 9) < 0.5);
      cmd.buttons |= sticky ? BTN_GRENADE : BTN_GRENADE2;
    }
  }
  if (behaviour !== 'hold' && hash01(playerId, tick >> 6, 8) < 0.06) cmd.buttons |= BTN_JUMP;
  return cmd;
}
