// Spin Tower: a closed tower through the spin axis instead of a ring.
//
// Two arms stick out from the axis in opposite directions (+x and -x in the
// rotating frame), each a box `halfWidth` across (round the spin) and
// cfg.halfWidth deep (along the axis), closed off at radius R. You start at
// the far end of an arm, where the spin gives the full g, and climb floors
// toward the axis, where you weigh almost nothing; the hollow runs straight
// through the axis into the other arm.
//
// The floors are curved slabs at constant radius (level ground: the spin's
// pull is straight out from the axis everywhere), with openings for the ramps
// and lifts between them. Everything is 180-degree symmetric about the axis,
// so the SDF folds a point into the +x arm and works there.

import { rngNext } from './rng';
import type { Box, ItemKind, Level, Pad, SimConfig, SpawnPoint, Tower, TowerFloor } from './types';
import type { Vec3 } from './vec';

export interface TowerHit { d: number; n: Vec3 }

/** Floor radii and the neck, for a tower of radius R (fractions tuned so each storey is a ramp or a lift ride). */
export function towerLayout(R: number): number[] {
  return [0.9, 0.79, 0.66, 0.5, 0.15].map((f) => f * R);
}

/** Distance from p to the tower's walls and floors (positive in free space), into `out` if nearer. */
export function towerSdf(T: Tower, cfg: SimConfig, p: Vec3, out: TowerHit) {
  const flip = p[0] < 0;
  const x = flip ? -p[0] : p[0], y = flip ? -p[1] : p[1], z = p[2];
  const rho = Math.hypot(x, y) || 1e-9;
  const rx = x / rho, ry = y / rho;
  const sy = Math.sign(y) || 1, sz = Math.sign(z) || 1;
  // inside the hollow: across, out to the end wall, and along the axis
  let d = T.halfWidth - Math.abs(y), n: Vec3 = [0, -sy, 0];
  const dEnd = cfg.R - rho;
  if (dEnd < d) { d = dEnd; n = [-rx, -ry, 0]; }
  const dz = cfg.halfWidth - Math.abs(z);
  if (dz < d) { d = dz; n = [0, 0, -sz]; }
  // floors: a slab from r to r + thickness, minus its openings
  for (const f of T.floors) {
    const half = f.thickness / 2;
    let fd = Math.abs(rho - (f.r + half)) - half;
    if (fd >= d) continue;
    const s = Math.sign(rho - (f.r + half)) || 1;
    let fn: Vec3 = [s * rx, s * ry, 0];
    for (const h of f.holes) {
      // the opening's prism (along the radius), as a 2D box in (y, z)
      const qy = Math.abs(y - h.y) - h.hy, qz = Math.abs(z - h.z) - h.hz;
      let hd: number, gy = 0, gz = 0;
      if (qy > 0 || qz > 0) {
        const uy = Math.max(qy, 0), uz = Math.max(qz, 0);
        hd = Math.hypot(uy, uz);
        gy = (uy / hd) * Math.sign(y - h.y); gz = (uz / hd) * Math.sign(z - h.z);
      } else if (qy > qz) { hd = qy; gy = Math.sign(y - h.y) || 1; } else { hd = qz; gz = Math.sign(z - h.z) || 1; }
      if (-hd > fd) { fd = -hd; fn = [0, -gy, -gz]; }
    }
    if (fd < d) { d = fd; n = fn; }
  }
  if (d < out.d) { out.d = d; out.n = flip ? [-n[0], -n[1], n[2]] : n; }
}

/** Radius of the floor under a point (the first one out from it that isn't open there). */
export function towerFloorBelow(T: Tower, cfg: SimConfig, p: Vec3): number {
  const y = p[0] < 0 ? -p[1] : p[1], z = p[2];
  const rho = Math.hypot(p[0], p[1]);
  let best = cfg.R;
  for (const f of T.floors) {
    if (f.r < rho - 0.5 || f.r >= best) continue;
    if (f.holes.some((h) => Math.abs(y - h.y) < h.hy && Math.abs(z - h.z) < h.hz)) continue;
    best = f.r;
  }
  return best;
}

