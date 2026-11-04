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

import type { Hill, Level, SimConfig } from './types';

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

/** Floor radius (distance from the axis to the floor surface) at (angle, z). */
export function floorRadius(level: Level, cfg: SimConfig, angle: number, z: number): number {
  return cfg.R - terrainAt(level, cfg, angle, z).h;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Seeded hills for a level (kept away from the rim walls). */
export function makeHills(
  cfg: SimConfig, count: number, maxHeight: number, rand: () => number, arc: (u: number) => number,
  keepClear: { angle: number; halfArc: number }[] = [],
): Hill[] {
  const hills: Hill[] = [];
  for (let i = 0; i < count; i++) {
    const radius = 6 + rand() * 16;
    const zr = Math.max(0, cfg.halfWidth - radius * 0.8 - 4);
    const angle = arc((i + 0.2 + rand() * 0.6) / count);
    const z = (rand() * 2 - 1) * zr;
    const height = maxHeight * (0.3 + 0.7 * rand());
    // ramps and lookouts need flat ground: no hill within 2.5 sigma of one
    if (keepClear.some((k) => Math.abs(wrap(angle - k.angle)) * cfg.R < k.halfArc + 2.5 * radius)) continue;
    hills.push({ angle, z, height, radius });
  }
  return hills;
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
