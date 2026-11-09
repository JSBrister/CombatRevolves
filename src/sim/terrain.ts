// Terrain: an optional height profile on the ring floor.
//
// The floor surface sits at radius R - h(angle, z), where h is the sum of
//  - a sphere profile (optional): the floor is a band round the inside of a
//    sphere of radius R, so it curves up toward the axis at the edges.
//    The spin still pulls straight away from the axis, so walking toward an
//    edge feels like climbing a slope equal to your latitude, in weaker g;
//  - Gaussian hills.
// Collision uses F = rho - (R - h) (> 0 inside the floor) and its gradient for
// a distance estimate d ~ -F/|grad F| (exact for planes, close for smooth hills).

import type { Bump, Hill, Level, SimConfig } from './types';

/** Height of the floor above radius R at (angle, z), and its slope (dh/ds along the ring, dh/dz across). */
export function terrainAt(level: Level, cfg: SimConfig, angle: number, z: number): { h: number; dhds: number; dhdz: number } {
  const t = level.terrain;
  if (!t) return { h: 0, dhds: 0, dhdz: 0 };
  let h = 0, dhds = 0, dhdz = 0;
  if (t.sphere) {
    const R = cfg.R;
    const zz = Math.min(Math.abs(z), R * 0.999);
    const root = Math.sqrt(R * R - zz * zz);
    h += R - root;
    dhdz += (Math.sign(z) * zz) / root;
  }
  if (t.tube) {
    // circular cross-section of radius a touching R at z = 0: curving up (inside / half) or away (outside)
    const a = t.tube.radius;
    const zz = Math.min(Math.abs(z), a * 0.999);
    const root = Math.sqrt(a * a - zz * zz);
    const sgn = t.tube.kind === 'outside' ? -1 : 1;
    h += sgn * (a - root);
    dhdz += sgn * (Math.sign(z) * zz) / root;
  }
  if (t.ridge && t.ridge.height > 0) {
    // Lambda: straight flanks from the rim walls up to a rounded crest along z = 0
    const c = t.ridge.plateau, W = cfg.halfWidth;
    const span = Math.sqrt(W * W + c * c) - c; // so the flanks reach the floor exactly at the walls
    const q = Math.sqrt(z * z + c * c);
    const u = (q - c) / span;
    if (u < 1) {
      h += t.ridge.height * (1 - u);
      dhdz -= (t.ridge.height / span) * (z / q);
    }
  }
  for (const hl of t.hills) {
    const ds = wrap(angle - hl.angle) * cfg.R;
    const dz = z - hl.z;
    const r2 = hl.radius * hl.radius;
    if (ds * ds + dz * dz > 9 * r2) continue; // beyond 3 sigma: negligible
    const e = hl.height * Math.exp(-(ds * ds + dz * dz) / (2 * r2));
    h += e;
    dhds -= (e * ds) / r2;
    dhdz -= (e * dz) / r2;
  }
  return { h, dhds, dhdz };
}

/** Just the hills' (and mountains') height at (angle, z), without the floor's own curve. */
export function hillsAt(level: Level, cfg: SimConfig, angle: number, z: number): number {
  let h = 0;
  for (const hl of level.terrain?.hills ?? []) {
    const ds = wrap(angle - hl.angle) * cfg.R, dz = z - hl.z, r2 = hl.radius * hl.radius;
    if (ds * ds + dz * dz > 9 * r2) continue;
    h += hl.height * Math.exp(-(ds * ds + dz * dz) / (2 * r2));
  }
  return h;
}

