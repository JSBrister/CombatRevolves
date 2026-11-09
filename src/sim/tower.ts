// Spin Tower: a tower through the spin axis instead of a ring.
//
// Two arms stick out from the axis in opposite directions (+x and -x in the
// rotating frame). Each is a stack of floors, open at the sides, stepping in
// toward the axis like a ziggurat: the bottom floor (at radius R, the full g)
// is the biggest, and each one up is smaller, so from below you can see up the
// tower, and out past the edges to the stars wheeling round. You climb ramps
// from floor to floor toward the axis, where you weigh almost nothing, and
// launch pads on the top (hub) floor throw you across to the other arm.
//
// The floors are curved slabs at constant radius (level ground: the spin's
// pull is straight out from the axis everywhere). Each storey's two ramps
// stand on the floor below, in the strip left round the floor above, and
// climb alongside that floor's edge to arrive level with it. Everything is
// 180-degree symmetric about the axis, so the SDF folds a point into the +x
// arm and works there.

import { rngNext } from './rng';
import type { Box, ItemKind, Level, Pad, SimConfig, SpawnPoint, Tower, TowerFloor } from './types';
import type { Vec3 } from './vec';

export interface TowerHit { d: number; n: Vec3 }

export const TOWER_RAMP_SLOPE = 0.6; // rise per metre (31 degrees)
const RAMP_W = 5; // ramp width
const STEP = RAMP_W + 2; // how much bigger each floor is than the one above, on the ramps' sides
const LAND = 4; // the landing at a ramp's top, beside the floor it arrives at

/**
 * How a storey is climbed: two ramps, either round the spin ('y': beside the
 * upper floor's +-z edges, sweeping through +-halfAngle) or along the axis
 * ('z': beside its +-y edges, each straight up a radial line at angle +-phi,
 * so "down" never leans across it).
 */
export interface TowerStorey { along: 'y' | 'z'; rise: number; len: number; halfAngle: number; phi: number }

/**
 * The floors of a tower of radius R, bottom first, and how each storey is
 * climbed. Built from the top down: each floor is one ramp strip bigger than
 * the one above, on the sides where that storey's ramps go. Near the axis the
 * ramps run round the spin (y) and the floors grow along the axis; further
 * out, where the floors curve less, they run along the axis and the floors
 * grow round the spin.
 */
export function towerLayout(cfg: SimConfig): { floors: TowerFloor[]; storeys: TowerStorey[] } {
  const R = cfg.R;
  const radii = [1, 0.86, 0.72, 0.58, 0.45, 0.32, 0.18].map((f) => f * R);
  const n = radii.length - 1;
  const storeys: TowerStorey[] = [];
  for (let k = 0; k < n; k++) {
    const rise = radii[k] - radii[k + 1], len = rise / TOWER_RAMP_SLOPE;
    // near the axis (where floors curve a lot across the spin) the ramps go round the spin and the floors grow along the axis
    storeys.push({ along: radii[k + 1] < 0.7 * R ? 'y' : 'z', rise, len, halfAngle: len / (radii[k] + radii[k + 1]), phi: 0 });
  }
  // a floor must reach past both ends of round-the-spin ramps that start on it or arrive beside it
  const reach = (k: number, s: TowerStorey | undefined) => (s && s.along === 'y' ? radii[k] * Math.sin(s.halfAngle) + LAND + 1.5 : 0);
  let w = Math.max(cfg.tower, reach(n, storeys[n - 1])), d = Math.max(12, 0.12 * R);
  const floors: TowerFloor[] = [];
  floors[n] = { r: radii[n], thickness: 0.8, w, d, holes: [] };
  for (let k = n - 1; k >= 0; k--) {
    const s = storeys[k];
    if (s.along === 'y') { d += STEP; w = Math.max(w, reach(k, s), reach(k, storeys[k - 1])); }
    else {
      // straight up a radial line that passes just outside the upper floor's edge
      // (its width runs round the spin, at angle phi to "across": so its inner edge, half a width round, must just meet the floor's edge, or there's a crack you get stuck in)
      const phi0 = Math.asin(Math.min(0.9, (w + RAMP_W / 2) / radii[k + 1]));
      s.phi = Math.asin(Math.min(0.9, (w + (RAMP_W / 2) * Math.cos(phi0) - 0.05) / radii[k + 1]));
      w = radii[k] * Math.sin(s.phi) + RAMP_W / 2 + 2;
      d = Math.max(d, s.len / 2 + LAND + 2);
    }
    floors[k] = { r: radii[k], thickness: k === 0 ? 3 : 0.8, w, d, holes: [] };
  }
  return { floors, storeys };
}

