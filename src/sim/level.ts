// Static level geometry (in the rotating frame) and its signed distance field.
// Solids: the cylindrical hull (floor), two rim walls, and obstacle boxes that
// are axis-aligned in the local frame of their ring angle.

import { rngNext, rngRange } from './rng';
import type { Box, Bump, Deck, Hole, ItemKind, Level, Pad, SimConfig, SpawnPoint } from './types';
import { type Vec3, rhoOf } from './vec';
import { towerSdf } from './tower';
import { type ClearZone, diskBumpsAt, edgeHeight, floorRadius, makeBumps, makeHills, makeMountains, planetBumpsAt, terrainAt } from './terrain';

export interface SdfHit {
  d: number; // signed distance (negative = inside solid)
  n: Vec3; // outward normal of the nearest solid
}

/** 2D box distance in (rho, z) space for solids of revolution. */
function annulus(p: Vec3, rho: number, rMin: number, rMax: number, zMin: number, zMax: number, out: SdfHit) {
  const cr = (rMin + rMax) / 2, hr = (rMax - rMin) / 2;
  const cz = (zMin + zMax) / 2, hz = (zMax - zMin) / 2;
  const qr = Math.abs(rho - cr) - hr;
  const qz = Math.abs(p[2] - cz) - hz;
  let d: number, nr: number, nz: number;
  if (qr > 0 || qz > 0) {
    const ur = Math.max(qr, 0), uz = Math.max(qz, 0);
    d = Math.sqrt(ur * ur + uz * uz);
    nr = (ur / d) * Math.sign(rho - cr);
    nz = (uz / d) * Math.sign(p[2] - cz);
  } else if (qr > qz) {
    d = qr; nr = Math.sign(rho - cr) || 1; nz = 0;
  } else {
    d = qz; nr = 0; nz = Math.sign(p[2] - cz) || 1;
  }
  if (d < out.d) {
    const ir = rho > 1e-9 ? 1 / rho : 0;
    out.d = d;
    out.n = [nr * p[0] * ir, nr * p[1] * ir, nz];
  }
}

/**
 * Like `annulus`, but limited to the angular sector [a0, a1]. Only used for a
 * taller neighbouring wall sector, so the query point is outside the sector;
 * the angular part is the exact distance to the sector's edge half-plane.
 */
function sectorAnnulus(p: Vec3, rho: number, theta: number, rMin: number, rMax: number, zMin: number, zMax: number, a0: number, a1: number, out: SdfHit) {
  const cr = (rMin + rMax) / 2, hr = (rMax - rMin) / 2;
  const cz = (zMin + zMax) / 2, hz = (zMax - zMin) / 2;
  const ur = Math.max(Math.abs(rho - cr) - hr, 0);
  const uz = Math.max(Math.abs(p[2] - cz) - hz, 0);
  // angular distance to the nearer edge (point lies outside [a0, a1])
  const d0 = Math.abs(wrapAngle(theta - a0)), d1 = Math.abs(wrapAngle(theta - a1));
  const edge = d0 < d1 ? a0 : a1;
  const dAng = Math.min(d0, d1, Math.PI / 2);
  const ut = rho * Math.sin(dAng);
  const d = Math.sqrt(ur * ur + uz * uz + ut * ut);
  if (d >= out.d || d < 1e-9) return;
  const ir = rho > 1e-9 ? 1 / rho : 0;
  const nr = (ur / d) * Math.sign(rho - cr), nz = (uz / d) * Math.sign(p[2] - cz);
  const side = Math.sign(wrapAngle(theta - edge)); // + = spinward of the edge
  const nt = (ut / d) * side;
  out.d = d;
  out.n = [nr * p[0] * ir - nt * p[1] * ir, nr * p[1] * ir + nt * p[0] * ir, nz];
}

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Sector index (0..n-1) containing ring angle theta. */
export function sectorOf(theta: number, n: number): number {
  const t = theta < 0 ? theta + 2 * Math.PI : theta;
  return Math.min(n - 1, Math.floor((t / (2 * Math.PI)) * n));
}

/** Rim wall on one side: per-sector heights; neighbours that are taller are included with exact edges. */
function rimWall(p: Vec3, rho: number, theta: number, heights: number[], R: number, rOut: number, zMin: number, zMax: number, out: SdfHit) {
  const n = heights.length;
  if (n === 0) return;
  const i = sectorOf(theta, n);
  const h = heights[i];
  annulus(p, rho, R - h, rOut, zMin, zMax, out);
  const step = (2 * Math.PI) / n;
  for (const j of [(i + n - 1) % n, (i + 1) % n]) {
    if (heights[j] <= h) continue;
    sectorAnnulus(p, rho, theta, R - heights[j], rOut, zMin, zMax, j * step, (j + 1) * step, out);
  }
}

/**
 * Floor with a height profile: solid where rho > R - h(angle, z), clipped to
 * the ring's width and the hull's outside. Distance estimate -F/|grad F|.
 */
function terrainFloor(level: Level, cfg: SimConfig, p: Vec3, rho: number, theta: number, out: SdfHit) {
  const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness;
  const tr = level.terrain!;
  if (tr.tube && !tr.hills.length && !tr.ridge && !tr.sphere) {
    const f: SdfHit = { d: Infinity, n: [0, 0, 1] };
    tubeSdf(p, rho, cfg.R, tr.tube.kind, tr.tube.radius, f);
    if (tr.tube.kind === 'half') {
      // the half-pipe's lips are only a wall's thickness wide: beyond them, space
      const dSide = Math.abs(p[2]) - (tr.tube.radius + T);
      if (dSide > f.d) { f.d = dSide; f.n = [0, 0, Math.sign(p[2]) || 1]; }
    }
    if (f.d < out.d) { out.d = f.d; out.n = f.n; }
    return;
  }
  if (tr.sphere && !tr.hills.length && !tr.ridge) {
    // a plain sphere: the exact distance (the height-field estimate breaks down near the poles)
    const r = Math.hypot(p[0], p[1], p[2]);
    const d = Math.max(R - r, Math.abs(p[2]) - (W + T), rho - (R + cfg.hullThickness));
    if (d >= out.d) return;
    out.d = d;
    if (d === R - r) out.n = r > 1e-9 ? [-p[0] / r, -p[1] / r, -p[2] / r] : [0, 0, 1];
    else if (d === rho - (R + cfg.hullThickness)) out.n = [p[0] / Math.max(rho, 1e-9), p[1] / Math.max(rho, 1e-9), 0];
    else out.n = [0, 0, Math.sign(p[2]) || 1];
    return;
  }
  const t = terrainAt(level, cfg, theta, p[2]);
  const F = rho - (R - t.h);
  // grad F = r_hat + dh/ds * spin_hat + dh/dz * z_hat
  const g = Math.sqrt(1 + t.dhds * t.dhds + t.dhdz * t.dhdz);
  const dFloor = -F / g;
  const dSide = Math.abs(p[2]) - (W + T);
  const dOut = rho - (R + cfg.hullThickness);
  const d = Math.max(dFloor, dSide, dOut);
  if (d >= out.d) return;
  out.d = d;
  const ir = rho > 1e-9 ? 1 / rho : 0;
  const cx = p[0] * ir, cy = p[1] * ir; // r_hat
  if (d === dFloor) {
    // outward normal of the solid = -grad F / |grad F|
    out.n = [(-cx + t.dhds * cy) / g, (-cy - t.dhds * cx) / g, -t.dhdz / g];
  } else if (d === dSide) out.n = [0, 0, Math.sign(p[2]) || 1];
  else out.n = [cx, cy, 0];
}

/** A box with its own world-space axes (planet worlds). */
function axesBoxSdf(p: Vec3, b: Box, out: SdfHit) {
  const [X, Y, Z] = b.axes!;
  const dx = p[0] - b.center[0], dy = p[1] - b.center[1], dz = p[2] - b.center[2];
  const h0 = b.half[0], h1 = b.half[1], h2 = b.half[2];
  const lim = out.d + Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2);
  if (lim > 0 && dx * dx + dy * dy + dz * dz >= lim * lim) return;
  const lx = X[0] * dx + X[1] * dy + X[2] * dz, ly = Y[0] * dx + Y[1] * dy + Y[2] * dz, lz = Z[0] * dx + Z[1] * dy + Z[2] * dz;
  const qx = Math.abs(lx) - h0, qy = Math.abs(ly) - h1, qz = Math.abs(lz) - h2;
  let d: number, nx = 0, ny = 0, nz = 0;
  if (qx > 0 || qy > 0 || qz > 0) {
    const ux = Math.max(qx, 0), uy = Math.max(qy, 0), uz = Math.max(qz, 0);
    d = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (d >= out.d) return;
    nx = (ux / d) * Math.sign(lx); ny = (uy / d) * Math.sign(ly); nz = (uz / d) * Math.sign(lz);
  } else {
    d = Math.max(qx, qy, qz);
    if (d >= out.d) return;
    if (d === qx) nx = Math.sign(lx) || 1; else if (d === qy) ny = Math.sign(ly) || 1; else nz = Math.sign(lz) || 1;
  }
  out.d = d;
  out.n = [X[0] * nx + Y[0] * ny + Z[0] * nz, X[1] * nx + Y[1] * ny + Z[1] * nz, X[2] * nx + Y[2] * ny + Z[2] * nz];
}

