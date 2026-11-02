// Rotating-frame physics. The frame spins at +omega about world Z; the level is
// static in this frame. Free bodies feel only fictitious forces (+ optional drag):
//
//   a = omega^2 r_perp  (centrifugal, outward)  -  2 omega x v  (Coriolis)  +  a_drag
//
// There is no real gravity anywhere.

import type { SimConfig } from './types';
import { type Vec3, rhoOf } from './vec';

/** Local frame at a point: up = toward the axis, spin = omega x r direction, axial = +Z. */
export interface Basis {
  up: Vec3;
  spin: Vec3;
  axial: Vec3;
}

export function localBasis(r: Vec3): Basis {
  const rho = rhoOf(r);
  if (rho < 1e-9) return { up: [-1, 0, 0], spin: [0, 1, 0], axial: [0, 0, 1] };
  const cx = r[0] / rho, cy = r[1] / rho;
  return { up: [-cx, -cy, 0], spin: [-cy, cx, 0], axial: [0, 0, 1] };
}

/** forward/right/aim directions for a local-frame yaw/pitch at position r. */
export function viewVectors(r: Vec3, yaw: number, pitch: number) {
  const b = localBasis(r);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const forward: Vec3 = [b.spin[0] * cy + b.axial[0] * sy, b.spin[1] * cy + b.axial[1] * sy, b.spin[2] * cy + b.axial[2] * sy];
  // right = forward x up
  const right: Vec3 = [
    forward[1] * b.up[2] - forward[2] * b.up[1],
    forward[2] * b.up[0] - forward[0] * b.up[2],
    forward[0] * b.up[1] - forward[1] * b.up[0],
  ];
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const aim: Vec3 = [forward[0] * cp + b.up[0] * sp, forward[1] * cp + b.up[1] * sp, forward[2] * cp + b.up[2] * sp];
  return { ...b, forward, right, aim };
}

/** Position-dependent part (centrifugal) of the fictitious acceleration. */
export function centrifugalAccel(r: Vec3, omega: number, cfg: SimConfig): Vec3 {
  if (!cfg.centrifugal) return [0, 0, 0];
  const w2 = omega * omega;
  return [w2 * r[0], w2 * r[1], 0];
}

/** Full fictitious acceleration (used for diagnostics and apparent weight). */
export function fictitiousAccel(r: Vec3, v: Vec3, omega: number, cfg: SimConfig): Vec3 {
  const a = centrifugalAccel(r, omega, cfg);
  if (cfg.coriolis) {
    // -2 omega z_hat x v = (2 omega vy, -2 omega vx, 0)
    a[0] += 2 * omega * v[1];
    a[1] -= 2 * omega * v[0];
  }
  return a;
}

/** Jacobi integral per unit mass: conserved for drag-free motion in the rotating frame. */
export function jacobi(r: Vec3, v: Vec3, omega: number): number {
  return 0.5 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) - 0.5 * omega * omega * (r[0] * r[0] + r[1] * r[1]);
}

/** True when free flight is exactly a straight inertial line (analytic path is valid). */
export function analyticValid(cfg: SimConfig): boolean {
  return cfg.centrifugal && cfg.coriolis && (cfg.dragType === 'none' || cfg.dragCoeff === 0);
}

/**
 * Exact drag-free propagation. Take the inertial frame that coincides with the
 * rotating frame at t=0: v_inertial = v_rot + omega x r. The body moves in a
 * straight line there; after time t the rotating frame has turned by omega*t,
 * so rotate the inertial position back by -omega*t, and subtract omega x r to
 * get the rotating-frame velocity. Writes into r/v in place.
 */
export function propagateAnalytic(r: Vec3, v: Vec3, omega: number, t: number): void {
  const vix = v[0] - omega * r[1];
  const viy = v[1] + omega * r[0];
  const viz = v[2];
  const px = r[0] + vix * t, py = r[1] + viy * t, pz = r[2] + viz * t;
  const c = Math.cos(omega * t), s = Math.sin(omega * t);
  const x = c * px + s * py, y = -s * px + c * py;
  const vx = c * vix + s * viy, vy = -s * vix + c * viy;
  r[0] = x; r[1] = y; r[2] = pz;
  v[0] = vx + omega * y;
  v[1] = vy - omega * x;
  v[2] = viz;
}

