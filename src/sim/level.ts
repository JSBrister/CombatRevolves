// Static level geometry (in the rotating frame) and its signed distance field.
// Solids: the cylindrical hull (floor), two rim walls, and obstacle boxes that
// are axis-aligned in the local frame of their ring angle.

import { rngNext, rngRange } from './rng';
import type { Box, ItemKind, Level, SimConfig, SpawnPoint } from './types';
import { type Vec3, rhoOf } from './vec';
import { floorRadius, makeHills, terrainAt } from './terrain';

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

function boxSdf(p: Vec3, b: Box, out: SdfHit) {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  // local axes: spin = (-s, c, 0), up = (-c, -s, 0), axial = (0,0,1)
  const dx = p[0] - b.center[0], dy = p[1] - b.center[1], dz = p[2] - b.center[2];
  // (spinward, up) components, then rotate into the box's tilted frame
  const ls = -s * dx + c * dy;
  const lu = -c * dx - s * dy;
  const ct = Math.cos(b.tilt), st = Math.sin(b.tilt);
  const lx = ct * ls + st * lu;
  const ly = -st * ls + ct * lu;
  const lz = dz;
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
  // undo the tilt, then back to world: spin*ns + up*nu + axial*nz
  const ns = ct * nx - st * ny, nu = st * nx + ct * ny;
  out.n = [-s * ns - c * nu, c * ns - s * nu, nz];
}

/** Signed distance from p to the level. Positive in free space. */
export function levelSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  switch (level.shape) {
    case 'ring':
      return ringSdf(level, cfg, p);
  }
}