function boxSdf(p: Vec3, b: Box, out: SdfHit) {
  if (b.axes) return axesBoxSdf(p, b, out);
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  // local axes: spin = (-s, c, 0), up = (-c, -s, 0), axial = (0,0,1)
  const dx = p[0] - b.center[0], dy = p[1] - b.center[1], dz = p[2] - b.center[2];
  // (spinward, up) components, then rotate into the box's tilted frame
  let ls = -s * dx + c * dy;
  const lu = -c * dx - s * dy;
  let lz = dz;
  const cy = b.yaw ? Math.cos(b.yaw) : 1, sy = b.yaw ? Math.sin(b.yaw) : 0;
  if (b.yaw) { const a = cy * ls + sy * lz; lz = -sy * ls + cy * lz; ls = a; } // into the box's turned frame
  const ct = Math.cos(b.tilt), st = Math.sin(b.tilt);
  const lx = ct * ls + st * lu;
  const ly = -st * ls + ct * lu;
  // cheap reject: can't beat the current best distance (squared, no sqrt/hypot)
  const h0 = b.half[0], h1 = b.half[1], h2 = b.half[2];
  const lim = out.d + Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2);
  if (lim > 0 && dx * dx + dy * dy + dz * dz >= lim * lim) return;
  const qx = Math.abs(lx) - b.half[0], qy = Math.abs(ly) - b.half[1], qz = Math.abs(lz) - b.half[2];
  let d: number, nx = 0, ny = 0, nz = 0;
  if (qx > 0 || qy > 0 || qz > 0) {
    const ux = Math.max(qx, 0), uy = Math.max(qy, 0), uz = Math.max(qz, 0);
    d = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (d >= out.d) return;
    nx = (ux / d) * Math.sign(lx); ny = (uy / d) * Math.sign(ly); nz = (uz / d) * Math.sign(lz);
  } else {
    d = Math.max(qx, qy, qz);
    if (d >= out.d) return;
    if (d === qx) nx = Math.sign(lx) || 1;
    else if (d === qy) ny = Math.sign(ly) || 1;
    else nz = Math.sign(lz) || 1;
  }
  out.d = d;
  // undo the tilt and the turn, then back to world: spin*ns + up*nu + axial*nz
  let ns = ct * nx - st * ny;
  const nu = st * nx + ct * ny;
  if (b.yaw) { const a = cy * ns - sy * nz; nz = sy * ns + cy * nz; ns = a; }
  out.n = [-s * ns - c * nu, c * ns - s * nu, nz];
}

/**
 * Tube worlds: the cross-section (rho, z) is a circle of radius a touching
 * rho = R at z = 0. Inside a torus the solid is everything outside the
 * circle; a half torus is that, but only out from the tube's centre line
 * (open toward the axis); outside a torus the solid is the circle itself.
 */
function tubeSdf(p: Vec3, rho: number, R: number, kind: 'inside' | 'half' | 'outside', a: number, out: SdfHit) {
  const rc = kind === 'outside' ? R + a : R - a;
  const qr = rho - rc, qz = p[2];
  const q = Math.hypot(qr, qz);
  const ir = rho > 1e-9 ? 1 / rho : 0;
  const cx = p[0] * ir, cy = p[1] * ir;
  let d: number, nr: number, nz: number;
  if (kind === 'half' && qr < 0) {
    // above the lips: the nearest solid is a lip edge (rc, +-a) or the wall of solid beyond it
    const zp = Math.abs(qz) >= a ? qz : Math.sign(qz || 1) * a;
    const vr = qr, vz = qz - zp;
    d = Math.hypot(vr, vz);
    if (d < 1e-9) { nr = 0; nz = -Math.sign(qz || 1); } else { nr = vr / d; nz = vz / d; }
  } else if (kind === 'outside') {
    d = q - a;
    nr = q > 1e-9 ? qr / q : -1; nz = q > 1e-9 ? qz / q : 0;
  } else {
    d = a - q;
    nr = q > 1e-9 ? -qr / q : -1; nz = q > 1e-9 ? -qz / q : 0;
  }
  if (d >= out.d) return;
  out.d = d;
  out.n = [nr * cx, nr * cy, nz];
}

/** How far up a lift is at time t: waits at the bottom, rises, waits at the top, comes down (smoothly). */
export function liftOffset(l: NonNullable<Box['lift']>, t: number): number {
  const u = ((((t / l.period + l.phase) % 1) + 1) % 1) * 4;
  const smooth = (x: number) => x * x * (3 - 2 * x);
  if (u < 1) return 0;
  if (u < 2) return l.travel * smooth(u - 1);
  if (u < 3) return l.travel;
  return l.travel * (1 - smooth(u - 3));
}

/** Signed distance to a hole's prism (positive outside it), and its gradient. */
function holeSdf(p: Vec3, theta: number, h: Hole, R: number): SdfHit {
  const s = wrapAngle(theta - h.angle) * R;
  const dz = p[2] - h.z;
  const qs = Math.abs(s) - h.halfArc, qz = Math.abs(dz) - h.halfZ;
  let d: number, gs = 0, gz = 0;
  if (qs > 0 || qz > 0) {
    const us = Math.max(qs, 0), uz = Math.max(qz, 0);
    d = Math.hypot(us, uz);
    gs = (us / d) * Math.sign(s); gz = (uz / d) * Math.sign(dz);
  } else if (qs > qz) { d = qs; gs = Math.sign(s) || 1; } else { d = qz; gz = Math.sign(dz) || 1; }
  const c = Math.cos(theta), sn = Math.sin(theta);
  return { d, n: [-sn * gs, c * gs, gz] };
}

/** Cut holes out of a solid: intersect it with the outside of each hole's prism. */
function cutHoles(p: Vec3, theta: number, holes: Hole[], R: number, hit: SdfHit) {
  for (const h of holes) {
    // cheap reject: only a point inside (or right by) the prism can change anything
    if (Math.abs(wrapAngle(theta - h.angle)) * R > h.halfArc + Math.max(0, -hit.d) + 0.5) continue;
    const hs = holeSdf(p, theta, h, R);
    if (-hs.d > hit.d) { hit.d = -hs.d; hit.n = [-hs.n[0], -hs.n[1], -hs.n[2]]; }
  }
}

/**
 * Twin rings: which frame SDF queries come from (set before each body's update,
 * like the spin's alpha), so a box belonging to the other ring can be rotated
 * into place. Ring 0's angle is theta, ring 1's is -theta.
 */
let sdfFrame: 0 | 1 = 0, sdfTheta = 0;
export function setSdfFrame(f: 0 | 1, theta: number) { sdfFrame = f; sdfTheta = theta; }

/** Signed distance from p to the level. Positive in free space. */
export function levelSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  switch (level.shape) {
    case 'ring':
      return ringSdf(level, cfg, p);
    case 'planet':
      return planetSdf(level, cfg, p);
    case 'disk':
      return diskSdf(level, cfg, p);
    case 'tower': {
      const out: SdfHit = { d: Infinity, n: [0, 0, 1] };
      towerSdf(level.tower!, p, out);
      for (const b of level.boxes) boxSdf(p, b, out);
      return out;
    }
  }
}

export const DISK_THICKNESS = 8;
/** Disk world: height of the surface at distance rho from the axis (0 on a flat disk), and its slope. */
export function diskSurface(cfg: SimConfig, rho: number): { h: number; dh: number } {
  if (!cfg.diskBowl) return { h: 0, dh: 0 };
  // a paraboloid h = w^2 rho^2 / 2g, with w^2 = planetSpin g / R: its normal lines up with g_eff everywhere
  const k = cfg.planetSpin / cfg.R;
  return { h: 0.5 * k * rho * rho, dh: k * rho };
}

/** Disk world: height of the surface at (x, y) with any hills, and its slope. */
export function diskHeight(cfg: SimConfig, bumps: Bump[] | undefined, x: number, y: number): { h: number; gx: number; gy: number } {
  const rho = Math.hypot(x, y);
  const { h, dh } = diskSurface(cfg, Math.min(rho, cfg.R));
  const ir = rho > 1e-9 ? 1 / rho : 0;
  const b = diskBumpsAt(bumps, x, y);
  return { h: h + b.h, gx: dh * x * ir + b.gx, gy: dh * y * ir + b.gy };
}

/** The top of a spinning disk (flat, or curved up into a bowl), plus what stands on it. */
function diskSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  const out: SdfHit = { d: Infinity, n: [0, 0, 1] };
  const rho = rhoOf(p);
  if (level.bumps?.length) {
    // hills on it: a height field (the underside stays as it was)
    const { h, gx, gy } = diskHeight(cfg, level.bumps, p[0], p[1]);
    const g = Math.sqrt(1 + gx * gx + gy * gy);
    // (a height field's -F/|grad F| can overstate the room a little next to a hill: shrink it in free space, so tracing stays safe)
    const dF = (p[2] - h) / g, dTop = dF > 0 ? 0.9 * dF : dF;
    const base = diskSurface(cfg, Math.min(rho, cfg.R));
    const dBottom = (base.h - DISK_THICKNESS - p[2]) / Math.sqrt(1 + base.dh * base.dh), dRim = rho - cfg.R;
    const d = Math.max(dTop, dBottom, dRim);
    out.d = d;
    if (d === dTop) out.n = [-gx / g, -gy / g, 1 / g];
    else if (d === dRim) out.n = [p[0] / rho, p[1] / rho, 0];
    else out.n = [0, 0, -1];
  } else if (!cfg.diskBowl) annulus(p, rho, 0, cfg.R, -DISK_THICKNESS, 0, out);
  else {
    // solid below the surface z = h(rho), above it minus the thickness, inside the rim
    const { h, dh } = diskSurface(cfg, Math.min(rho, cfg.R));
    const g = Math.sqrt(1 + dh * dh);
    const dTop = (p[2] - h) / g, dBottom = (h - DISK_THICKNESS - p[2]) / g, dRim = rho - cfg.R;
    const d = Math.max(dTop, dBottom, dRim);
    out.d = d;
    const ir = rho > 1e-9 ? 1 / rho : 0;
    if (d === dTop) out.n = [(-dh * p[0] * ir) / g, (-dh * p[1] * ir) / g, 1 / g];
    else if (d === dRim) out.n = [p[0] * ir, p[1] * ir, 0];
    else out.n = [0, 0, -1];
  }
  for (const b of level.boxes) boxSdf(p, b, out);
  return out;
}