/** A point at radius r in arm `arm` (0: +x, 1: -x), `y` across it and `z` along the axis. */
export function towerPoint(r: number, y: number, z: number, arm: 0 | 1): Vec3 {
  const x = Math.sqrt(Math.max(0, r * r - y * y));
  return arm ? [-x, -y, z] : [x, y, z];
}

const RAMP_SLOPE = 0.45, RAMP_W = 4, LIFT_HALF = 1.8;

export function generateTower(cfg: SimConfig, rng: { rng: number }, withObstacles: boolean, nextId: () => number): Level {
  const R = cfg.R, W = cfg.tower, hw = cfg.halfWidth;
  const radii = towerLayout(R), hubR = 0.36 * R;
  const floors: TowerFloor[] = radii.map((r) => ({ r, thickness: 0.8, holes: [] }));
  const T: Tower = { halfWidth: W, floors };
  const boxes: Box[] = [];
  const pads: Pad[] = [];
  const pickupSpots: { pos: Vec3; item: ItemKind }[] = [];
  const spawns: SpawnPoint[] = [];
  /** Footprints on each floor (index 0 = the end wall at R, k + 1 = floors[k]) that must stay clear. */
  const used: { y: number; z: number; hy: number; hz: number }[][] = radii.map(() => []).concat([[]]);
  const holesOn = (fi: number) => (fi === 0 ? [] : floors[fi - 1].holes);
  const clear = (fi: number, y: number, z: number, hy: number, hz: number, m = 1) =>
    [...holesOn(fi), ...used[fi]].every((h) => Math.abs(y - h.y) > hy + h.hy + m || Math.abs(z - h.z) > hz + h.hz + m);
  const rOf = (fi: number) => (fi === 0 ? R : radii[fi - 1]);
  const rot = (v: Vec3, arm: 0 | 1): Vec3 => (arm ? [-v[0], -v[1], v[2]] : v);

  /** A box standing on floor `fi` at (y, z): its own frame is the radial one there. */
  const stand = (fi: number, y: number, z: number, ht: number, hu: number, hz: number, kind: Box['kind'] = 'cover') => {
    const r = rOf(fi);
    for (const arm of [0, 1] as const) {
      const c = towerPoint(r - hu + 0.1, y, z, arm);
      boxes.push({ id: nextId(), type: 'box', kind, angle: Math.atan2(c[1], c[0]), tilt: 0, center: c, half: [ht, hu + 0.1, hz] });
    }
    used[fi].push({ y, z, hy: ht, hz });
  };
  /** A straight ramp along the axis at `y`, from floor fi at z0 up to the next floor at z0 + dir * L. */
  const ramp = (fi: number, y: number, dir: 1 | -1) => {
    const r0 = rOf(fi), r1 = rOf(fi + 1), L = (r0 - r1) / RAMP_SLOPE;
    const z0 = (-dir * L) / 2, z1 = (dir * L) / 2;
    for (const arm of [0, 1] as const) {
      const B = towerPoint(r0, y, z0, 0), Tp = towerPoint(r1, y, z1, 0);
      const dx = Tp[0] - B[0], dy = Tp[1] - B[1], dzz = Tp[2] - B[2];
      const len = Math.hypot(dx, dy, dzz);
      const X: Vec3 = [dx / len, dy / len, dzz / len];
      const mid: Vec3 = [(B[0] + Tp[0]) / 2, (B[1] + Tp[1]) / 2, (B[2] + Tp[2]) / 2];
      const mr = Math.hypot(mid[0], mid[1]);
      const u: Vec3 = [-mid[0] / mr, -mid[1] / mr, 0]; // up (toward the axis) at its middle
      const ux = u[0] * X[0] + u[1] * X[1];
      const N0: Vec3 = [u[0] - ux * X[0], u[1] - ux * X[1], -ux * X[2]];
      const nl = Math.hypot(...N0);
      const N: Vec3 = [N0[0] / nl, N0[1] / nl, N0[2] / nl];
      const Z: Vec3 = [X[1] * N[2] - X[2] * N[1], X[2] * N[0] - X[0] * N[2], X[0] * N[1] - X[1] * N[0]];
      const hy = 0.35;
      const c: Vec3 = [mid[0] - N[0] * hy, mid[1] - N[1] * hy, mid[2] - N[2] * hy];
      boxes.push({ id: nextId(), type: 'box', kind: 'ramp', angle: Math.atan2(rot(mid, arm)[1], rot(mid, arm)[0]), tilt: 0, center: rot(c, arm), half: [len / 2, hy, RAMP_W / 2], axes: [rot(X, arm), rot(N, arm), rot(Z, arm)] });
    }
    used[fi].push({ y, z: 0, hy: RAMP_W / 2, hz: L / 2 + 1.5 });
    // the opening above it: the whole run, so you never bang your head
    floors[fi].holes.push({ y, z: (z0 + z1) / 2 - dir * 0.5, hy: RAMP_W / 2 + 0.4, hz: L / 2 + 0.5 });
  };
  /** A lift from floor fi up through an opening in the next one. */
  const lift = (fi: number, y: number, z: number, phase: number) => {
    const r0 = rOf(fi), r1 = rOf(fi + 1), th = 0.2;
    const travel = r0 - r1;
    for (const arm of [0, 1] as const) {
      const base = towerPoint(r0 + th, y, z, arm);
      boxes.push({ id: nextId(), type: 'box', kind: 'lift', angle: Math.atan2(base[1], base[0]), tilt: 0, center: [...base] as Vec3, half: [LIFT_HALF, th, LIFT_HALF], lift: { base, travel, period: Math.max(12, travel * 0.8), phase: phase + arm * 0.5 } });
    }
    used[fi].push({ y, z, hy: LIFT_HALF + 0.5, hz: LIFT_HALF + 0.5 });
    // it rises straight out along its radius, so it arrives a little nearer the middle
    const yTop = (y * r1) / r0;
    floors[fi].holes.push({ y: yTop, z, hy: LIFT_HALF + 0.35, hz: LIFT_HALF + 0.35 });
  };

  // storeys: a ramp and a lift where a ramp fits, otherwise two lifts
  const zl = hw - LIFT_HALF - 1.7;
  const nStoreys = radii.length; // from the end wall (0) up to each floor
  for (let k = 0; k < nStoreys; k++) {
    const rise = rOf(k) - rOf(k + 1);
    const s: 1 | -1 = k % 2 ? -1 : 1;
    const neck = rOf(k + 1) < hubR; // the long lift up to the hub floor: in the middle
    const yA = neck ? 0 : (s * W) / 2;
    if (!neck && rise / RAMP_SLOPE <= 2 * (zl - LIFT_HALF - 2)) {
      ramp(k, yA, s);
      lift(k, -yA, -s * zl, 0.25 * k);
      continue;
    }
    const cands: [number, number][] = neck
      ? [[0, zl], [0, -zl], [0, 0]]
      : [[yA, s * zl], [-yA, -s * zl], [yA, -s * zl], [-yA, s * zl], [yA, 0], [-yA, 0]];
    let placed = 0;
    for (const [y, z] of cands) {
      if (placed >= 2) break;
      // clear here, and its opening in the next floor clear of what's already planned up there
      if (!clear(k, y, z, LIFT_HALF, LIFT_HALF, 1.5)) continue;
      lift(k, y, z, 0.3 * placed + 0.1 * k);
      placed++;
    }
  }

  // The hub floor: launch pads that throw you across the axis onto the other arm's hub floor.
  // Coriolis bends the path round, so they throw you well antispinward of straight up
  // (tuned by test: about 3 s across, landing near the middle of the far floor).
  const top = floors[floors.length - 1];
  const padSpeed = 2.05 * Math.sqrt(cfg.g / R) * top.r, padTilt = 0.9;
  for (const z of [-hw / 3, hw / 3]) {
    if (!clear(nStoreys, 0, z, 1.2, 1.2, 0.5)) continue;
    for (const arm of [0, 1] as const) {
      const pos = towerPoint(top.r, 0, z, arm);
      const up: Vec3 = rot([-1, 0, 0], arm), spin: Vec3 = rot([0, 1, 0], arm);
      const ct = Math.cos(padTilt), st = Math.sin(padTilt);
      pads.push({ pos, up: [up[0] * ct - spin[0] * st, up[1] * ct - spin[1] * st, 0], speed: padSpeed });
    }
    used[nStoreys].push({ y: 0, z, hy: 1.5, hz: 1.5 });
  }

  // Spawn points: on the end wall of each arm, and part-way up (so not everyone starts at the bottom)
  const spawnCands: [number, number, number][] = [
    [0, -W / 2, -hw / 2], [0, W / 2, hw / 2], [0, 0, -hw + 3], [0, 0, hw - 3], [0, -W / 2, hw / 2], [0, W / 2, -hw / 2],
    [2, -W / 2, -hw / 2], [2, W / 2, hw / 2], [2, 0, 0], [2, -W + 2, hw - 4], [2, W - 2, -hw + 4],
  ];
  const perFloor = [3, 0, 1];
  for (const fi of [0, 2]) {
    let n = 0;
    for (const [f, y, z] of spawnCands) {
      if (f !== fi || n >= perFloor[fi]) continue;
      if (!clear(fi, y, z, 1.5, 1.5, 1)) continue;
      used[fi].push({ y, z, hy: 1.5, hz: 1.5 });
      const r = rOf(fi);
      for (const arm of [0, 1] as const) spawns.push({ angle: Math.asin(y / r) + arm * Math.PI, z, ...(fi ? { floor: r } : {}) });
      n++;
    }
  }

  if (withObstacles) {
    // cover on every floor of the body, and something worth climbing for on each
    const items: ItemKind[] = ['health', 'sticky', 'scatter', 'rocket', 'launcher', 'jetpack'];
    for (let fi = 0; fi <= nStoreys; fi++) {
      const r = rOf(fi);
      if (r < hubR) continue;
      const k = Math.min(1, r / R + 0.3);
      const ys = [-W + 2.2, 0, W - 2.2], zs = [-hw + 4, -hw / 3, 0, hw / 3, hw - 4];
      let n = 0;
      for (let i = 0; i < 12 && n < 4; i++) {
        const y = ys[Math.floor(rngNext(rng) * ys.length)], z = zs[Math.floor(rngNext(rng) * zs.length)];
        const tall = rngNext(rng) < 0.4;
        const ht = tall ? 1 : 1.2 + rngNext(rng), hz = tall ? 1 : 1.5 + rngNext(rng);
        if (!clear(fi, y, z, ht, hz, 1.2)) continue;
        stand(fi, y, z, ht, (tall ? 1.6 : 0.6) * k + 0.2, hz, tall ? 'struct' : 'cover');
        n++;
      }
      for (let i = 0; i < 10; i++) {
        const y = (rngNext(rng) * 2 - 1) * (W - 2), z = (rngNext(rng) * 2 - 1) * (hw - 3);
        if (!clear(fi, y, z, 0.8, 0.8, 1)) continue;
        for (const arm of [0, 1] as const) pickupSpots.push({ pos: towerPoint(r - 1, y, z, arm), item: items[fi % items.length] });
        used[fi].push({ y, z, hy: 0.8, hz: 0.8 });
        break;
      }
    }
    // prizes floating at the axis, where you weigh nothing
    pickupSpots.push({ pos: [0, 0, 0], item: 'cannon' }, { pos: [0, 0, -hw / 2], item: 'chaos' }, { pos: [0, 0, hw / 2], item: 'seeker' });
  }
  return { shape: 'tower', terrain: null, tower: T, boxes, stairTops: [], spawns, pickupSpots, vehicleSpots: [], wallPos: [], wallNeg: [], pads };
}
