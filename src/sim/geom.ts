import type { Vec3 } from './vec';

/**
 * Closest points between segments p1-q1 and p2-q2 (Ericson, RTCD 5.1.9).
 * Returns params s (on first), t (on second) and squared distance.
 */
export function segSegClosest(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): { s: number; t: number; d2: number } {
  const d1x = q1[0] - p1[0], d1y = q1[1] - p1[1], d1z = q1[2] - p1[2];
  const d2x = q2[0] - p2[0], d2y = q2[1] - p2[1], d2z = q2[2] - p2[2];
  const rx = p1[0] - p2[0], ry = p1[1] - p2[1], rz = p1[2] - p2[2];
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const cx = p1[0] + d1x * s - (p2[0] + d2x * t);
  const cy = p1[1] + d1y * s - (p2[1] + d2y * t);
  const cz = p1[2] + d1z * s - (p2[2] + d2z * t);
  return { s, t, d2: cx * cx + cy * cy + cz * cz };
}

/** Closest point parameter on segment a-b to point p. */
export function closestOnSeg(p: Vec3, a: Vec3, b: Vec3): { t: number; point: Vec3 } {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? clamp01(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2) : 0;
  return { t, point: [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t] };
}

/** First contact fraction of a moving sphere (p0->p1, radius r) with a static sphere (c, rc). */
export function segSphere(p0: Vec3, p1: Vec3, c: Vec3, rr: number): number | null {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const mx = p0[0] - c[0], my = p0[1] - c[1], mz = p0[2] - c[2];
  const a = dx * dx + dy * dy + dz * dz;
  const b = mx * dx + my * dy + mz * dz;
  const cc = mx * mx + my * my + mz * mz - rr * rr;
  if (cc <= 0) return 0;
  if (a < 1e-14 || b > 0) return null;
  const disc = b * b - a * cc;
  if (disc < 0) return null;
  const s = (-b - Math.sqrt(disc)) / a;
  return s <= 1 ? Math.max(0, s) : null;
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