/** A point on a disk world's surface at (angle, distance from the axis), with the surface's normal. */
export function diskPoint(cfg: SimConfig, angle: number, rho: number, bumps?: Bump[]): { pos: Vec3; n: Vec3 } {
  const c = Math.cos(angle), s = Math.sin(angle);
  const { h, gx, gy } = diskHeight(cfg, bumps, rho * c, rho * s);
  const g = Math.sqrt(1 + gx * gx + gy * gy);
  return { pos: [rho * c, rho * s, h], n: [-gx / g, -gy / g, 1 / g] };
}

/**
 * A disk world: spawn points in a ring part-way out, cover and towers
 * standing straight out of the surface, pickups. Spawn points use
 * (angle, z = distance from the axis).
 */
export function generateDisk(cfg: SimConfig, rng: { rng: number }, withObstacles: boolean, nextId: () => number): Level {
  const R = cfg.R;
  const spawns: SpawnPoint[] = [];
  for (let i = 0; i < 8; i++) spawns.push({ angle: (i / 8) * 2 * Math.PI, z: (i % 2 ? 0.25 : 0.45) * R });
  // hills and mountains: anywhere out to near the rim (a mountain's foot can reach past it)
  const bumps = makeBumps(cfg, () => rngNext(rng), (u, v, radius) => {
    const rho = Math.min(R * 0.9, radius) + Math.sqrt(u) * Math.max(0, R * 0.9 - radius), a = v * 2 * Math.PI;
    return [rho * Math.cos(a), rho * Math.sin(a), 0];
  });
  const boxes: Box[] = [];
  const pickupSpots: { pos: Vec3; item: ItemKind }[] = [];
  const stand = (angle: number, rho: number, heading: number, hx: number, hy: number, hz: number, kind: Box['kind'] = 'cover') => {
    const { pos, n } = diskPoint(cfg, angle, rho, bumps);
    const t0: Vec3 = [-Math.sin(angle), Math.cos(angle), 0]; // round the disk
    const t1: Vec3 = [n[1] * t0[2] - n[2] * t0[1], n[2] * t0[0] - n[0] * t0[2], n[0] * t0[1] - n[1] * t0[0]]; // outward, along the surface
    const ch = Math.cos(heading), sh = Math.sin(heading);
    const X: Vec3 = [ch * t0[0] + sh * t1[0], ch * t0[1] + sh * t1[1], ch * t0[2] + sh * t1[2]];
    const Z: Vec3 = [X[1] * n[2] - X[2] * n[1], X[2] * n[0] - X[0] * n[2], X[0] * n[1] - X[1] * n[0]];
    const slope = Math.sqrt(Math.max(0, 1 / (n[2] * n[2]) - 1)); // how steep the ground is here
    const bury = 0.3 + (cfg.diskBowl ? (cfg.planetSpin / R) * Math.max(hx, hz) * Math.max(hx, hz) : 0) + (bumps.length ? slope * Math.max(hx, hz) : 0);
    const c: Vec3 = [pos[0] + n[0] * (hy - bury), pos[1] + n[1] * (hy - bury), pos[2] + n[2] * (hy - bury)];
    boxes.push({ id: nextId(), type: 'box', kind, angle, tilt: 0, center: c, half: [hx, hy + bury, hz], axes: [X, n, Z] });
  };
  const near = (angle: number, rho: number, m: number) => spawns.some((sp) => {
    const a = diskPoint(cfg, sp.angle, sp.z, bumps).pos, b = diskPoint(cfg, angle, rho, bumps).pos;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < m;
  });
  if (withObstacles) {
    const n = Math.max(20, Math.min(200, Math.round((Math.PI * R * R) / 600)));
    const k = Math.min(1, R / 80);
    for (let i = 0; i < n; i++) {
      const angle = rngNext(rng) * 2 * Math.PI, rho = R * Math.sqrt(rngRange(rng, 0.01, 0.95)); // even over the area
      if (near(angle, rho, 6)) continue;
      const kind = rngNext(rng), heading = rngNext(rng) * Math.PI;
      if (kind < 0.45) stand(angle, rho, heading, rngRange(rng, 1, 2.5), rngRange(rng, 0.5, 0.9) * k, rngRange(rng, 0.3, 0.6), 'struct');
      else if (kind < 0.7) stand(angle, rho, Math.PI / 4, 1.1, rngRange(rng, 1.5, 3) * k, 1.1, 'struct');
      else if (kind < 0.9) stand(angle, rho, heading, rngRange(rng, 1, 2), rngRange(rng, 0.4, 0.8) * k, rngRange(rng, 1, 2));
      else stand(angle, rho, heading, 1.6, rngRange(rng, 4, 8) * k, 1.6, 'struct');
    }
    const items: ItemKind[] = ['health', 'sticky', 'redRifle', 'bounce', 'launcher', 'scatter', 'cannon', 'rocket', 'health', 'revolver', 'seeker', 'jetpack'];
    for (let i = 0; i < items.length; i++) {
      const angle = i * 2.39996, rho = R * Math.sqrt((i + 0.5) / items.length) * 0.85;
      if (near(angle, rho, 4)) continue;
      const { pos, n } = diskPoint(cfg, angle, rho, bumps);
      pickupSpots.push({ pos: [pos[0] + n[0], pos[1] + n[1], pos[2] + n[2]], item: items[i] });
    }
  }
  return { shape: 'disk', terrain: null, boxes, stairTops: [], spawns, pickupSpots, vehicleSpots: [], wallPos: [], wallNeg: [], ...(bumps.length ? { bumps } : {}) };
}

/** The outside of a ball of radius R, plus whatever stands on it. */
function planetSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  const r = Math.hypot(p[0], p[1], p[2]) || 1e-9;
  const out: SdfHit = { d: r - cfg.R, n: [p[0] / r, p[1] / r, p[2] / r] };
  if (level.bumps?.length) {
    // hills: F = r - (R + h(n)), grad F = n - (the part of dh/dn across n) / r
    const n: Vec3 = [p[0] / r, p[1] / r, p[2] / r];
    const { h, g } = planetBumpsAt(level.bumps, cfg.R, n);
    const gn = g[0] * n[0] + g[1] * n[1] + g[2] * n[2];
    const G: Vec3 = [n[0] - (g[0] - gn * n[0]) / r, n[1] - (g[1] - gn * n[1]) / r, n[2] - (g[2] - gn * n[2]) / r];
    const gl = Math.hypot(...G);
    const dF = (r - cfg.R - h) / gl;
    out.d = dF > 0 ? 0.9 * dF : dF; // (shrunk in free space: the estimate can overstate the room by a little)
    out.n = [G[0] / gl, G[1] / gl, G[2] / gl];
  }
  // the outer shell: solid beyond radius outerShell
  if (cfg.outerShell > 0 && cfg.outerShell - r < out.d) { out.d = cfg.outerShell - r; out.n = [-p[0] / r, -p[1] / r, -p[2] / r]; }
  for (const b of level.boxes) boxSdf(p, b, out);
  return out;
}

/** Unit vector at longitude `lon` and latitude `lat` (radians) on a planet. */
export const planetDir = (lon: number, lat: number): Vec3 => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

/**
 * A planet: spawn points round the equatorial belt, cover, walls and towers
 * scattered over the surface (standing straight out of it), and pickups.
 * Spawn points and pickups use (angle = longitude, z = metres north).
 */
