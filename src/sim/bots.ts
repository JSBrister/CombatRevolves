// Scripted bots. A bot is just a function state -> InputCmd: it drives its
// player through exactly the same input path as a human. Pure and
// deterministic (uses a stateless hash, never the sim RNG or Math.random), so
// a server can run bots without disturbing replays.

import { advanceFree, localBasis, planetPullAt, viewVectors } from './physics';
import { levelSdf } from './level';
import { floorRadius } from './terrain';
import { boltStats, launchVelocity, muzzlePoint } from './step';
import { hash01 } from './rng';
import { BTN_FIRE, BTN_GRENADE, BTN_GRENADE2, BTN_JUMP, BTN_MELEE, BTN_SPRINT, DT, WEAPON_HAMMER, WEAPON_HOVER, WEAPON_IDS, omegaOf, type BoltKind, type InputCmd, type Player, type SimState } from './types';
import { type Vec3, addScaled, clone, cross, dot, len, norm, scale, sub } from './vec';
import { ENEMY_TYPES } from './tuning';
import { eyeOffset, standHeight } from './world';

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
      advanceFree(r, v, DT, omega, cfg, planetPullAt(cfg, state.frameAngle + omega * i * DT));
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

/** How high a player is above the floor beneath them (0 when standing on the floor). */
function heightAboveFloor(state: SimState, p: Player): number {
  const ang = Math.atan2(p.pos[1], p.pos[0]);
  return floorRadius(state.level, state.config, ang, p.pos[2]) - Math.hypot(p.pos[0], p.pos[1]) - standHeight(p.size);
}

/** A floor point at standing height for this player. */
function standAt(state: SimState, p: Player, angle: number, z: number): Vec3 {
  const r = floorRadius(state.level, state.config, angle, z) - standHeight(p.size);
  return [r * Math.cos(angle), r * Math.sin(angle), z];
}

/** Up on a ramp or lookout: don't strafe off the edge. */
function keepFooting(state: SimState, me: Player, cmd: InputCmd): InputCmd {
  if ((cmd.moveX === 0 && cmd.moveY === 0) || heightAboveFloor(state, me) < 0.5) return cmd;
  const vv = viewVectors(me.pos, cmd.yaw, 0);
  const d = norm(addScaled(scale(vv.forward, cmd.moveY), vv.right, cmd.moveX));
  const probe = addScaled(addScaled(me.pos, d, 1.2), vv.up, -(standHeight(me.size) + 0.3));
  if (levelSdf(state.level, state.config, probe).d > 0.25) { cmd.moveX = 0; cmd.moveY = 0; } // nothing to stand on there
  return cmd;
}

interface Nav {
  dir: Vec3; // which way to go
  stop: boolean; // arrived
  hiding: boolean; // in or heading for cover: don't shoot
}

/** Cover when shields are low; ramps up to a target on a lookout. */
function navigate(state: SimState, me: Player, target: Player): Nav | null {
  const cfg = state.config;
  const R = cfg.R;
  // --- cover: get a box between you and the target until shields recover past half
  if (me.maxShield > 0 && me.shield < 0.5 * me.maxShield) {
    let bestP: Vec3 | null = null;
    let bestD = 35;
    for (const b of state.level.boxes) {
      if (b.kind === 'wall') continue;
      if (len(sub(b.center, me.pos)) > bestD + 8) continue;
      const bl = localBasis(b.center);
      let away = sub(b.center, target.pos);
      away = sub(away, scale(bl.up, dot(away, bl.up))); // along the floor
      if (len(away) < 1e-3) continue;
      away = norm(away);
      const extent = Math.abs(dot(away, bl.spin)) * b.half[0] + Math.abs(away[2]) * b.half[2];
      const spot = addScaled(b.center, away, extent + 0.4 * me.size + 0.8);
      const ang = Math.atan2(spot[1], spot[0]);
      const cp = standAt(state, me, ang, spot[2]);
      if (levelSdf(state.level, cfg, cp).d < 0.4 * me.size + 0.1) continue; // inside something
      const d = len(sub(cp, me.pos));
      if (d < bestD) { bestD = d; bestP = cp; }
    }
    if (bestP) {
      const to = sub(bestP, me.pos);
      return { dir: norm(to), stop: len(to) < 1.2, hiding: true };
    }
  }
  // --- ramps: the target is up on a lookout or mesa and we're not
  // (once we're up off the floor, keep climbing until level with them, so we
  // don't wander off the side of the ramp near the top)
  const mine = heightAboveFloor(state, me);
  const above = heightAboveFloor(state, target) - mine;
  if (above > (mine > 0.5 ? 0.6 : 2.5)) {
    let best: { low: Vec3; high: Vec3; approach: Vec3; lowAngle: number; dir: number; z: number; hz: number } | null = null;
    let bestD = Infinity;
    for (const b of state.level.boxes) {
      if (b.kind !== 'ramp' || !b.tilt) continue;
      const run = (b.half[0] * Math.cos(b.tilt)) / R; // half the ramp's length, as an angle
      const dir = Math.sign(b.tilt);
      const lowAngle = b.angle - dir * (run + 2.5 / R);
      const low = standAt(state, me, lowAngle, b.center[2]);
      const high = standAt(state, me, b.angle + dir * (run + 3 / R), b.center[2]);
      const approach = standAt(state, me, b.angle - dir * (run + 7 / R), b.center[2]);
      const d = len(sub(high, target.pos));
      if (d < bestD) { bestD = d; best = { low, high, approach, lowAngle, dir, z: b.center[2], hz: b.half[2] }; }
    }
    if (best) {
      const onRamp = mine > 0.5;
      // how far past the foot of the ramp we are (beside it: go round to the front first)
      const myAngle = Math.atan2(me.pos[1], me.pos[0]);
      const along = Math.atan2(Math.sin(myAngle - best.lowAngle), Math.cos(myAngle - best.lowAngle)) * best.dir * R;
      const inLine = Math.abs(me.pos[2] - best.z) < best.hz - 0.3;
      const goal = onRamp || len(sub(best.low, me.pos)) < 2.5 || (inLine && along > -3) ? best.high
        : along > -2 ? best.approach : best.low;
      return { dir: norm(sub(goal, me.pos)), stop: false, hiding: false };
    }
  }
  return null;
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

  let navigating = false;
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
    // Navigation overrides: break for cover when shields are low, use ramps to
    // reach someone up on a lookout. Movement is set in the bot's facing frame,
    // so it can keep aiming while it moves.
    const nav = behaviour === 'hold' ? null : navigate(state, me, target);
    if (nav) {
      navigating = true;
      const vv = viewVectors(me.pos, cmd.yaw, 0);
      const f = dot(nav.dir, vv.forward), r = dot(nav.dir, vv.right);
      const m = Math.max(1e-6, Math.hypot(f, r));
      cmd.moveY = nav.stop ? 0 : f / m;
      cmd.moveX = nav.stop ? 0 : r / m;
      if (nav.hiding) return keepFooting(state, me, cmd); // no shooting from (or on the way to) cover
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
  if (behaviour !== 'hold' && !navigating && heightAboveFloor(state, me) < 0.5 && hash01(playerId, tick >> 6, 8) < 0.06) cmd.buttons |= BTN_JUMP;
  return keepFooting(state, me, cmd);
}
