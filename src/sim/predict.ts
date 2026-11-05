// Trajectory preview computed with the real sim physics (same launch rule,
// same propagation, same level sweep). Pure: does not touch the state.

import { setSdfFrame, sphereTrace } from './level';
import { frameOf, frameOmega } from './twin';
import { advanceFree, planetPullAt, setSpinAlpha } from './physics';
import { GRENADE_RADIUS, boltStats, launchVelocity, moveSphereBody, muzzlePoint, type SphereBody } from './step';
import { DT, spinAt, type BoltKind, type SimState, type ThrownKind } from './types';
import { type Vec3, clone } from './vec';

export interface Prediction {
  points: Vec3[];
  hit: Vec3 | null;
}

export function predictTrajectory(
  state: SimState, playerId: number, kind: BoltKind | ThrownKind, yaw: number, pitch: number,
  maxSeconds = 22, sampleEvery = 2,
): Prediction {
  const p = state.players.find((q) => q.id === playerId);
  if (!p) return { points: [], hit: null };
  const thrown = kind === 'grenade' || kind === 'bounceGrenade';
  const from = muzzlePoint(p, yaw, pitch, thrown);
  const r = clone(from);
  const v = launchVelocity(state.config, p, kind, from, yaw, pitch);
  const radius = thrown ? GRENADE_RADIUS : boltStats(state.config, kind as BoltKind).radius;
  const spin = spinAt(state.config, state.tick);
  const pf = frameOf(state.config, p.pos);
  setSdfFrame(pf, state.frameAngle);
  const omega = frameOmega(spin.omega, pf);
  setSpinAlpha(spin.alpha);
  const points: Vec3[] = [clone(r)];
  if (kind === 'bounceGrenade') {
    // Bounces until the fuse runs out; the "hit" marker is where it goes off.
    const body: SphereBody = { pos: r, vel: v, radius, contactNormal: null };
    const fuse = Math.round(state.config.bounceFuse / DT);
    for (let i = 0; i < fuse; i++) {
      moveSphereBody(state.level, state.config, omega, body, state.config.bounceRestitution, DT, planetPullAt(state.config, state.frameAngle + omega * i * DT));
      if (i % sampleEvery === 0) points.push(clone(body.pos));
    }
    points.push(clone(body.pos));
    return { points, hit: clone(body.pos) };
  }
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i++) {
    const p0 = clone(r);
    advanceFree(r, v, DT, omega, state.config, planetPullAt(state.config, state.frameAngle + omega * i * DT));
    const hit = sphereTrace(state.level, state.config, p0, r, radius);
    if (hit) {
      points.push(hit.pos);
      return { points, hit: hit.pos };
    }
    if (i % sampleEvery === 0) points.push(clone(r));
  }
  return { points, hit: null };
}