export function generatePlanet(cfg: SimConfig, rng: { rng: number }, withObstacles: boolean, nextId: () => number): Level {
  const R = cfg.R, R2 = cfg.outerShell;
  const spawns: SpawnPoint[] = [];
  if (R2 > 0) {
    // half on the ball, half on the inside of the shell near its equator
    // (if the spin can beat the ball's gravity, only its poles are safe: spawn up there)
    const ballLat = cfg.planetSpin > 1 ? 1.25 : 0.3;
    for (let i = 0; i < 8; i++) spawns.push(i % 2 ? { angle: (i / 8) * 2 * Math.PI, z: 0.08 * R2 * (i % 4 === 1 ? 1 : -1), outer: true } : { angle: (i / 8) * 2 * Math.PI, z: ballLat * R * (i % 4 === 0 ? 1 : -1) });
  } else for (let i = 0; i < 8; i++) spawns.push({ angle: (i / 8) * 2 * Math.PI, z: (i % 2 ? 1 : -1) * 0.12 * R });
  const pads: Pad[] = [];
  const boxes: Box[] = [];
  const pickupSpots: { pos: Vec3; item: ItemKind }[] = [];
  /** A box standing on the ground at (lon, lat), turned `heading` from east; `lift` raises it off the ground. On the shell, it stands on the inside. */
  const stand = (lon: number, lat: number, heading: number, hx: number, hy: number, hz: number, kind: Box['kind'] = 'cover', lift = 0, outer = false) => {
    if (outer) {
      const d = planetDir(lon, lat);
      const up: Vec3 = [-d[0], -d[1], -d[2]];
      const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
      const ch = Math.cos(heading), sh = Math.sin(heading);
      const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
      const X: Vec3 = [ch * east[0] + sh * north[0], ch * east[1] + sh * north[1], ch * east[2] + sh * north[2]];
      const Z: Vec3 = [X[1] * up[2] - X[2] * up[1], X[2] * up[0] - X[0] * up[2], X[0] * up[1] - X[1] * up[0]];
      const rc = R2 - lift - hy + 0.2; // (the shell curves up round it: just bury the bottom a little)
      boxes.push({ id: nextId(), type: 'box', kind, angle: lon, tilt: 0, center: [d[0] * rc, d[1] * rc, d[2] * rc], half: [hx, hy + 0.2, hz], axes: [X, up, Z] });
      return;
    }
    const up = planetDir(lon, lat);
    const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
    const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
    const ch = Math.cos(heading), sh = Math.sin(heading);
    const X: Vec3 = [ch * east[0] + sh * north[0], ch * east[1] + sh * north[1], ch * east[2] + sh * north[2]];
    const Z: Vec3 = [X[1] * up[2] - X[2] * up[1], X[2] * up[0] - X[0] * up[2], X[0] * up[1] - X[1] * up[0]];
    let sag = (hx * hx + hz * hz) / (2 * R) + 0.2; // bury the bottom: the ground curves away under it
    if (bumps.length) {
      // ...and on a hillside, by how much the ground falls away across it
      const { g } = planetBumpsAt(bumps, R, up);
      const gn = g[0] * up[0] + g[1] * up[1] + g[2] * up[2];
      sag += (Math.hypot(g[0] - gn * up[0], g[1] - gn * up[1], g[2] - gn * up[2]) / R) * Math.hypot(hx, hz);
    }
    const rc = R + groundH(up) + lift + hy - sag;
    boxes.push({ id: nextId(), type: 'box', kind, angle: lon, tilt: 0, center: [up[0] * rc, up[1] * rc, up[2] * rc], half: [hx, hy + sag, hz], axes: [X, up, Z] });
  };
  const near = (lon: number, lat: number, m: number, outer = false) =>
    spawns.some((sp) => {
      if (!!sp.outer !== outer) return false;
      const rr = outer ? R2 : R;
      const a = planetDir(sp.angle, sp.z / rr), b = planetDir(lon, lat);
      return Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * rr < m;
    }) || pads.some((pd) => {
      const b = planetDir(lon, lat), r = Math.hypot(...pd.pos);
      return (r > (R + R2) / 2) === outer && Math.acos(Math.min(1, (pd.pos[0] * b[0] + pd.pos[1] * b[1] + pd.pos[2] * b[2]) / r)) * r < m;
    });
  if (R2 > 0 && cfg.launchPads) {
    // Launch pads round both equators: up from the ball, down from the shell.
    // Straight up doesn't work: Coriolis turns the climb into an antispinward
    // slide, and arriving at the shell moving against the spin you're too light
    // to stay on it. So they throw you about 29 degrees spinward (from the ball)
    // or antispinward (from the shell). 22 m/s gets you across either way.
    const tilt = 0.5, speed = 22;
    for (let i = 0; i < 6; i++) {
      const lon = ((i + 0.5) / 6) * 2 * Math.PI, d = planetDir(lon, 0), east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
      pads.push({ pos: [d[0] * R, d[1] * R, d[2] * R], up: [d[0] * Math.cos(tilt) + east[0] * Math.sin(tilt), d[1] * Math.cos(tilt) + east[1] * Math.sin(tilt), 0], speed });
      const lo = lon + Math.PI / 6, e = planetDir(lo, 0), ee: Vec3 = [-Math.sin(lo), Math.cos(lo), 0];
      pads.push({ pos: [e[0] * R2, e[1] * R2, e[2] * R2], up: [-e[0] * Math.cos(tilt) - ee[0] * Math.sin(tilt), -e[1] * Math.cos(tilt) - ee[1] * Math.sin(tilt), 0], speed });
    }
  }
  // hills and mountains on the ball (clear of the launch pads; on a nested ball, short of the shell)
  const bumps = makeBumps(cfg, () => rngNext(rng), (u, v, radius) => {
    const c = planetDir(u * 2 * Math.PI, Math.asin(v * 1.9 - 0.95));
    if (pads.some((pd) => { const rr = Math.hypot(...pd.pos); return rr < R + 1 && R * Math.hypot(pd.pos[0] / rr - c[0], pd.pos[1] / rr - c[1], pd.pos[2] / rr - c[2]) < 3 * radius + 3; })) return null;
    return c;
  }, R2 > 0 ? 0.35 * (R2 - R) : Infinity);
  const groundH = (d: Vec3) => planetBumpsAt(bumps, R, d).h;
  if (withObstacles) {
    const area = 4 * Math.PI * R * R;
    const n = Math.max(20, Math.min(260, Math.round(area / 900)));
    const k = Math.min(1, R / 80);
    for (let i = 0; i < n; i++) {
      const lon = rngNext(rng) * 2 * Math.PI;
      const lat = Math.asin(rngRange(rng, -0.92, 0.92)); // uniform over the surface, not right at the poles
      if (near(lon, lat, 6)) continue;
      const kind = rngNext(rng), heading = rngNext(rng) * Math.PI;
      if (kind < 0.45) stand(lon, lat, heading, rngRange(rng, 1, 2.5), rngRange(rng, 0.5, 0.9) * k, rngRange(rng, 0.3, 0.6), 'struct'); // low wall
      else if (kind < 0.7) stand(lon, lat, Math.PI / 4, 1.1, rngRange(rng, 1.5, 3) * k, 1.1, 'struct'); // diamond pillar
      else if (kind < 0.9) stand(lon, lat, heading, rngRange(rng, 1, 2), rngRange(rng, 0.4, 0.8) * k, rngRange(rng, 1, 2)); // crate
      else stand(lon, lat, heading, 1.6, rngRange(rng, 4, 8) * k, 1.6, 'struct'); // tower
    }
    if (R2 > 0) {
      // cover on the inside of the shell, in the band you can stand on (within ~45 degrees of its equator)
      const n2 = Math.round((4 * Math.PI * R2 * R2 * 0.7) / 1400);
      for (let i = 0; i < n2; i++) {
        const lon = rngNext(rng) * 2 * Math.PI, lat = Math.asin(rngRange(rng, -0.68, 0.68));
        if (near(lon, lat, 6, true)) continue;
        const kind = rngNext(rng), heading = rngNext(rng) * Math.PI;
        if (kind < 0.5) stand(lon, lat, heading, rngRange(rng, 1, 2.5), rngRange(rng, 0.5, 0.9), rngRange(rng, 0.3, 0.6), 'struct', 0, true);
        else if (kind < 0.8) stand(lon, lat, Math.PI / 4, 1.1, rngRange(rng, 1.5, 3), 1.1, 'struct', 0, true);
        else stand(lon, lat, heading, rngRange(rng, 1, 2), rngRange(rng, 0.4, 0.8), rngRange(rng, 1, 2), 'cover', 0, true);
      }
    }
    // pickups on a spiral round the planet (evenly spread)
    const items: ItemKind[] = ['health', 'sticky', 'redRifle', 'bounce', 'launcher', 'scatter', 'jetpack', 'cannon', 'rocket', 'health', 'chaos', 'revolver', 'seeker', 'laconic'];
    const m = items.length;
    for (let i = 0; i < m; i++) {
      const lat = Math.asin(-0.85 + (1.7 * (i + 0.5)) / m), lon = i * 2.39996; // golden angle
      if (near(lon, lat, 4)) continue;
      const d = planetDir(lon, lat);
      const rp = R + groundH(d) + 1;
      pickupSpots.push({ pos: [d[0] * rp, d[1] * rp, d[2] * rp], item: items[i] });
      if (R2 > 0 && Math.abs(lat) < 0.7 && !near(lon + 1, lat, 4, true)) {
        const e = planetDir(lon + 1, lat);
        pickupSpots.push({ pos: [e[0] * (R2 - 1), e[1] * (R2 - 1), e[2] * (R2 - 1)], item: items[(i + 5) % m] });
      }
    }
  }
  return { shape: 'planet', terrain: null, boxes, stairTops: [], spawns, pickupSpots, vehicleSpots: [], wallPos: [], wallNeg: [], ...(pads.length ? { pads } : {}), ...(bumps.length ? { bumps } : {}) };
}

function ringSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  const out: SdfHit = { d: Infinity, n: [0, 0, 1] };
  const rho = rhoOf(p);
  const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
  const theta = Math.atan2(p[1], p[0]);
  // twin rings: a point over the other ring is looked at in that ring's frame (its boxes and hills are fixed in it)
  const da = cfg.twin ? (sdfFrame ? -sdfTheta : sdfTheta) - (sdfFrame ? sdfTheta : -sdfTheta) : 0; // theta_from - theta_to
  const ca = Math.cos(da), sa = Math.sin(da);
  if (cfg.twin && level.terrain) {
    // hills: each ring's floor in its own frame, with the gap cut out of it
    const g = cfg.twinGap / 2, curb = 0.6;
    const own = (p[2] >= 0 ? 1 : 0) === sdfFrame;
    const f: SdfHit = { d: Infinity, n: [0, 0, 1] };
    if (own) terrainFloor(level, cfg, p, rho, theta, f);
    else {
      const q: Vec3 = [ca * p[0] - sa * p[1], sa * p[0] + ca * p[1], p[2]];
      terrainFloor(level, cfg, q, rho, Math.atan2(q[1], q[0]), f);
      f.n = [ca * f.n[0] + sa * f.n[1], -sa * f.n[0] + ca * f.n[1], f.n[2]];
    }
    const dGap = g - Math.abs(p[2]);
    if (dGap > f.d) { f.d = dGap; f.n = [0, 0, -Math.sign(p[2]) || 1]; }
    if (f.d < out.d) { out.d = f.d; out.n = f.n; }
    annulus(p, rho, R - curb, R + hull, -g - T, -g, out);
    annulus(p, rho, R - curb, R + hull, g, g + T, out);
  } else if (cfg.twin) {
    // two floors with a gap at the seam, and a curb along each side of it
    const g = cfg.twinGap / 2, curb = 0.6;
    annulus(p, rho, R, R + hull, -(W + T), -g, out);
    annulus(p, rho, R, R + hull, g, W + T, out);
    annulus(p, rho, R - curb, R + hull, -g - T, -g, out);
    annulus(p, rho, R - curb, R + hull, g, g + T, out);
  } else if (level.terrain) terrainFloor(level, cfg, p, rho, theta, out);
  else if (level.holes?.length) {
    const f: SdfHit = { d: Infinity, n: [0, 0, 1] };
    annulus(p, rho, R, R + hull, -(W + T), W + T, f); // floor / hull...
    cutHoles(p, theta, level.holes, R, f); // ...with holes in it
    if (f.d < out.d) { out.d = f.d; out.n = f.n; }
  } else annulus(p, rho, R, R + hull, -(W + T), W + T, out); // floor / hull
  if (level.hub) {
    // the wheel station's hub: a drum round the axis (its inside is a floor), with an opening where each spoke comes in
    const H = level.hub, L = H.halfLen, T = H.thickness;
    const f: SdfHit = { d: Infinity, n: [0, 0, 1] };
    annulus(p, rho, H.r, H.r + T, -L - T, L + T, f);
    cutHoles(p, theta, H.spokes.map((s) => ({ angle: s.angle, z: 0, halfArc: s.w, halfZ: s.d })), H.r, f);
    annulus(p, rho, 0, H.r + T, L, L + T, f); // the ends
    annulus(p, rho, 0, H.r + T, -L - T, -L, f);
    if (f.d < out.d) { out.d = f.d; out.n = f.n; }
  }
  for (const dk of level.decks ?? []) {
    const f: SdfHit = { d: Infinity, n: [0, 0, 1] };
    annulus(p, rho, dk.r, dk.r + dk.thickness, -W, W, f);
    cutHoles(p, theta, dk.holes, R, f);
    if (f.d < out.d) { out.d = f.d; out.n = f.n; }
  }
  // rim walls stand on the floor at the edge (higher up on a sphere band or in a half-pipe)
  const edge = edgeHeight(level, cfg);
  rimWall(p, rho, theta, level.wallPos, R - edge, R + hull, W, W + T, out); // +Z rim wall
  rimWall(p, rho, theta, level.wallNeg, R - edge, R + hull, -(W + T), -W, out); // -Z rim wall
  if (cfg.twin) {
    // a box of the other ring: rotate the query into its frame, and the normal back
    const c = ca, s = sa;
    const q: Vec3 = [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
    for (const b of level.boxes) {
      if ((b.ring ?? 0) === sdfFrame) { boxSdf(p, b, out); continue; }
      const before = out.d;
      boxSdf(q, b, out);
      if (out.d < before) { const n = out.n; out.n = [c * n[0] + s * n[1], -s * n[0] + c * n[1], n[2]]; }
    }
    return out;
  }
  for (const b of level.boxes) boxSdf(p, b, out);
  return out;
}

export interface TraceHit {
  s: number; // fraction along the segment [0,1]
  pos: Vec3;
  n: Vec3;
}

/**
 * Swept sphere vs the level along a straight segment, by sphere tracing the
 * SDF (conservative advancement: the SDF is a true distance bound, so stepping
 * by it can never tunnel). Surfaces we are already touching but moving away
 * from are ignored, so a body can launch off the floor.
 */
export function sphereTrace(level: Level, cfg: SimConfig, p0: Vec3, p1: Vec3, radius: number): TraceHit | null {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const eps = 1e-4;
  if (L < 1e-12) {
    const h = levelSdf(level, cfg, p0);
    return h.d - radius < 0 ? { s: 0, pos: [p0[0], p0[1], p0[2]], n: h.n } : null;
  }
  const ux = dx / L, uy = dy / L, uz = dz / L;
  let s = 0;
  for (let i = 0; i < 96; i++) {
    const p: Vec3 = [p0[0] + ux * s, p0[1] + uy * s, p0[2] + uz * s];
    const h = levelSdf(level, cfg, p);
    const gap = h.d - radius;
    if (gap < eps) {
      const approaching = h.n[0] * ux + h.n[1] * uy + h.n[2] * uz < 0;
      if (approaching) return { s: s / L, pos: p, n: h.n };
      s += Math.max(radius * 0.25, eps * 10);
    } else {
      s += gap;
    }
    if (s >= L) return null;
  }
  const h = levelSdf(level, cfg, p1);
  return h.d - radius < 0 ? { s: 1, pos: [p1[0], p1[1], p1[2]], n: h.n } : null;
}

// ------------------------------------------------------------- generation

/**
 * Where along the playable floor a fraction u (0..1) lies, as a ring angle.
 * Whole ring: u * 2pi. With an `arena` (a fixed-length stretch, e.g. Earth),
 * u spans the arena, centred on angle 0.
 */
export function arcAngle(cfg: SimConfig, u: number): number {
  return cfg.arena > 0 ? ((u - 0.5) * cfg.arena) / cfg.R : u * Math.PI * 2;
}

/** Length of the playable floor along the ring (m). */
export const playSpan = (cfg: SimConfig) => (cfg.arena > 0 ? cfg.arena : 2 * Math.PI * cfg.R);

export function makeSpawns(cfg: SimConfig): SpawnPoint[] {
  const spawns: SpawnPoint[] = [];
  const n = 8;
  const off = cfg.arena > 0 ? 0.5 : 0;
  const sz = cfg.tube !== 'none' ? Math.min(8, 0.3 * cfg.tubeRadius) : 8; // (a log is narrow)
  // On wide floors spread the spawns across the width too (spawnPosition puts
  // them on the floor however it curves); on a sphere stay at low latitudes.
  const Wz = cfg.terrainSphere ? Math.min(cfg.halfWidth, 0.45 * cfg.R) : cfg.halfWidth;
  const across = [-0.6, 0.25, 0.6, -0.25, 0.4, -0.45, 0.1, -0.1];
  for (let i = 0; i < n; i++) {
    const z = cfg.tube === 'none' && Wz >= 35 ? across[i % across.length] * (Wz - 6) : i % 2 === 0 ? -sz : sz;
    spawns.push({ angle: arcAngle(cfg, (i + off) / n), z });
  }
  return spawns;
}

/**
 * Rim wall heights per sector: mostly full height, with stretches of low
 * curb and medium wall you can jump or get blasted over (and fall off the ring).
 */
export function makeWalls(cfg: SimConfig, rng: { rng: number }, varied: boolean): { wallPos: number[]; wallNeg: number[] } {
  const n = Math.max(8, Math.min(64, Math.round((2 * Math.PI * cfg.R) / 30)));
  const side = () => {
    const hs: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!varied) { hs.push(fullWallHeight(cfg)); continue; }
      const r = rngNext(rng);
      const full = fullWallHeight(cfg);
      hs.push(r < 0.5 ? full : r < 0.75 ? Math.min(full, 4, 0.15 * cfg.R) : Math.min(full, 1));
    }
    return hs;
  };
  return { wallPos: side(), wallNeg: side() };
}

/** Rim walls are at most 40% of the radius, so tiny rings still have a sky. */
export const fullWallHeight = (cfg: SimConfig) => Math.min(cfg.wallHeight, 0.4 * cfg.R);