/** Distance from p to the tower's floors (positive in free space), into `out` if nearer. */
export function towerSdf(T: Tower, p: Vec3, out: TowerHit) {
  const flip = p[0] < 0;
  const x = flip ? -p[0] : p[0], y = flip ? -p[1] : p[1], z = p[2];
  const rho = Math.hypot(x, y) || 1e-9;
  const rx = x / rho, ry = y / rho;
  let d = out.d, n: Vec3 | null = null;
  for (const f of T.floors) {
    // the slab is where three bands meet: radius, across and along; the largest of the three
    // distances is a safe (never too big) estimate of the distance to it
    const half = f.thickness / 2;
    const dr = Math.abs(rho - (f.r + half)) - half, dy = Math.abs(y) - f.w, dz = Math.abs(z) - f.d;
    const sr = Math.sign(rho - (f.r + half)) || 1, sy = Math.sign(y) || 1, sz = Math.sign(z) || 1;
    let fd: number, fn: Vec3;
    if (dr > 0 && dy > 0) {
      // beyond an edge along the axis (over or under it): the distance to the edge itself
      // (the edge face is a plane across, not along the radius, so combining distances would be wrong)
      const re = sr < 0 ? f.r : f.r + f.thickness;
      const vx = x - Math.sqrt(Math.max(0, re * re - f.w * f.w)), vy = y - sy * f.w, vz = dz > 0 ? z - sz * f.d : 0;
      fd = Math.hypot(vx, vy, vz) || 1e-9;
      fn = [vx / fd, vy / fd, vz / fd];
    } else if ((dr > 0 || dy > 0) && dz > 0) {
      // beyond an end (round the spin): radius / across and along the axis are square to each other
      const a = Math.max(dr, dy);
      fd = Math.hypot(a, dz);
      const na: Vec3 = dr > dy ? [sr * rx, sr * ry, 0] : [0, sy, 0];
      fn = [(a * na[0]) / fd, (a * na[1]) / fd, (dz * sz) / fd];
    } else {
      // over, under or beside it (one distance positive), or inside (the nearest face)
      fd = dr; fn = [sr * rx, sr * ry, 0];
      if (dy > fd) { fd = dy; fn = [0, sy, 0]; }
      if (dz > fd) { fd = dz; fn = [0, 0, sz]; }
    }
    if (fd >= d) continue;
    for (const h of f.holes) {
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
  if (T.walls) {
    // a slab beyond |y| = w, |x| <= x (both arms: folded, x >= 0), |z| <= d: a box
    const W = T.walls, th = 0.5;
    const qx = x - W.x, qy = Math.abs(Math.abs(y) - (W.w + th / 2)) - th / 2, qz = Math.abs(z) - W.d;
    let wd: number, wn: Vec3;
    if (qx > 0 || qy > 0 || qz > 0) {
      const ux = Math.max(qx, 0), uy = Math.max(qy, 0), uz = Math.max(qz, 0);
      wd = Math.hypot(ux, uy, uz);
      wn = [ux / wd, (uy / wd) * Math.sign(Math.abs(y) - (W.w + th / 2)) * (Math.sign(y) || 1), (uz / wd) * (Math.sign(z) || 1)];
    } else {
      wd = Math.max(qx, qy, qz);
      wn = wd === qx ? [1, 0, 0] : wd === qy ? [0, (Math.sign(Math.abs(y) - (W.w + th / 2)) || 1) * (Math.sign(y) || 1), 0] : [0, 0, Math.sign(z) || 1];
    }
    if (wd < d) { d = wd; n = wn; }
  }
  if (n) { out.d = d; out.n = flip ? [-n[0], -n[1], n[2]] : n; }
}

/** Radius of the floor under a point (the nearest one out from it that's under it), or R + 50 if none. */
export function towerFloorBelow(T: Tower, cfg: SimConfig, p: Vec3): number {
  const y = p[0] < 0 ? -p[1] : p[1], z = p[2];
  const rho = Math.hypot(p[0], p[1]);
  let best = cfg.R + 50;
  for (const f of T.floors) {
    if (f.r < rho - 0.5 || f.r >= best || Math.abs(y) > f.w || Math.abs(z) > f.d) continue;
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

interface Rect { y: number; z: number; hy: number; hz: number }

export function generateTower(cfg: SimConfig, rng: { rng: number }, withObstacles: boolean, nextId: () => number): Level {
  const R = cfg.R;
  const { floors, storeys } = towerLayout(cfg);
  const N = floors.length - 1;
  // straight walls across the middle, from the edges of one hub floor to the other's
  const hubF = floors[N];
  const T: Tower = { floors, walls: { w: hubF.w, x: Math.sqrt(hubF.r * hubF.r - hubF.w * hubF.w), d: hubF.d }, ramps: [] };
  const boxes: Box[] = [];
  const pads: Pad[] = [];
  const pickupSpots: { pos: Vec3; item: ItemKind }[] = [];
  const spawns: SpawnPoint[] = [];
  /** What's already on each floor (footprints in (y, z)), to keep things apart. */
  const used: Rect[][] = floors.map(() => []);
  const clear = (fi: number, y: number, z: number, hy: number, hz: number, m = 1) => {
    const f = floors[fi];
    if (Math.abs(y) + hy > f.w - 0.6 || Math.abs(z) + hz > f.d - 0.6) return false;
    return used[fi].every((h) => Math.abs(y - h.y) > hy + h.hy + m || Math.abs(z - h.z) > hz + h.hz + m);
  };
  const rot = (v: Vec3, arm: 0 | 1): Vec3 => (arm ? [-v[0], -v[1], v[2]] : v);

  /** A box standing on floor fi at (y, z) (`lift` up off it), in the radial frame there; in both arms. */
  const stand = (fi: number, y: number, z: number, ht: number, hu: number, hz: number, kind: Box['kind'] = 'cover', mark = true) => {
    const r = floors[fi].r;
    for (const arm of [0, 1] as const) {
      const c = towerPoint(r - hu + 0.1, y, z, arm);
      boxes.push({ id: nextId(), type: 'box', kind, angle: Math.atan2(c[1], c[0]), tilt: 0, center: c, half: [ht, hu + 0.1, hz] });
    }
    if (mark) used[fi].push({ y, z, hy: ht, hz });
  };

  /**
   * A ramp from floor k up to floor k + 1, along a path in (angle, z) while
   * climbing evenly: in a few flat pieces, each tilted to the "up" (radial)
   * where it is, so it never leans across. A landing at the top, beside the floor above, with a rail across its end.
   */
  const ramp = (k: number, a0: number, z0: number, a1: number, z1: number) => {
    const r0 = floors[k].r, r1 = floors[k + 1].r, segs = a0 === a1 ? 1 : 6;
    T.ramps!.push({ k, a0, z0, a1, z1 });
    const pts: Vec3[] = [];
    for (let i = 0; i <= segs; i++) {
      const s = i / segs, r = r0 + (r1 - r0) * s, a = a0 + (a1 - a0) * s;
      pts.push([r * Math.cos(a), r * Math.sin(a), z0 + (z1 - z0) * s]);
    }
    for (let i = 0; i < segs; i++) {
      const A = pts[i], B = pts[i + 1];
      const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
      const len = Math.hypot(dx, dy, dz);
      const X: Vec3 = [dx / len, dy / len, dz / len];
      const mid: Vec3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
      const mr = Math.hypot(mid[0], mid[1]);
      const u: Vec3 = [-mid[0] / mr, -mid[1] / mr, 0]; // up (toward the axis) here
      const ux = u[0] * X[0] + u[1] * X[1];
      const N0: Vec3 = [u[0] - ux * X[0], u[1] - ux * X[1], -ux * X[2]];
      const nl = Math.hypot(...N0);
      const Nn: Vec3 = [N0[0] / nl, N0[1] / nl, N0[2] / nl];
      const Z: Vec3 = [X[1] * Nn[2] - X[2] * Nn[1], X[2] * Nn[0] - X[0] * Nn[2], X[0] * Nn[1] - X[1] * Nn[0]];
      const hy = 0.35;
      const c: Vec3 = [mid[0] - Nn[0] * hy, mid[1] - Nn[1] * hy, mid[2] - Nn[2] * hy];
      for (const arm of [0, 1] as const) {
        const cc = rot(c, arm);
        boxes.push({ id: nextId(), type: 'box', kind: 'ramp', angle: Math.atan2(cc[1], cc[0]), tilt: 0, center: cc, half: [len / 2 + (segs > 1 ? 0.12 : 0), hy, RAMP_W / 2], axes: [rot(X, arm), rot(Nn, arm), rot(Z, arm)] });
      }
    }
    // the landing at the top (level with the floor beside it), and a rail across its far end
    const along = a0 === a1; // (along the axis)
    const da = Math.sign(a1 - a0) / r1, dzs = Math.sign(z1 - z0);
    const at = (s: number, rc: number): Vec3 => { const a = along ? a1 : a1 + da * s, z = along ? z1 + dzs * s : z1; return [rc * Math.cos(a), rc * Math.sin(a), z]; };
    for (const arm of [0, 1] as const) {
      const lc = rot(at(LAND / 2, r1 + 0.35), arm);
      boxes.push({ id: nextId(), type: 'box', kind: 'ramp', angle: Math.atan2(lc[1], lc[0]), tilt: 0, center: lc, half: along ? [RAMP_W / 2, 0.35, LAND / 2] : [LAND / 2, 0.35, RAMP_W / 2] });
      const rc = rot(at(LAND - 0.25, r1 - 0.5), arm);
      boxes.push({ id: nextId(), type: 'box', kind: 'wall', angle: Math.atan2(rc[1], rc[0]), tilt: 0, center: rc, half: along ? [RAMP_W / 2, 0.55, 0.25] : [0.25, 0.55, RAMP_W / 2] });
    }
    const ys = [r0 * Math.sin(a0), r0 * Math.sin(a1), r1 * Math.sin(a0), r1 * Math.sin(a1)];
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    used[k].push({ y: (yLo + yHi) / 2, z: (z0 + z1) / 2, hy: (yHi - yLo) / 2 + (a0 === a1 ? RAMP_W / 2 : 1.5), hz: Math.abs(z1 - z0) / 2 + (z0 === z1 ? RAMP_W / 2 : 1.5) });
  };

  // Ramps: two per storey, on opposite sides of the floor above, climbing opposite ways.
  /** Where each floor's edge has a ramp arriving (keep the parapet open there), per floor: [edge, from, to]. */
  const arrivals: { edge: '+y' | '-y' | '+z' | '-z'; a: number; b: number }[][] = floors.map(() => []);
  for (let k = 0; k < N; k++) {
    const st = storeys[k], up = floors[k + 1], L = st.len;
    for (const sg of [1, -1]) {
      if (st.along === 'y') {
        const z = sg * (up.d + RAMP_W / 2 - 0.02), ha = st.halfAngle;
        ramp(k, -sg * ha, z, sg * ha, z);
        const yTop = sg * up.r * Math.sin(ha), run = 0.45 * L;
        arrivals[k + 1].push({ edge: sg > 0 ? '+z' : '-z', a: Math.min(yTop + sg * LAND, yTop - sg * run), b: Math.max(yTop + sg * LAND, yTop - sg * run) });
      } else {
        ramp(k, sg * st.phi, -sg * L / 2, sg * st.phi, sg * L / 2);
        arrivals[k + 1].push({ edge: sg > 0 ? '+y' : '-y', a: sg > 0 ? L / 2 - 0.45 * L : -L / 2 - LAND, b: sg > 0 ? L / 2 + LAND : -L / 2 + 0.45 * L });
      }
    }
  }

  // Columns at the corners (and along long edges) of each floor, down to the one below.
  for (let k = 1; k <= N; k++) {
    const f = floors[k], below = floors[k - 1];
    const top = f.r + f.thickness, bottom = below.r, hh = (bottom - top) / 2;
    const ys = f.w > 20 ? [-(f.w - 0.8), 0, f.w - 0.8] : [-(f.w - 0.8), f.w - 0.8];
    const zs = f.d > 20 ? [-(f.d - 0.8), 0, f.d - 0.8] : [-(f.d - 0.8), f.d - 0.8];
    for (const y of ys) for (const z of zs) {
      if (Math.abs(y) < f.w - 1 && Math.abs(z) < f.d - 1) continue; // only round the edges
      for (const arm of [0, 1] as const) {
        const c = towerPoint(top + hh, y, z, arm);
        boxes.push({ id: nextId(), type: 'box', kind: 'struct', angle: Math.atan2(c[1], c[0]), tilt: 0, center: c, half: [0.5, hh + 0.05, 0.5] });
      }
      used[k - 1].push({ y, z, hy: 0.5, hz: 0.5 });
    }
  }

  // Parapets round each floor's edge: waist high, with gaps where there's a floor to land on below, and open where a ramp arrives.
  for (let k = 0; k <= N; k++) {
    const f = floors[k];
    // gaps only where a bigger floor below would catch you (never round the bottom floor: off there is space)
    const below = floors[k - 1];
    const gapAt = (edge: string) => (!below ? 0 : (edge[1] === 'y' ? below.w - f.w : below.d - f.d) >= 5 ? 0.35 : 0);
    const open = (edge: string, s: number) => arrivals[k].some((a) => a.edge === edge && s > a.a - 1 && s < a.b + 1);
    const run = (edge: '+y' | '-y' | '+z' | '-z', len: number) => {
      const gapChance = gapAt(edge);
      const nSeg = Math.max(2, Math.round((2 * len) / 4));
      const segL = (2 * len) / nSeg;
      for (let i = 0; i < nSeg; i++) {
        const s = -len + (i + 0.5) * segL;
        if (open(edge, s) || rngNext(rng) < gapChance) continue;
        const sg = edge[0] === '+' ? 1 : -1;
        if (edge[1] === 'y') {
          // (straight along the axis: join it up with the following pieces)
          let j = i;
          while (j + 1 < nSeg && !open(edge, -len + (j + 1.5) * segL) && rngNext(rng) >= gapChance) j++;
          const zc = -len + ((i + j + 1) / 2) * segL;
          stand(k, sg * (f.w - 0.25), zc, 0.25, 0.55, ((j - i + 1) * segL) / 2 - 0.05, 'wall', false);
          i = j;
        } else stand(k, s, sg * (f.d - 0.25), segL / 2 - 0.05, 0.55, 0.25, 'wall', false);
      }
    };
    if (k < N) { run('+y', f.d); run('-y', f.d); } // (the hub floor's sides open onto the middle walls)
    run('+z', f.w); run('-z', f.w);
  }

  // The hub floor: launch pads that throw you across the axis onto the other arm's hub floor.
  // Coriolis bends the path round, so they throw you well antispinward of straight up
  // (tuned by test: about 3 s across, landing near the middle of the far floor).
  const hub = floors[N];
  const padSpeed = 2.05 * Math.sqrt(cfg.g / R) * hub.r, padTilt = 0.9;
  for (const z of [-hub.d / 2, hub.d / 2]) {
    for (const arm of [0, 1] as const) {
      const pos = towerPoint(hub.r, 0, z, arm);
      const up: Vec3 = rot([-1, 0, 0], arm), spin: Vec3 = rot([0, 1, 0], arm);
      const ct = Math.cos(padTilt), st = Math.sin(padTilt);
      pads.push({ pos, up: [up[0] * ct - spin[0] * st, up[1] * ct - spin[1] * st, 0], speed: padSpeed, exact: true });
    }
    used[N].push({ y: 0, z, hy: 1.5, hz: 1.5 });
  }

  /** A random clear spot on floor fi, or null. */
  const spot = (fi: number, hy: number, hz: number, m = 1): [number, number] | null => {
    const f = floors[fi];
    for (let i = 0; i < 30; i++) {
      const y = (rngNext(rng) * 2 - 1) * (f.w - hy - 1), z = (rngNext(rng) * 2 - 1) * (f.d - hz - 1);
      if (clear(fi, y, z, hy, hz, m)) return [y, z];
    }
    return null;
  };

  // Spawn points: on the bottom floor of each arm, and two floors up (so not everyone starts at the bottom).
  for (const [fi, count] of [[0, 4], [2, 1]] as const) {
    for (let i = 0; i < count; i++) {
      const at = spot(fi, 1.5, 1.5, 1.5);
      if (!at) continue;
      used[fi].push({ y: at[0], z: at[1], hy: 1.5, hz: 1.5 });
      const r = floors[fi].r;
      for (const arm of [0, 1] as const) spawns.push({ angle: Math.asin(at[0] / r) + arm * Math.PI, z: at[1], ...(fi ? { floor: r } : {}) });
    }
  }

  if (withObstacles) {
    // cover on every floor below the hub, and something worth climbing for on each
    const items: ItemKind[] = ['health', 'sticky', 'scatter', 'rocket', 'launcher', 'jetpack'];
    for (let fi = 0; fi < N; fi++) {
      const f = floors[fi];
      const count = Math.max(3, Math.min(10, Math.round((f.w * f.d) / 120)));
      for (let i = 0; i < count; i++) {
        const tall = rngNext(rng) < 0.35;
        const ht = tall ? 1 : 1.2 + rngNext(rng), hz = tall ? 1 : 1.5 + rngNext(rng);
        const at = spot(fi, ht, hz, 1.5);
        if (!at) continue;
        stand(fi, at[0], at[1], ht, tall ? 1.6 : 0.6, hz, tall ? 'struct' : 'cover');
      }
      const at = spot(fi, 0.8, 0.8);
      if (at) {
        for (const arm of [0, 1] as const) pickupSpots.push({ pos: towerPoint(f.r - 1, at[0], at[1], arm), item: items[fi % items.length] });
        used[fi].push({ y: at[0], z: at[1], hy: 0.8, hz: 0.8 });
      }
    }
    // prizes floating at the axis, where you weigh nothing
    pickupSpots.push({ pos: [0, 0, 0], item: 'cannon' }, { pos: [0, 0, -hub.d / 2], item: 'chaos' }, { pos: [0, 0, hub.d / 2], item: 'seeker' });
  }
  return { shape: 'tower', terrain: null, tower: T, boxes, stairTops: [], spawns, pickupSpots, vehicleSpots: [], wallPos: [], wallNeg: [], pads };
}

/**
 * Where to head next, in a tower, on the way from `pos` to `goal` (for bots):
 * up the ramps toward the hub, across on a launch pad, down the ramps on the
 * other side; or straight there if it's on the same floor.
 */
export function towerWaypoint(level: Level, pos: Vec3, goal: Vec3, standH: number): Vec3 {
  const T = level.tower!;
  const ramps = T.ramps ?? [];
  const armOf = (p: Vec3): 0 | 1 => (p[0] >= 0 ? 0 : 1);
  const fold = (p: Vec3): Vec3 => (p[0] >= 0 ? p : [-p[0], -p[1], p[2]]);
  const unfold = (p: Vec3, arm: 0 | 1): Vec3 => (arm ? [-p[0], -p[1], p[2]] : p);
  /** Which floor a point is standing on (by radius), or -1 in between. */
  const floorOf = (p: Vec3, h: number) => {
    const rho = Math.hypot(p[0], p[1]) + h;
    return T.floors.findIndex((f) => Math.abs(f.r - rho) < 2);
  };
  const N = T.floors.length - 1;
  const arm = armOf(pos), q = fold(pos);
  const rho = Math.hypot(q[0], q[1]), ang = Math.atan2(q[1], q[0]);
  type Ramp = (typeof ramps)[number];
  const isAlong = (rp: Ramp) => Math.abs(rp.a1 - rp.a0) < 1e-9; // (along the axis, at one angle)
  /** A point on the ramp's centre line at parameter s (0 bottom, 1 top), `off` metres to one side, standing height over it (level with the floor past its ends). */
  const at = (rp: Ramp, s: number, off = 0): Vec3 => {
    const r = T.floors[rp.k].r + (T.floors[rp.k + 1].r - T.floors[rp.k].r) * Math.min(1, Math.max(0, s)) - standH;
    let a = rp.a0 + (rp.a1 - rp.a0) * s, z = rp.z0 + (rp.z1 - rp.z0) * s;
    if (isAlong(rp)) a += off / r; else z += off;
    return unfold([r * Math.cos(a), r * Math.sin(a), z], arm);
  };
  /** Where we are relative to a ramp: how far along, how far to the side (signed), and its surface radius there. */
  const rel = (rp: Ramp) => {
    const span = isAlong(rp) ? (q[2] - rp.z0) / (rp.z1 - rp.z0) : (ang - rp.a0) / (rp.a1 - rp.a0);
    const side = isAlong(rp) ? (ang - rp.a0) * rho : q[2] - rp.z0;
    const surf = T.floors[rp.k].r + (T.floors[rp.k + 1].r - T.floors[rp.k].r) * Math.min(1, Math.max(0, span)) - standH;
    return { span, side, surf };
  };
  /** Just past its low end (3 m: the floor reaches a bit further than that). */
  const footS = (rp: Ramp) => -3 / (isAlong(rp) ? Math.abs(rp.z1 - rp.z0) : Math.abs(rp.a1 - rp.a0) * 0.5 * (T.floors[rp.k].r + T.floors[rp.k + 1].r));
  const inward = (rp: Ramp) => (isAlong(rp) ? -Math.sign(rp.a0) : -Math.sign(rp.z0)); // toward the floor above's middle
  const goalFloor = armOf(goal) === arm ? floorOf(goal, 0.5) : -2; // (-2: the other arm)
  const mine = floorOf(pos, standH);
  const goingUp = goalFloor === -2 || goalFloor > mine;
  for (const rp of ramps) {
    if (rho > T.floors[rp.k].r + 0.5 || rho < T.floors[rp.k + 1].r - standH - 1.5) continue; // (not between its floors)
    const { span, side, surf } = rel(rp);
    if (span < -0.4 || span > 1.3) continue;
    // on it (level with its surface, within its width): keep going the way we're headed
    if (Math.abs(side) < 2.7 && Math.abs(surf - rho) < 1 && span > -0.05 && span < 1.2) {
      const up = goalFloor === -2 || goalFloor > rp.k;
      if (up && span < 1.1) return span > 0.9 ? at(rp, 1.05, inward(rp) * 3.6) : at(rp, span + 0.3); // at the top: step across onto the floor
      if (!up && span > 0.05) return at(rp, Math.max(-0.3, span - 0.3));
      continue;
    }
    // underneath it: straight out sideways, toward whichever side is nearer
    if (Math.abs(side) < 2.7 && rho > surf + 1 && span > -0.05 && span < 1) return at(rp, span, (Math.sign(side) || 1) * 3.6);
    // the one we want to climb, and we're beside its low part: along beside it, past its low end, then onto it
    if (goingUp && mine === rp.k && Math.abs(side) < 4.5 && span > -0.05 && span < 1) return at(rp, footS(rp), (Math.sign(side) || 1) * 3.6);
  }
  if (mine < 0) return goal; // (in the air: nothing to decide)
  if (goalFloor === mine) return goal;
  if (goalFloor === -2 && mine === N) {
    // the hub: onto a launch pad, which throws us across
    let best = goal, bd = Infinity;
    for (const pd of level.pads ?? []) if (armOf(pd.pos) === arm) { const d = Math.hypot(pd.pos[0] - pos[0], pd.pos[1] - pos[1], pd.pos[2] - pos[2]); if (d < bd) { bd = d; best = pd.pos; } }
    return best;
  }
  // the nearest ramp leaving this floor the right way: (up) its foot, from beyond its low end;
  // (down) the floor beside its landing, then the landing
  let best: Vec3 | null = null, bd = Infinity;
  for (const rp of ramps) {
    if (goingUp ? rp.k !== mine : rp.k !== mine - 1) continue;
    let p = goingUp ? at(rp, footS(rp)) : at(rp, 1.05, inward(rp) * 3.6);
    const d = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
    if (!goingUp && d < 1.5) p = at(rp, 1.05); // beside the landing: onto it
    if (goingUp && d < 2.5) p = at(rp, 0.2); // at its foot: up it
    if (d < bd) { bd = d; best = p; }
  }
  return best ?? goal;
}
