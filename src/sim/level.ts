// Static level geometry (in the rotating frame) and its signed distance field.
// Solids: the cylindrical hull (floor), two rim walls, and obstacle boxes that
// are axis-aligned in the local frame of their ring angle.

import { rngNext, rngRange } from './rng';
import type { Box, Level, SimConfig, SpawnPoint } from './types';
import { type Vec3, rhoOf } from './vec';

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
    d = Math.hypot(ur, uz);
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
  const d = Math.hypot(ur, uz, ut);
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

function boxSdf(p: Vec3, b: Box, out: SdfHit) {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  // local axes: spin = (-s, c, 0), up = (-c, -s, 0), axial = (0,0,1)
  const dx = p[0] - b.center[0], dy = p[1] - b.center[1], dz = p[2] - b.center[2];
  const lx = -s * dx + c * dy;
  const ly = -c * dx - s * dy;
  const lz = dz;
  const qx = Math.abs(lx) - b.half[0], qy = Math.abs(ly) - b.half[1], qz = Math.abs(lz) - b.half[2];
  let d: number, nx = 0, ny = 0, nz = 0;
  if (qx > 0 || qy > 0 || qz > 0) {
    const ux = Math.max(qx, 0), uy = Math.max(qy, 0), uz = Math.max(qz, 0);
    d = Math.hypot(ux, uy, uz);
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
  // back to world: spin*nx + up*ny + axial*nz
  out.n = [-s * nx - c * ny, c * nx - s * ny, nz];
}

/** Signed distance from p to the level. Positive in free space. */
export function levelSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  const out: SdfHit = { d: Infinity, n: [0, 0, 1] };
  const rho = rhoOf(p);
  const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
  annulus(p, rho, R, R + hull, -(W + T), W + T, out); // floor / hull
  const theta = Math.atan2(p[1], p[0]);
  rimWall(p, rho, theta, level.wallPos, R, R + hull, W, W + T, out); // +Z rim wall
  rimWall(p, rho, theta, level.wallNeg, R, R + hull, -(W + T), -W, out); // -Z rim wall
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
  const L = Math.hypot(dx, dy, dz);
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

export function makeSpawns(cfg: SimConfig): SpawnPoint[] {
  const spawns: SpawnPoint[] = [];
  const n = 8;
  for (let i = 0; i < n; i++) spawns.push({ angle: (i / n) * Math.PI * 2, z: i % 2 === 0 ? -8 : 8 });
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
      if (!varied) { hs.push(cfg.wallHeight); continue; }
      const r = rngNext(rng);
      hs.push(r < 0.5 ? cfg.wallHeight : r < 0.75 ? Math.min(cfg.wallHeight, 4) : Math.min(cfg.wallHeight, 1));
    }
    return hs;
  };
  return { wallPos: side(), wallNeg: side() };
}

export function generateLevel(cfg: SimConfig, rng: { rng: number }, withObstacles: boolean, nextId: () => number, variedWalls = true): Level {
  const spawns = makeSpawns(cfg);
  const walls = makeWalls(cfg, rng, variedWalls);
  const boxes: Box[] = [];
  const R = cfg.R;
  const addBox = (angle: number, z: number, ht: number, hu: number, hz: number) => {
    const sag = (ht * ht) / (2 * R) + 0.05; // bury the bottom so the curved floor never shows a gap
    const huTot = hu + sag / 2;
    const rc = R - 2 * hu + huTot; // top stays at height 2*hu
    boxes.push({ id: nextId(), type: 'box', angle, center: [rc * Math.cos(angle), rc * Math.sin(angle), z], half: [ht, huTot, hz] });
  };
  if (withObstacles) {
    const circ = 2 * Math.PI * R;
    const count = Math.max(10, Math.min(60, Math.round(circ / 22)));
    for (let i = 0; i < count; i++) {
      const angle = ((i + rngRange(rng, 0.2, 0.8)) / count) * Math.PI * 2;
      // keep spawns clear
      const near = spawns.some((s) => Math.abs(Math.atan2(Math.sin(angle - s.angle), Math.cos(angle - s.angle))) * R < 5);
      if (near) continue;
      const kind = rngNext(rng);
      const z = rngRange(rng, -cfg.halfWidth + 4, cfg.halfWidth - 4);
      if (kind < 0.5) addBox(angle, z, rngRange(rng, 0.8, 2.2), rngRange(rng, 0.5, 0.9), rngRange(rng, 1.5, 3.5)); // low cover
      else if (kind < 0.8) addBox(angle, z, rngRange(rng, 1, 1.6), rngRange(rng, 1.8, 3), rngRange(rng, 1, 1.6)); // pillar
      else addBox(angle, z, rngRange(rng, 3, 5), rngRange(rng, 0.4, 0.6), rngRange(rng, 3, 5)); // low platform
    }
  }
  return { boxes, spawns, ...walls };
}

export function spawnPosition(cfg: SimConfig, s: SpawnPoint, heightAboveFloor: number): Vec3 {
  const r = cfg.R - heightAboveFloor;
  return [r * Math.cos(s.angle), r * Math.sin(s.angle), s.z];
}