function ringSdf(level: Level, cfg: SimConfig, p: Vec3): SdfHit {
  const out: SdfHit = { d: Infinity, n: [0, 0, 1] };
  const rho = rhoOf(p);
  const R = cfg.R, W = cfg.halfWidth, T = cfg.wallThickness, hull = cfg.hullThickness;
  const theta = Math.atan2(p[1], p[0]);
  if (level.terrain) terrainFloor(level, cfg, p, rho, theta, out);
  else annulus(p, rho, R, R + hull, -(W + T), W + T, out); // floor / hull
  // rim walls stand on the floor at the edge (higher up on a sphere band)
  const edge = level.terrain?.sphere ? R - Math.sqrt(R * R - W * W) : 0;
  rimWall(p, rho, theta, level.wallPos, R - edge, R + hull, W, W + T, out); // +Z rim wall
  rimWall(p, rho, theta, level.wallNeg, R - edge, R + hull, -(W + T), -W, out); // -Z rim wall
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
  for (let i = 0; i < n; i++) spawns.push({ angle: arcAngle(cfg, (i + off) / n), z: i % 2 === 0 ? -8 : 8 });
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
  const nRamps0 = withObstacles ? Math.max(2, Math.min(12, Math.round(span0 / 150))) : 0;
  const H0 = Math.max(2, Math.min(LOOKOUT_HEIGHT, 0.3 * R));
  const rampClear = Array.from({ length: nRamps0 }, (_, s) => ({
    angle: arcAngle(cfg, (s + 0.5) / nRamps0 + (cfg.arena > 0 ? 0 : 1 / 16)),
    halfArc: (H0 / RAMP_SLOPE + STAIR_TOP) / 2 + 2,
  }));
  const ridge = cfg.ridgeHeight > 0 ? { height: cfg.ridgeHeight, plateau: cfg.ridgePlateau } : undefined;
  const terrain = cfg.terrainSphere || cfg.hills > 0 || ridge
    ? { sphere: cfg.terrainSphere, hills: makeHills(cfg, cfg.hills, cfg.hillHeight, () => rngNext(rng), (u) => arcAngle(cfg, u), rampClear), ...(ridge ? { ridge } : {}) }
    : null;
  // Ramps and mesas need flat ground; on a sphere keep clutter to the lower latitudes.
  const steep = !!ridge;
  const Wp = cfg.terrainSphere ? Math.min(cfg.halfWidth, 0.45 * R) : cfg.halfWidth;
  const probe: Level = { shape: 'ring', terrain, boxes, stairTops: [], spawns, pickupSpots: [], vehicleSpots: [], wallPos: [], wallNeg: [] };
  /** Floor radius here (R on a flat floor). */
  const Rf = (angle: number, z: number) => floorRadius(probe, cfg, angle, z);
  /** How much a footprint of this size must be buried to sit on sloping ground. */
  const bury = (angle: number, z: number, ht: number, hz: number) => {
    if (!terrain) return 0;
    const t = terrainAt(probe, cfg, angle, z);
    return Math.abs(t.dhds) * ht + Math.abs(t.dhdz) * hz + 0.3;
  };
  const addBox = (angle: number, z: number, ht: number, hu: number, hz: number, kind: Box['kind'] = 'cover') => {
    const sag = (ht * ht) / (2 * R) + 0.05 + bury(angle, z, ht, hz); // bury the bottom so the curved floor never shows a gap
    const huTot = hu + sag / 2;
    const rc = Rf(angle, z) - 2 * hu + huTot; // top stays at height 2*hu
    boxes.push({ id: nextId(), type: 'box', kind, angle, tilt: 0, center: [rc * Math.cos(angle), rc * Math.sin(angle), z], half: [ht, huTot, hz] });
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
    // end walls closing off the arena
    const wh = fullWallHeight(cfg);
    for (const sgn of [-1, 1]) addBox((sgn * (cfg.arena / 2 + 0.75)) / R, 0, 0.75, wh / 2, cfg.halfWidth + cfg.wallThickness, 'wall');
  }
  if (withObstacles) {
    const circ = playSpan(cfg);
    // Ramps up to lookout platforms, midway between spawn points, alternating
    // which way they climb (climbing spinward vs antispinward feels different!).
    const nStairs = steep ? 0 : Math.max(2, Math.min(12, Math.round(circ / 150)));
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
    const floorItems: ItemKind[] = ['launcher', 'health', 'redRifle', 'sticky', 'rocket', 'laconic', 'bounce', 'seeker', 'health', 'sticky'];
    let fi = 0;
    for (let i = 0; i < spawns.length - (arena ? 1 : 0); i++) {
      const a = arcAngle(cfg, (i + (arena ? 1 : 0.5)) / spawns.length);
      const taken = stairs.some((s) => Math.abs(Math.atan2(Math.sin(a - s.angle), Math.cos(a - s.angle))) * R < s.halfArc + 2);
      if (taken) continue;
      pickupSpots.push({ pos: at(a, 1, 0), item: floorItems[fi++ % floorItems.length] });
    }
    // Hover-bikes on big rings, parked between spawn points.
    const nBikes = vehicleCount >= 0 ? vehicleCount : cfg.R >= cfg.vehicleMinRadius ? Math.min(10, Math.floor(circ / cfg.vehicleSpacing)) : 0;
    for (let i = 0; i < nBikes; i++) {
      const a = arcAngle(cfg, (i + 0.3) / nBikes);
      const z = i % 2 ? 5 : -5;
      vehicleSpots.push({ pos: at(a, BIKE_RADIUS, z), yaw: i % 2 ? Math.PI : 0 });
    }
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
  return { shape: 'ring', terrain, boxes, stairTops, spawns, pickupSpots, vehicleSpots, ...walls };
}

export const BIKE_RADIUS = 0.8; // hover-bike collision sphere
export const LOOKOUT_HEIGHT = 11; // m (capped at 30% of the radius on small rings)
export const MESA_HEIGHT = 3.5; // m: low raised platforms (capped at 15% of the radius)
export const RAMP_SLOPE = 0.45; // rise per metre (about 24 degrees): walkable
export const STAIR_WIDTH = 5; // m across the ring
export const STAIR_TOP = 6; // lookout platform length

export function spawnPosition(cfg: SimConfig, s: SpawnPoint, heightAboveFloor: number, level?: Level): Vec3 {
  const r = (level ? floorRadius(level, cfg, s.angle, s.z) : cfg.R) - heightAboveFloor;
  return [r * Math.cos(s.angle), r * Math.sin(s.angle), s.z];
}