export function generateLevel(cfg: SimConfig, rng: { rng: number }, withObstacles: boolean, nextId: () => number, variedWalls = true, vehicleCount = -1): Level {
  const spawns = makeSpawns(cfg);
  const walls = makeWalls(cfg, rng, variedWalls);
  const boxes: Box[] = [];
  const R = cfg.R;
  // where the lookout ramps will go (same formula as below), so hills keep clear of them
  const span0 = playSpan(cfg);
  const nRamps0 = withObstacles && !(cfg.bases > 0) && !(cfg.mountains > 0) ? Math.max(2, Math.min(12, Math.round(span0 / 150))) : 0;
  const H0 = Math.max(2, Math.min(LOOKOUT_HEIGHT, 0.3 * R));
  const rampClear = Array.from({ length: nRamps0 }, (_, s) => ({
    angle: arcAngle(cfg, (s + 0.5) / nRamps0 + (cfg.arena > 0 ? 0 : 1 / 16)),
    halfArc: (H0 / RAMP_SLOPE + STAIR_TOP) / 2 + 2,
  }));
  const ridge = cfg.ridgeHeight > 0 ? { height: cfg.ridgeHeight, plateau: cfg.ridgePlateau } : undefined;
  // O'Neill windows: n glass strips, each as wide as the land between them, kept clear of hills
  const windows = cfg.windows > 0
    ? Array.from({ length: cfg.windows }, (_, i) => ({ angle: ((i + 0.5) / cfg.windows) * 2 * Math.PI, halfArc: (Math.PI * R) / (2 * cfg.windows) }))
    : [];
  // Bases need flat ground: pick their sites first (clear of the windows), so hills and mountains avoid them.
  const baseSites: { angle: number; z: number }[] = [];
  for (let i = 0; i < (withObstacles ? cfg.bases : 0); i++) {
    const zMax = Math.max(0, Math.min(cfg.halfWidth - BASE_HALF - 6, 300));
    const z = (((i * 0.618034) % 1) * 2 - 1) * zMax;
    // try a few spots in this base's share of the ring: off the windows, lookouts and spawn points
    for (const f of [0.62, 0.37, 0.12, 0.87, 0.5]) {
      const angle = arcAngle(cfg, (i + f) / cfg.bases);
      const near = (a: number, m: number) => Math.abs(wrapAngle(angle - a)) * R < m;
      if (windows.some((w) => near(w.angle, w.halfArc + BASE_REACH))) continue;
      if (rampClear.some((r) => near(r.angle, r.halfArc + BASE_REACH + 4))) continue;
      if (spawns.some((sp) => near(sp.angle, BASE_REACH + 4) && Math.abs(sp.z - z) < BASE_HALF + 6)) continue;
      baseSites.push({ angle, z });
      break;
    }
  }
  const flat: ClearZone[] = [...rampClear, ...windows, ...baseSites.map((b) => ({ angle: b.angle, halfArc: BASE_REACH, z: b.z, halfZ: BASE_HALF + 3 }))];
  // twin rings: keep hills off the seam; in a tube or a whole sphere, keep them to the floor (the height field's good there)
  if (cfg.twin) flat.push({ angle: 0, halfArc: Math.PI * R, z: 0, halfZ: cfg.twinGap / 2 + 2 });
  const hillW = cfg.tube !== 'none' ? Math.min(cfg.halfWidth, 0.55 * cfg.tubeRadius) : cfg.terrainSphere && cfg.halfWidth > 0.6 * R ? 0.6 * R : cfg.halfWidth;
  const hcfg = hillW < cfg.halfWidth ? { ...cfg, halfWidth: hillW } : cfg;
  const hills = makeHills(hcfg, cfg.hills, cfg.hillHeight, () => rngNext(rng), (u) => arcAngle(cfg, u), flat, windows.length ? 3 : 2.5);
  if (cfg.mountains > 0) {
    // with windows, put the mountains in the land strips (and keep them narrow enough to fade out before the glass)
    const n = windows.length;
    // (with biomes, the mountains all go on the snow strip: strip 2)
    const strip = (rand: () => number) => (cfg.biomes && n >= 3 ? 2 : Math.floor(rand() * n));
    const pick = n ? (rand: () => number) => (strip(rand) / n) * 2 * Math.PI + (rand() * 2 - 1) * (0.3 * Math.PI) / n : undefined;
    const maxR = n ? (0.7 * windows[0].halfArc) / 3 : undefined;
    hills.push(...makeMountains(hcfg, cfg.mountains, cfg.mountainHeight, () => rngNext(rng), (u) => arcAngle(cfg, u), flat, pick, maxR));
  }
  const terrain: Level['terrain'] = cfg.terrainSphere || hills.length > 0 || ridge || cfg.tube !== 'none'
    ? { sphere: cfg.terrainSphere, hills, ...(ridge ? { ridge } : {}) }
    : null;
  if (cfg.tube !== 'none' && terrain) terrain.tube = { kind: cfg.tube, radius: cfg.tubeRadius };
  // Ramps and mesas need flat ground; on a sphere keep clutter to the lower latitudes.
  const tube = cfg.tube !== 'none';
  const deck = cfg.deckHeight > 0;
  const steep = !!ridge || tube;
  const Wp = cfg.terrainSphere ? Math.min(cfg.halfWidth, 0.45 * R) : tube ? Math.min(cfg.halfWidth, (cfg.tube === 'outside' ? 0.35 : 0.5) * cfg.tubeRadius) : cfg.halfWidth;
  const probe: Level = { shape: 'ring', terrain, boxes, stairTops: [], spawns, pickupSpots: [], vehicleSpots: [], wallPos: [], wallNeg: [] };
  /** Floor radius here (R on a flat floor). */
  const Rf = (angle: number, z: number) => floorRadius(probe, cfg, angle, z);
  /** How much a footprint of this size must be buried to sit on sloping ground. */
  const bury = (angle: number, z: number, ht: number, hz: number) => {
    if (!terrain) return 0;
    const t = terrainAt(probe, cfg, angle, z);
    return Math.abs(t.dhds) * ht + Math.abs(t.dhdz) * hz + 0.3;
  };
  const addBox = (angle: number, z: number, ht: number, hu: number, hz: number, kind: Box['kind'] = 'cover', base?: number, yaw = 0) => {
    const sag = (ht * ht) / (2 * R) + 0.05 + (base ? 0 : bury(angle, z, ht, hz)); // bury the bottom so the curved floor never shows a gap
    const huTot = hu + sag / 2;
    const rc = (base ?? Rf(angle, z)) - 2 * hu + huTot; // top stays at height 2*hu (on the floor, or on a deck at radius `base`)
    boxes.push({ id: nextId(), type: 'box', kind, angle, tilt: 0, center: [rc * Math.cos(angle), rc * Math.sin(angle), z], half: [ht, huTot, hz], ...(yaw ? { yaw } : {}) });
  };
  /**
   * A ramp: one straight tilted slab, centred at `midAngle`, climbing `H` over
   * `len` metres of ring in direction `dir` (+1 spinward). The floor curves up
   * away from the slab's middle, so the slab's ends are raised to match: its
   * low end meets the floor and its high end is exactly H above it. The slab
   * reaches well below the floor so you can't get under it.
   */
  /** Returns the ring angle where the ramp's top edge ends (the platform starts there). */
  const addRamp = (midAngle: number, z: number, len: number, H: number, dir: number, width = STAIR_WIDTH): number => {
    const R = Rf(midAngle, z); // the local floor radius (differs from cfg.R on terrain)
    // exact: a point d along the tangent at height y above it sits at radius
    // sqrt((R - y)^2 + d^2), so "h above the floor" means y = R - sqrt((R - h)^2 - d^2)
    const d = len / 2;
    const y0 = R - Math.sqrt(R * R - d * d), y1 = R - Math.sqrt((R - H) ** 2 - d * d);
    const tilt = dir * Math.atan2(y1 - y0, len);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const ymid = (y0 + y1) / 2;
    const hy = (ymid + H / 2 + 1.5) / (2 * ct); // half-thickness: deep enough to bury the bottom
    const hx = len / 2 / ct;
    const c = Math.cos(midAngle), sn = Math.sin(midAngle);
    const top: Vec3 = [(R - ymid) * c, (R - ymid) * sn, z]; // middle of the top surface
    const spin: Vec3 = [-sn, c, 0], up: Vec3 = [-c, -sn, 0];
    const n: Vec3 = [-st * spin[0] + ct * up[0], -st * spin[1] + ct * up[1], 0]; // the slab's own "up"
    boxes.push({ id: nextId(), type: 'box', kind: 'ramp', angle: midAngle, tilt, center: [top[0] - n[0] * hy, top[1] - n[1] * hy, z], half: [hx, hy, width / 2] });
    // the high end is nearer the axis, so it reaches a little further round the ring than len/2R
    return midAngle + dir * Math.atan2(d, R - y1);
  };
  const stairs: { angle: number; halfArc: number }[] = [];
  const pickupSpots: { pos: Vec3; item: ItemKind }[] = [];
  const stairTops: Vec3[] = [];
  const vehicleSpots: { pos: Vec3; yaw: number }[] = [];
  const at = (angle: number, height: number, z: number): Vec3 => {
    const r = Rf(angle, z) - height;
    return [r * Math.cos(angle), r * Math.sin(angle), z];
  };
  // Features scale down on small rings so nothing towers over the axis.
  const k = Math.min(1, R / 60);
  const arena = cfg.arena > 0;
  if (arena) {
    // end walls closing off the arena (spinning: bulkheads right up to near the axis, sealing off the rest of the ring)
    const wh = cfg.spin ? 0.95 * R : fullWallHeight(cfg);
    for (const sgn of [-1, 1]) addBox((sgn * (cfg.arena / 2 + 0.75)) / R, 0, 0.75, wh / 2, cfg.halfWidth + cfg.wallThickness, 'wall');
  }
  if (withObstacles) {
    const circ = playSpan(cfg);
    // Ramps up to lookout platforms, midway between spawn points, alternating
    // which way they climb (climbing spinward vs antispinward feels different!).
    // (no lookouts where bases or mountains bring their own heights)
    const nStairs = steep || deck || cfg.twin || cfg.bases > 0 || cfg.mountains > 0 ? 0 : Math.max(2, Math.min(12, Math.round(circ / 150)));
    const H = Math.max(2, Math.min(LOOKOUT_HEIGHT, 0.3 * R)); // lookout height
    const rampLen = H / RAMP_SLOPE;
    const topItems: ItemKind[] = ['cannon', 'jetpack', 'hammer'];
    for (let s = 0; s < nStairs; s++) {
      const mid = arcAngle(cfg, (s + 0.5) / nStairs + (arena ? 0 : 1 / (2 * spawns.length)));
      const dir = s % 2 === 0 ? 1 : -1;
      const z = s % 2 === 0 ? -7 : 7;
      const total = rampLen + STAIR_TOP;
      const start = mid - (dir * total) / 2 / R;
      const rampEnd = addRamp(start + (dir * rampLen) / 2 / R, z, rampLen, H, dir);
      const topAngle = rampEnd + (dir * STAIR_TOP) / 2 / (R - H);
      addBox(topAngle, z, STAIR_TOP / 2, H / 2, STAIR_WIDTH / 2, 'ramp');
      stairs.push({ angle: mid, halfArc: total / 2 });
      // a standing spot on the lookout, a little back from the pickup
      stairTops.push(at(topAngle + (dir * (STAIR_TOP / 2 - 1.2)) / R, H, z));
      // the lookout's prize: a plasma bolt cannon, a jetpack or the Grav Mallet
      pickupSpots.push({ pos: at(topAngle, H + 1, z), item: topItems[s % topItems.length] });
    }
    // Floor pickups at the midpoints between spawns that have no staircase.
    const floorItems: ItemKind[] = ['launcher', 'health', 'redRifle', 'sticky', 'rocket', 'laconic', 'bounce', 'seeker', 'health', 'sticky', 'revolver', 'scatter'];
    let fi = 0;
    for (let i = 0; i < spawns.length - (arena ? 1 : 0); i++) {
      const a = arcAngle(cfg, (i + (arena ? 1 : 0.5)) / spawns.length);
      const taken = stairs.some((s) => Math.abs(Math.atan2(Math.sin(a - s.angle), Math.cos(a - s.angle))) * R < s.halfArc + 2);
      if (taken) continue;
      pickupSpots.push({ pos: at(a, 1, 0), item: floorItems[fi++ % floorItems.length] });
    }
    // Hover-bikes on big rings: plenty of them, spread round and across the
    // floor, plus one parked beside every spawn point.
    const bikesHere = vehicleCount >= 0 || cfg.R >= cfg.vehicleMinRadius;
    const nBikes = vehicleCount >= 0 ? vehicleCount : bikesHere ? Math.min(60, Math.floor(circ / cfg.vehicleSpacing)) : 0;
    const zSpread = Math.max(5, Math.min(cfg.halfWidth - 6, 400));
    const parkHeight = Math.max(BIKE_RADIUS, cfg.bikeHoverHeight - cfg.g / cfg.bikeHoverStiffness); // where the hover spring holds it
    for (let i = 0; i < nBikes; i++) {
      const a = arcAngle(cfg, (i + 0.3) / nBikes);
      const z = nBikes > 10 ? (((i * 0.618034) % 1) * 2 - 1) * zSpread : i % 2 ? 5 : -5;
      vehicleSpots.push({ pos: at(a, parkHeight, z), yaw: i % 2 ? Math.PI : 0 });
    }
    if (bikesHere && vehicleCount < 0) {
      for (const sp of spawns) {
        const a = sp.angle + 5 / R, z = sp.z + (sp.z > 0 ? -3 : 3);
        vehicleSpots.push({ pos: at(a, parkHeight, z), yaw: 0 });
      }
    }
    // Twin rings: jump ramps by the seam. To land gently on the other ring you
    // ride against your own ring's spin (ring 0: antispinward; ring 1, which
    // turns the other way: spinward), so each ramp climbs that way, angled
    // ~20 degrees toward the seam, and ends just short of the curb.
    if (cfg.twin) {
      const nJ = Math.max(4, Math.min(16, Math.round(circ / 70)));
      const len = 9, H = 1.5, width = 3.2, toward = 0.35;
      for (let i = 0; i < nJ; i++) {
        const ring = i % 2;
        const sz = ring ? 1 : -1; // which side of the seam
        const a = arcAngle(cfg, (i + 0.5) / nJ);
        if (spawns.some((sp) => Math.abs(wrapAngle(sp.angle - a)) * R < 10)) continue;
        // travel direction: ring 0 antispinward (and +z toward the seam); ring 1 spinward (and -z)
        const yaw = ring ? -toward : Math.PI - toward;
        const z = sz * (cfg.twinGap / 2 + 0.6 + 1.2 + (len / 2) * Math.sin(toward));
        const tilt = Math.atan2(H, len);
        const ct = Math.cos(tilt);
        const hy = (H / 2 + 1.2) / ct; // deep enough to bury its bottom
        const c = Math.cos(a), sn = Math.sin(a);
        const up: Vec3 = [-c, -sn, 0], spin: Vec3 = [-sn, c, 0];
        const X: Vec3 = [spin[0] * Math.cos(yaw), spin[1] * Math.cos(yaw), Math.sin(yaw)]; // its length, level
        const N: Vec3 = [-Math.sin(tilt) * X[0] + ct * up[0], -Math.sin(tilt) * X[1] + ct * up[1], -Math.sin(tilt) * X[2] + ct * up[2]]; // its own up
        const fr = Rf(a, z);
        const topMid: Vec3 = [(fr - H / 2) * c, (fr - H / 2) * sn, z];
        stairs.push({ angle: a, halfArc: len / 2 + 3 }); // (keep cover off it)
        boxes.push({ id: nextId(), type: 'box', kind: 'ramp', angle: a, tilt, yaw, center: [topMid[0] - N[0] * hy, topMid[1] - N[1] * hy, topMid[2] - N[2] * hy], half: [len / 2 / ct, hy, width / 2], ring: ring as 0 | 1 });
      }
    }
    // Bases: a room with doorways and chamfered (45 degree) corners, a roof you
    // reach by ramps, and low walls up there for partial cover.
    const baseItems: ItemKind[] = ['health', 'scatter', 'rocket', 'revolver', 'chaos', 'cannon', 'seeker', 'redRifle', 'launcher'];
    baseSites.forEach((site, bi) => {
      const a0 = site.angle, zc = site.z;
      if (spawns.some((sp) => Math.abs(wrapAngle(sp.angle - a0)) * R < BASE_REACH + 4 && Math.abs(sp.z - zc) < BASE_HALF + 6)) return;
      if (stairs.some((st) => Math.abs(wrapAngle(st.angle - a0)) * R < st.halfArc + BASE_REACH)) return;
      const hx = BASE_HALF, hz = BASE_HALF, H = 4.2, t = 0.3, c = 3, door = 1.7, roof = 0.3;
      const ground = Rf(a0, zc);
      const at2 = (x: number) => a0 + x / R;
      const part = (x: number, z: number, ht: number, hu: number, hzz: number, lift = 0, yaw = 0) =>
        addBox(at2(x), zc + z, ht, hu, hzz, 'struct', ground - lift, yaw);
      // walls along the ring (z = +-hz), each with a doorway in the middle
      for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
        const x0 = door, x1 = hx - c;
        part(sx * (x0 + x1) / 2, sz * hz, (x1 - x0) / 2, H / 2, t);
      }
      // end walls (x = +-hx), solid: the ramps run up their outsides
      for (const sx of [-1, 1]) part(sx * hx, 0, t, H / 2, hz - c);
      // chamfered corners
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        part(sx * (hx - c / 2), sz * (hz - c / 2), (c * Math.SQRT2) / 2, H / 2, t, 0, Math.atan2(-sz, sx));
      }
      // a diamond pillar in the middle holding up the roof
      part(0, 0, 1, H / 2, 1, 0, Math.PI / 4);
      // the roof, and its low walls: corner chamfers and short runs, a diamond in the middle
      part(0, 0, hx + 0.3, roof, hz + 0.3, H); // overhangs the walls, so the ramps meet its edge
      const top = H + 2 * roof;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        part(sx * (hx - c / 2 - 0.3), sz * (hz - c / 2 - 0.3), (c * Math.SQRT2) / 2, 0.6, 0.25, top, Math.atan2(-sz, sx));
        part(sx * (hx - c - 1.5), sz * (hz - 0.5), 1.5, 0.6, 0.25, top);
      }
      part(0, 0, 1.3, 0.7, 1.3, top, Math.PI / 4);
      // ramps up the outside of each end wall, on opposite sides of the base
      const rampLen = top / RAMP_SLOPE;
      for (const sx of [-1, 1]) {
        const zr = zc - sx * (hz / 2 - 1);
        addRamp(at2(sx * (hx + 0.3 + rampLen / 2)), zr, rampLen, top, -sx, 3.5);
      }
      // something worth fighting for inside, and a prize on the roof
      const ai = a0 + (hx / 2) / R;
      pickupSpots.push({ pos: [(ground - 1) * Math.cos(ai), (ground - 1) * Math.sin(ai), zc + hz / 2], item: baseItems[bi % baseItems.length] });
      pickupSpots.push({ pos: [(ground - top - 1) * Math.cos(a0 - 4 / R), (ground - top - 1) * Math.sin(a0 - 4 / R), zc], item: baseItems[(bi + 3) % baseItems.length] });
      stairs.push({ angle: a0, halfArc: BASE_REACH });
    });
    // Mesas: low raised platforms with a ramp, for some verticality on bigger rings.
    const angDist = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * R;
    const nMesas = steep ? 0 : Math.min(40, Math.floor((circ / 80) * Math.max(1, Wp / 20)));
    const mh = Math.min(MESA_HEIGHT, 0.15 * R);
    for (let i = 0; i < nMesas; i++) {
      const plat = rngRange(rng, 6, 9);
      const width = rngRange(rng, 5, 8);
      const dir = rngNext(rng) < 0.5 ? 1 : -1;
      const z = rngRange(rng, -Wp + width / 2 + 2, Wp - width / 2 - 2);
      const rampLen = mh / RAMP_SLOPE;
      const total = rampLen + plat;
      const mid = arcAngle(cfg, (i + rngRange(rng, 0.25, 0.75)) / nMesas);
      const clear = (a: number, half: number) =>
        !spawns.some((sp) => angDist(a, sp.angle) < half + 6) &&
        !stairs.some((st) => angDist(a, st.angle) < half + st.halfArc + 3) &&
        !pickupSpots.some((sp) => angDist(a, Math.atan2(sp.pos[1], sp.pos[0])) < half + 3) &&
        !vehicleSpots.some((sp) => angDist(a, Math.atan2(sp.pos[1], sp.pos[0])) < half + 4);
      if (!clear(mid, total / 2)) continue;
      const start = mid - (dir * total) / 2 / R;
      const rampEnd = addRamp(start + (dir * rampLen) / 2 / R, z, rampLen, mh, dir, width);
      const topAngle = rampEnd + (dir * plat) / 2 / (R - mh);
      addBox(topAngle, z, plat / 2, mh / 2, width / 2, 'ramp');
      stairs.push({ angle: mid, halfArc: total / 2 });
    }
    const count = Math.max(4, Math.min(300, Math.round((circ / 16) * Math.max(1, Wp / 20))));
    for (let i = 0; i < count; i++) {
      const angle = arcAngle(cfg, (i + rngRange(rng, 0.2, 0.8)) / count);
      // keep spawns clear
      const near = spawns.some((s) => Math.abs(Math.atan2(Math.sin(angle - s.angle), Math.cos(angle - s.angle))) * R < 5);
      if (near) continue;
      const onStairs = stairs.some((s) => Math.abs(Math.atan2(Math.sin(angle - s.angle), Math.cos(angle - s.angle))) * R < s.halfArc + 4);
      if (onStairs) continue;
      const nearPickup = pickupSpots.some((sp) => Math.abs(Math.atan2(Math.sin(angle - Math.atan2(sp.pos[1], sp.pos[0])), Math.cos(angle - Math.atan2(sp.pos[1], sp.pos[0])))) * R < 4);
      if (nearPickup) continue;
      if (vehicleSpots.some((sp) => Math.abs(Math.atan2(Math.sin(angle - Math.atan2(sp.pos[1], sp.pos[0])), Math.cos(angle - Math.atan2(sp.pos[1], sp.pos[0])))) * R < 5)) continue;
      const kind = rngNext(rng);
      const z = rngRange(rng, -Wp + 4, Wp - 4);
      if (kind < 0.5) addBox(angle, z, rngRange(rng, 0.8, 2.2), rngRange(rng, 0.5, 0.9) * k, rngRange(rng, 1.5, 3.5)); // low cover
      else if (kind < 0.8) addBox(angle, z, rngRange(rng, 1, 1.6), rngRange(rng, 1.8, 3) * k, rngRange(rng, 1, 1.6)); // pillar
      else addBox(angle, z, rngRange(rng, 3, 5) * Math.max(k, 0.5), rngRange(rng, 0.4, 0.6) * k, rngRange(rng, 3, 5)); // low platform
    }
  }
  // An upper deck: ramps from the floor up through slots in it, and things to fight over on top.
  const decks: Deck[] = [];
  if (deck) {
    const D = cfg.deckHeight, rd = R - D;
    const dk: Deck = { r: rd, thickness: 0.6, holes: [] };
    const nRamps = Math.max(2, Math.min(8, Math.round(playSpan(cfg) / 160)));
    const rampLen = D / RAMP_SLOPE, width = 6;
    for (let i = 0; i < nRamps; i++) {
      const mid = arcAngle(cfg, (i + 0.25) / nRamps);
      const dir = i % 2 ? -1 : 1;
      const z = (i % 2 ? 1 : -1) * Math.min(cfg.halfWidth * 0.5, cfg.halfWidth - width);
      // clear anything already sitting on the ramp's footprint
      const start = mid - (dir * rampLen) / 2 / R;
      const end = addRamp(mid, z, rampLen, D, dir, width);
      const lo = Math.min(start, end), hi = Math.max(start, end);
      for (let j = boxes.length - 2; j >= 0; j--) {
        const b = boxes[j];
        if (b.kind === 'wall') continue;
        const da = Math.atan2(Math.sin(b.angle - (lo + hi) / 2), Math.cos(b.angle - (lo + hi) / 2)) * R;
        if (Math.abs(da) < (hi - lo) * R / 2 + b.half[0] + 2 && Math.abs(b.center[2] - z) < width / 2 + b.half[2] + 2) boxes.splice(j, 1);
      }
      dk.holes.push({ angle: (lo + hi) / 2, z, halfArc: ((hi - lo) * R) / 2, halfZ: width / 2 + 0.6 });
      stairs.push({ angle: mid, halfArc: rampLen / 2 + 2 });
    }
    // lifts: platforms flush with the floor that rise through a shaft to sit flush with the deck
    const nLifts = Math.max(2, Math.round(playSpan(cfg) / 300));
    for (let i = 0; i < nLifts; i++) {
      const a = arcAngle(cfg, (i + 0.75) / nLifts);
      const z = (i % 2 ? -1 : 1) * Math.min(cfg.halfWidth * 0.5, cfg.halfWidth - 4);
      if (dk.holes.some((h) => Math.abs(wrapAngle(a - h.angle)) * R < h.halfArc + 6)) continue;
      const hw = 1.8, th = 0.2;
      const rc = R - th; // resting on the floor at the bottom (sunk flush into it, it flickered and seemed to vanish)
      const base: Vec3 = [rc * Math.cos(a), rc * Math.sin(a), z];
      for (let j = boxes.length - 1; j >= 0; j--) {
        const b = boxes[j];
        if (b.kind !== 'wall' && Math.abs(wrapAngle(b.angle - a)) * R < hw + b.half[0] + 2 && Math.abs(b.center[2] - z) < hw + b.half[2] + 2) boxes.splice(j, 1);
      }
      boxes.push({ id: nextId(), type: 'box', kind: 'lift', angle: a, tilt: 0, center: [...base] as Vec3, half: [hw, th, hw], lift: { base, travel: D - 2 * th, period: 12, phase: i * 0.37 } }); // (rising to sit flush with the deck)
      dk.holes.push({ angle: a, z, halfArc: hw + 0.35, halfZ: hw + 0.35 });
      stairs.push({ angle: a, halfArc: hw + 3 });
    }
    // a few skylights, cover and prizes up top
    const items: ItemKind[] = ['cannon', 'health', 'scatter', 'jetpack', 'rocket', 'chaos'];
    const nTop = Math.max(4, Math.round(playSpan(cfg) / 60));
    for (let i = 0; i < nTop; i++) {
      const a = arcAngle(cfg, (i + 0.7) / nTop);
      if (dk.holes.some((h) => Math.abs(wrapAngle(a - h.angle)) * R < h.halfArc + 6)) continue;
      const z = (i % 3 - 1) * cfg.halfWidth * 0.45;
      if (i % 3 === 0) dk.holes.push({ angle: a, z: -z, halfArc: 3, halfZ: 3 }); // a skylight / drop
      addBox(a, z, rngRange(rng, 1, 2.5), rngRange(rng, 0.5, 1.2) * k, rngRange(rng, 1.5, 3), 'cover', rd);
      const ap = a + 5 / R;
      pickupSpots.push({ pos: [(rd - 1) * Math.cos(ap), (rd - 1) * Math.sin(ap), z], item: items[i % items.length] });
    }
    decks.push(dk);
  }
  // Holes in the floor: clear of spawns, ramps, pickups and bikes; anything sitting over one goes.
  const holes: Hole[] = [];
  for (let i = 0; i < cfg.floorHoles; i++) {
    const halfArc = rngRange(rng, 2.5, 6), halfZ = rngRange(rng, 2.5, 6);
    const angle = arcAngle(cfg, (i + rngRange(rng, 0.2, 0.8)) / cfg.floorHoles);
    const z = rngRange(rng, -cfg.halfWidth + halfZ + 1.5, cfg.halfWidth - halfZ - 1.5);
    const near = (a: number, zz: number, m: number) => Math.abs(wrapAngle(a - angle)) * R < halfArc + m && Math.abs(zz - z) < halfZ + m;
    if (spawns.some((sp) => near(sp.angle, sp.z, 5))) continue;
    if (pickupSpots.some((sp) => near(Math.atan2(sp.pos[1], sp.pos[0]), sp.pos[2], 3))) continue;
    if (vehicleSpots.some((sp) => near(Math.atan2(sp.pos[1], sp.pos[0]), sp.pos[2], 4))) continue;
    if (stairs.some((st) => Math.abs(wrapAngle(st.angle - angle)) * R < st.halfArc + halfArc + 2)) continue;
    holes.push({ angle, z, halfArc, halfZ });
  }
  const filtered = holes.length
    ? boxes.filter((b) => b.kind === 'wall' || !holes.some((h) =>
      Math.abs(wrapAngle(b.angle - h.angle)) * R < h.halfArc + b.half[0] && Math.abs(b.center[2] - h.z) < h.halfZ + b.half[2]))
    : boxes;
  // twin rings: every box belongs to the ring it stands on; nothing straddles the seam
  if (cfg.twin) {
    for (let j = filtered.length - 1; j >= 0; j--) {
      const b = filtered[j];
      if (b.ring !== undefined) continue; // (a jump ramp by the seam: placed on purpose)
      if (Math.abs(b.center[2]) < b.half[2] + cfg.twinGap / 2 + 2.5) filtered.splice(j, 1);
      else b.ring = b.center[2] >= 0 ? 1 : 0;
    }
    for (const sp of pickupSpots) if (Math.abs(sp.pos[2]) < cfg.twinGap / 2 + 2) sp.pos[2] = (sp.pos[0] > 0 ? 1 : -1) * cfg.halfWidth * 0.5;
  }
  // inside or on the outside of a torus, the rim walls would only get in the way
  const noWalls = cfg.tube === 'inside' || cfg.tube === 'outside';
  return {
    shape: 'ring', terrain, boxes: filtered, stairTops, spawns, pickupSpots, vehicleSpots,
    ...(noWalls ? { wallPos: [], wallNeg: [] } : walls),
    ...(holes.length ? { holes } : {}), ...(decks.length ? { decks } : {}), ...(windows.length ? { windows } : {}),
  };
}

