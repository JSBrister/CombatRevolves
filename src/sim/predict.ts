// Trajectory preview computed with the real sim physics (same launch rule,
// same propagation, same level sweep). Pure: does not touch the state.

import { sphereTrace } from './level';
import { advanceFree } from './physics';
import { BOLT_SPECS, GRENADE_RADIUS, launchVelocity, muzzlePoint } from './step';
import { DT, omegaOf, type BoltKind, type SimState } from './types';
import { type Vec3, clone } from './vec';

export interface Prediction {
  points: Vec3[];
  hit: Vec3 | null;
}

export function predictTrajectory(
  state: SimState, playerId: number, kind: BoltKind | 'grenade', yaw: number, pitch: number,
  maxSeconds = 22, sampleEvery = 2,
): Prediction {
  const p = state.players.find((q) => q.id === playerId);
  if (!p) return { points: [], hit: null };
  const from = muzzlePoint(p, yaw, pitch, kind === 'grenade');
  const r = clone(from);
  const v = launchVelocity(state.config, p, kind, from, yaw, pitch);
  const radius = kind === 'grenade' ? GRENADE_RADIUS : BOLT_SPECS[kind].radius;
  const omega = omegaOf(state.config);
  const points: Vec3[] = [clone(r)];
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i++) {
    const p0 = clone(r);
    advanceFree(r, v, DT, omega, state.config);
    const hit = sphereTrace(state.level, state.config, p0, r, radius);
    if (hit) {
      points.push(hit.pos);
      return { points, hit: hit.pos };
    }
    if (i % sampleEvery === 0) points.push(clone(r));
  }
  return { points, hit: null };
}