/** Floor radius (distance from the axis to the floor surface) at (angle, z). */
export function floorRadius(level: Level, cfg: SimConfig, angle: number, z: number): number {
  return cfg.R - terrainAt(level, cfg, angle, z).h;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Somewhere that must stay flat: an angular band (the whole width), or a patch if z/halfZ are given. */
export interface ClearZone { angle: number; halfArc: number; z?: number; halfZ?: number }
const blocks = (cfg: SimConfig, k: ClearZone, angle: number, z: number, m: number) =>
  Math.abs(wrap(angle - k.angle)) * cfg.R < k.halfArc + m && (k.z === undefined || Math.abs(z - k.z) < (k.halfZ ?? 0) + m);

/** Seeded hills for a level (kept away from the rim walls). */
export function makeHills(
  cfg: SimConfig, count: number, maxHeight: number, rand: () => number, arc: (u: number) => number,
  keepClear: ClearZone[] = [], margin = 2.5,
): Hill[] {
  const hills: Hill[] = [];
  for (let i = 0; i < count; i++) {
    const radius = 6 + rand() * 16;
    const zr = Math.max(0, cfg.halfWidth - radius * 0.8 - 4);
    let angle = arc((i + 0.2 + rand() * 0.6) / count);
    let z = (rand() * 2 - 1) * zr;
    const height = maxHeight * (0.3 + 0.7 * rand());
    // ramps and lookouts need flat ground: no hill within 2.5 sigma of one.
    // If this spot is taken, try a few others rather than dropping the hill.
    let ok = !keepClear.some((k) => blocks(cfg, k, angle, z, margin * radius));
    for (let tryN = 0; !ok && tryN < 12; tryN++) {
      angle = arc(rand());
      z = (rand() * 2 - 1) * zr;
      ok = !keepClear.some((k) => blocks(cfg, k, angle, z, margin * radius));
    }
    if (ok) hills.push({ angle, z, height, radius });
  }
  return hills;
}

/**
 * Mountains: like hills, but as wide as they're tall (sigma = 1.0-1.4 x the
 * height), so the slopes stay walkable (under ~30 degrees) and they read as
 * massifs, not bumps. Kept 3 sigma clear of `keepClear` (where they've faded out).
 */
export function makeMountains(
  cfg: SimConfig, count: number, maxHeight: number, rand: () => number, arc: (u: number) => number,
  keepClear: ClearZone[] = [], pickAngle?: (rand: () => number) => number, maxRadius = Math.max(20, cfg.halfWidth / 2.5),
): Hill[] {
  const out: Hill[] = [];
  for (let i = 0; i < count; i++) {
    const height = maxHeight * (0.5 + 0.5 * rand());
    const radius = Math.min(maxRadius, height * (1.0 + 0.4 * rand()));
    const zr = Math.max(0, cfg.halfWidth - radius * 2);
    // a few tries at a spot that's clear (between windows, away from bases)
    for (let tryN = 0; tryN < 10; tryN++) {
      const angle = pickAngle ? pickAngle(rand) : arc(rand());
      const z = (rand() * 2 - 1) * zr;
      if (keepClear.some((k) => blocks(cfg, k, angle, z, 3 * radius))) continue;
      if (out.some((m) => Math.abs(wrap(angle - m.angle)) * cfg.R < 1.5 * (radius + m.radius) && Math.abs(z - m.z) < 1.5 * (radius + m.radius))) continue;
      out.push({ angle, z, height: Math.min(height, 1.2 * radius), radius }); // never steeper than ~36 degrees
      break;
    }
  }
  return out;
}

/** How high the floor is at the ring's edges (z = +-halfWidth): where the rim walls stand. */
export function edgeHeight(level: Level, cfg: SimConfig): number {
  const t = level.terrain;
  if (!t) return 0;
  const W = cfg.halfWidth;
  let h = 0;
  if (t.sphere) h += cfg.R - Math.sqrt(Math.max(0, cfg.R * cfg.R - W * W));
  if (t.tube && t.tube.kind !== 'outside') { const a = t.tube.radius; h += a - Math.sqrt(Math.max(0, a * a - Math.min(W, a) ** 2)); }
  return h;
}

// ---------------------------------------------------------------- bumps (planets and disks)

/**
 * Planet: height of the ground above radius R in direction n (a unit vector),
 * and its gradient with respect to n (take the part across n, over the radius,
 * for the slope along the ground). Distances use the chord, R |n - c|: smooth,
 * and the same as along the surface for hills small next to the planet.
 */
export function planetBumpsAt(bumps: Bump[] | undefined, R: number, n: readonly number[]): { h: number; g: [number, number, number] } {
  let h = 0, g0 = 0, g1 = 0, g2 = 0;
  for (const b of bumps ?? []) {
    const dx = n[0] - b.c[0], dy = n[1] - b.c[1], dz = n[2] - b.c[2];
    const d2 = R * R * (dx * dx + dy * dy + dz * dz), s2 = b.radius * b.radius;
    if (d2 > 9 * s2) continue;
    const e = b.height * Math.exp(-d2 / (2 * s2)), k = (-e * R * R) / s2;
    h += e; g0 += k * dx; g1 += k * dy; g2 += k * dz;
  }
  return { h, g: [g0, g1, g2] };
}

/** Disk: height of the bumps at (x, y), and their slope. */
export function diskBumpsAt(bumps: Bump[] | undefined, x: number, y: number): { h: number; gx: number; gy: number } {
  let h = 0, gx = 0, gy = 0;
  for (const b of bumps ?? []) {
    const dx = x - b.c[0], dy = y - b.c[1], s2 = b.radius * b.radius, d2 = dx * dx + dy * dy;
    if (d2 > 9 * s2) continue;
    const e = b.height * Math.exp(-d2 / (2 * s2));
    h += e; gx -= (e * dx) / s2; gy -= (e * dy) / s2;
  }
  return { h, gx, gy };
}

/**
 * Seeded hills and mountains for a planet or a disk, placed by `pick` (which
 * returns a peak position for a random draw, or null to skip). Same shapes as
 * on a ring: hills 6-22 m across, mountains about as wide as they're tall.
 */
export function makeBumps(
  cfg: SimConfig, rand: () => number, pick: (u: number, v: number, radius: number) => [number, number, number] | null, maxMountain = Infinity,
): Bump[] {
  const out: Bump[] = [];
  const place = (height: number, radius: number) => {
    for (let tryN = 0; tryN < 10; tryN++) {
      const c = pick(rand(), rand(), radius);
      if (c) { out.push({ c, height, radius }); return; }
    }
  };
  for (let i = 0; i < cfg.hills; i++) place(cfg.hillHeight * (0.3 + 0.7 * rand()), 6 + rand() * 16);
  for (let i = 0; i < cfg.mountains; i++) {
    const height = Math.min(maxMountain, cfg.mountainHeight * (0.5 + 0.5 * rand()));
    const radius = height * (1.0 + 0.4 * rand());
    place(Math.min(height, 1.2 * radius), radius);
  }
  return out;
}