export const BIKE_RADIUS = 0.8; // hover-bike collision sphere
export const BASE_HALF = 9; // a base's room is 18 m square
export const BASE_REACH = 24; // ...and with its ramps it reaches this far along the ring from its centre
export const LOOKOUT_HEIGHT = 11; // m (capped at 30% of the radius on small rings)
export const MESA_HEIGHT = 3.5; // m: low raised platforms (capped at 15% of the radius)
export const RAMP_SLOPE = 0.45; // rise per metre (about 24 degrees): walkable
export const STAIR_WIDTH = 5; // m across the ring
export const STAIR_TOP = 6; // lookout platform length

export function spawnPosition(cfg: SimConfig, s: SpawnPoint, heightAboveFloor: number, level?: Level): Vec3 {
  if (cfg.world === 'disk') {
    const { pos, n } = diskPoint(cfg, s.angle, Math.min(Math.abs(s.z), cfg.R * 0.95), level?.bumps);
    return [pos[0] + n[0] * heightAboveFloor, pos[1] + n[1] * heightAboveFloor, pos[2] + n[2] * heightAboveFloor];
  }
  if (cfg.world === 'planet') {
    if (s.outer && cfg.outerShell > 0) {
      const d = planetDir(s.angle, s.z / cfg.outerShell), r = cfg.outerShell - heightAboveFloor;
      return [d[0] * r, d[1] * r, d[2] * r];
    }
    const d = planetDir(s.angle, s.z / cfg.R);
    const r = cfg.R + planetBumpsAt(level?.bumps, cfg.R, d).h + heightAboveFloor;
    return [d[0] * r, d[1] * r, d[2] * r];
  }
  const r = (s.floor ?? (level ? floorRadius(level, cfg, s.angle, s.z) : cfg.R)) - heightAboveFloor;
  return [r * Math.cos(s.angle), r * Math.sin(s.angle), s.z];
}
