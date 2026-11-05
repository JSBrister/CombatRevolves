// Counter-rotating twin rings. Two rings share an axis, side by side: ring 0
// (z < 0) spins at +omega and ring 1 (z > 0) at -omega. Each body is simulated
// in the frame of the ring it is over (decided by which side of the seam it is
// on), with that ring's spin; when it crosses the seam its position and
// velocity are converted exactly into the other ring's frame. Ring 0's frame
// angle is state.frameAngle (Theta); ring 1's is -Theta.

import type { SimConfig } from './types';
import type { Vec3 } from './vec';

export type Frame = 0 | 1;

/** Which ring's frame a point (in its own frame's coordinates) belongs to. */
export const frameOf = (cfg: SimConfig, p: Vec3): Frame => (cfg.twin && p[2] >= 0 ? 1 : 0);
/** True when two bodies are in different rings' frames (so their coordinates don't compare). */
export const apart = (cfg: SimConfig, a: Vec3, b: Vec3) => cfg.twin && (a[2] >= 0) !== (b[2] >= 0);
/** A frame's spin rate and angle. */
export const frameOmega = (omega: number, f: Frame) => (f ? -omega : omega);
export const frameTheta = (theta: number, f: Frame) => (f ? -theta : theta);

const rot = (v: Vec3, a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
};

/** A point from frame `from` into frame `to` (both at ring-0 angle theta). */
export function convertPoint(p: Vec3, from: Frame, to: Frame, theta: number): Vec3 {
  if (from === to) return p;
  return rot(p, frameTheta(theta, from) - frameTheta(theta, to));
}
/** A direction (or velocity difference) from one frame into the other. */
export const convertDir = convertPoint;

/**
 * Position and velocity from one frame into the other, in place:
 * inertial v = R(theta_f)(v_f + w_f z x r_f), then into frame g and subtract w_g z x r_g.
 */
export function convertBody(r: Vec3, v: Vec3, from: Frame, to: Frame, theta: number, omega: number) {
  if (from === to) return;
  const wf = frameOmega(omega, from), wg = frameOmega(omega, to);
  const vi: Vec3 = [v[0] - wf * r[1], v[1] + wf * r[0], v[2]];
  const a = frameTheta(theta, from) - frameTheta(theta, to);
  const r2 = rot(r, a), v2 = rot(vi, a);
  r[0] = r2[0]; r[1] = r2[1]; r[2] = r2[2];
  v[0] = v2[0] + wg * r2[1]; v[1] = v2[1] - wg * r2[0]; v[2] = v2[2];
}
