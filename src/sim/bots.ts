// Scripted bots. A bot is just a function state -> InputCmd: it drives its
// player through exactly the same input path as a human. Pure and
// deterministic (uses a stateless hash, never the sim RNG or Math.random), so
// a server can run bots without disturbing replays.

import { localBasis } from './physics';
import { hash01 } from './rng';
import { BTN_FIRE, BTN_GRENADE, BTN_GRENADE2, BTN_JUMP, BTN_MELEE, BTN_SPRINT, WEAPON_HOVER, WEAPON_IDS, type InputCmd, type SimState } from './types';
import { type Vec3, dot, len, sub } from './vec';
import { ENEMY_TYPES } from './tuning';
import { eyeOffset } from './world';

/** Local-frame yaw/pitch that points from `from` toward `to` (straight line, ignoring physics). */
export function aimAt(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const b = localBasis(from);
  const d = sub(to, from);
  const ft = dot(d, b.spin), fz = dot(d, b.axial), fu = dot(d, b.up);
  return { yaw: Math.atan2(fz, ft), pitch: Math.atan2(fu, Math.hypot(ft, fz)) };
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
    const aim = aimAt(eye, target.pos);
    // Bots aim straight at you and let Coriolis ruin their day, plus some wobble.
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
    if (type) {
      cmd.weapon = WEAPON_IDS.indexOf(type.weapon);
    } else {
      // Pick one of the weapons we own for a few seconds at a time; prefer the new toys.
      const options = me.owned.filter((w) => w !== WEAPON_HOVER);
      const special = options.filter((w) => w > 1 && (state.config.weapons[WEAPON_IDS[w]].magSize === 0 || me.mag[w] + me.ammo[w] > 0));
      const pool = special.length && hash01(playerId, tick >> 10, 10) < 0.6 ? special : options;
      cmd.weapon = pool[Math.floor(hash01(playerId, tick >> 10, 7) * pool.length)] ?? 0;
    }
    const id = WEAPON_IDS[cmd.weapon];
    const burst = (tick >> 5) % 4 !== 0;
    if (id === 'rifle' || id === 'redRifle') {
      if (burst && me.heat[cmd.weapon] < 0.85) cmd.buttons |= BTN_FIRE;
    } else if (id === 'laconic') {
      if ((tick >> 8) % 2 === 0) cmd.buttons |= BTN_FIRE; // hold to charge; it streams by itself
    } else if (id === 'cannon') {
      if ((tick >> 4) % 4 === 0) cmd.buttons |= BTN_FIRE; // one careful shot at a time
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