function applyDrag(v: Vec3, h: number, cfg: SimConfig) {
  if (cfg.dragType === 'none' || cfg.dragCoeff <= 0) return;
  let f: number;
  if (cfg.dragType === 'linear') f = Math.exp(-cfg.dragCoeff * h); // exact for dv/dt = -k v
  else f = 1 / (1 + cfg.dragCoeff * Math.hypot(v[0], v[1], v[2]) * h); // exact for |v| under dv/dt = -c|v|v
  v[0] *= f; v[1] *= f; v[2] *= f;
}

function kick(r: Vec3, v: Vec3, h: number, omega: number, cfg: SimConfig, support: Vec3 | null) {
  if (!cfg.centrifugal) return;
  const w2 = omega * omega;
  let ax = w2 * r[0], ay = w2 * r[1], az = 0;
  if (support) {
    // Contact constraint: a surface we rest on cancels the part of the
    // fictitious force pushing into it (the normal force). `support` is the
    // surface normal pointing out of the surface.
    const an = ax * support[0] + ay * support[1] + az * support[2];
    if (an < 0) { ax -= an * support[0]; ay -= an * support[1]; az -= an * support[2]; }
  }
  v[0] += ax * h; v[1] += ay * h; v[2] += az * h;
}

function coriolisRotate(v: Vec3, h: number, omega: number, cfg: SimConfig) {
  if (!cfg.coriolis) return;
  // dv/dt = -2 omega z x v rotates v's xy part at rate -2 omega: solve exactly.
  const a = -2 * omega * h;
  const c = Math.cos(a), s = Math.sin(a);
  const x = v[0], y = v[1];
  v[0] = c * x - s * y;
  v[1] = s * x + c * y;
}

/**
 * One integrator step, in place.
 *
 * Choice: symmetric (Strang) splitting of three exactly-solvable sub-flows,
 *   D(h/2) K(h/2) C(h/2) X(dt) C(h/2) K(h/2) D(h/2)
 * with K = centrifugal kick, C = exact Coriolis rotation, X = drift, D = drag.
 * This is the rotating-frame analogue of the Boris pusher used for charged
 * particles in magnetic fields (Coriolis acts exactly like a magnetic force):
 *  - each sub-flow is volume preserving and the composition is time-reversible
 *    and 2nd order, so the Jacobi integral shows bounded oscillation with no
 *    secular drift over thousands of seconds (RK4 is 4th order but slowly
 *    bleeds/gains energy and costs 4 force evaluations);
 *  - the Coriolis rotation preserves |v| exactly, so it never does work;
 *  - it is trivially deterministic and cheap enough for hundreds of bodies.
 * When drag = 0 projectiles bypass this and use propagateAnalytic instead.
 */
export function integrate(r: Vec3, v: Vec3, dt: number, omega: number, cfg: SimConfig, support: Vec3 | null = null) {
  const h = dt / 2;
  applyDrag(v, h, cfg);
  kick(r, v, h, omega, cfg, support);
  coriolisRotate(v, h, omega, cfg);
  r[0] += v[0] * dt; r[1] += v[1] * dt; r[2] += v[2] * dt;
  coriolisRotate(v, h, omega, cfg);
  kick(r, v, h, omega, cfg, support);
  applyDrag(v, h, cfg);
}

/** Advance a free projectile by dt using the exact path when valid, otherwise the integrator. */
export function advanceFree(r: Vec3, v: Vec3, dt: number, omega: number, cfg: SimConfig) {
  if (analyticValid(cfg)) propagateAnalytic(r, v, omega, dt);
  else integrate(r, v, dt, omega, cfg);
}
