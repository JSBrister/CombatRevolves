// Scripted bots. A bot is just a function state -> InputCmd: it drives its
// player through exactly the same input path as a human. Pure and
// deterministic (uses a stateless hash, never the sim RNG or Math.random), so
// a server can run bots without disturbing replays.

import { localBasis } from './physics';
import { hash01 } from './rng';
import { BTN_FIRE, BTN_GRENADE, BTN_GRENADE2, BTN_JUMP, BTN_SPRINT, WEAPON_PISTOL, WEAPON_RIFLE, type InputCmd, type SimState } from './types';
import { type Vec3, dot, len, sub } from './vec';
import { EYE_OFFSET } from './world';

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

  // Wander: a waypoint that changes every ~5 s.
  const epoch = Math.floor(tick / 600);
  const wpAng = Math.atan2(me.pos[1], me.pos[0]) + (hash01(playerId, epoch, 1) - 0.5) * (60 / R);
  const wpZ = (hash01(playerId, epoch, 2) - 0.5) * 30;
  const wp: Vec3 = [R * Math.cos(wpAng), R * Math.sin(wpAng), wpZ];
  const toWp = aimAt(me.pos, wp);
  cmd.yaw = toWp.yaw;
  cmd.pitch = 0;
  cmd.moveY = 1;
  if (hash01(playerId, epoch, 3) < 0.3) cmd.buttons |= BTN_SPRINT;

  // Target: nearest living non-dummy opponent within 45 m.
  let target = null as (typeof state.players)[number] | null;
  let best = 45;
  for (const p of state.players) {
    if (p.id === playerId || !p.alive || p.kind === 'dummy') continue;
    const d = len(sub(p.pos, me.pos));
    if (d < best) { best = d; target = p; }
  }
  if (target) {
    const eye: Vec3 = [...me.pos] as Vec3;
    const up = localBasis(me.pos).up;
    for (let i = 0; i < 3; i++) eye[i] += up[i] * EYE_OFFSET;
    const aim = aimAt(eye, target.pos);
    // Bots aim straight at you and let Coriolis ruin their day. Add a little jitter.
    cmd.yaw = aim.yaw + (hash01(playerId, tick >> 4, 4) - 0.5) * 0.08;
    cmd.pitch = aim.pitch + (hash01(playerId, tick >> 4, 5) - 0.5) * 0.05;
    cmd.moveY = best > 15 ? 1 : 0;
    cmd.moveX = hash01(playerId, tick >> 7, 6) < 0.5 ? -1 : 1;
    cmd.weapon = hash01(playerId, tick >> 11, 7) < 0.7 ? WEAPON_RIFLE : WEAPON_PISTOL;
    const burst = (tick >> 5) % 4 !== 0;
    if (cmd.weapon === WEAPON_RIFLE) {
      if (burst && me.rifleHeat < 0.85) cmd.buttons |= BTN_FIRE;
    } else if ((tick >> 3) % 3 === 0) cmd.buttons |= BTN_FIRE; // tap tap
    // Grenade: hold for 0.25 s then release, every ~8 s, if close.
    const gPhase = (tick + playerId * 97) % 960;
    if (best < 28 && gPhase < 30) cmd.buttons |= hash01(playerId, tick / 960 | 0, 9) < 0.5 ? BTN_GRENADE : BTN_GRENADE2;
  }
  if (hash01(playerId, tick >> 6, 8) < 0.06) cmd.buttons |= BTN_JUMP;
  return cmd;
}
