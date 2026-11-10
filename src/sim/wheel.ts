// The Wheel Station: a ring with hollow spokes up to a hub round the axis,
// the classic space station. The hub is a drum: you walk round the inside of
// it at a tenth of the rim's gravity. Each spoke has a lift (they take turns),
// and the shafts are just the right size to climb with a grappling hook.

import { rngNext } from './rng';
import type { Box, ItemKind, Level, SimConfig } from './types';
import type { Vec3 } from './vec';

export interface Hub { r: number; halfLen: number; thickness: number; spokes: { angle: number; w: number; d: number }[] }

const WALL = 0.5; // spoke wall thickness
const DOOR = 3.5; // the spokes' walls stop this far above the floor: open all round at the bottom

/** Add the hub and spokes to a generated ring level (in place). */
export function addWheel(cfg: SimConfig, level: Level, rng: { rng: number }, nextId: () => number) {
  const R = cfg.R, rh = cfg.wheelHub, n = Math.max(2, cfg.wheelSpokes);
  const w = 3, d = 3; // the shafts: 6 x 6 m inside
  const hub: Hub = { r: rh, halfLen: Math.min(cfg.halfWidth, 16), thickness: 1, spokes: [] };
  const boxes: Box[] = [];
  /** A box in a spoke's own frame: x round the spin, y up (toward the axis), z along it; centred at radius rc. */
  const inSpoke = (a: number, x: number, rc: number, z: number, hx: number, hy: number, hz: number, kind: Box['kind']) => {
    const c = Math.cos(a), s = Math.sin(a);
    const X: Vec3 = [-s, c, 0], Y: Vec3 = [-c, -s, 0], Z: Vec3 = [0, 0, 1];
    const center: Vec3 = [c * rc + X[0] * x, s * rc + X[1] * x, z];
    boxes.push({ id: nextId(), type: 'box', kind, angle: a, tilt: 0, center, half: [hx, hy, hz], axes: [X, Y, Z] });
  };
  const bottom = R - DOOR, top = rh + hub.thickness; // the walls run from just above the floor up into the hub's shell
  const mid = (bottom + top) / 2, half = (bottom - top) / 2;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.25) / n) * 2 * Math.PI; // (clear of the spawn points at whole eighths)
    hub.spokes.push({ angle: a, w, d });
    // the shaft: four walls
    for (const sx of [-1, 1]) inSpoke(a, sx * (w + WALL / 2), mid, 0, WALL / 2, half, d + WALL, 'struct');
    for (const sz of [-1, 1]) inSpoke(a, 0, mid, sz * (d + WALL / 2), w, half, WALL / 2, 'struct');
    // a lift: from the floor up to the hub, its top level with the hub's floor when it gets there (staggered, so one's always on its way)
    const th = 0.2, c = Math.cos(a), sn = Math.sin(a), rb = R - th;
    const base: Vec3 = [c * rb, sn * rb, 0];
    const travel = rb - (rh + th);
    boxes.push({ id: nextId(), type: 'box', kind: 'lift', angle: a, tilt: 0, center: [...base] as Vec3, half: [w - 0.3, th, d - 0.3], lift: { base, travel, period: Math.max(24, (4 * travel) / 10), phase: i / n } });
  }
  // clear anything on the floor where the spokes come down, and any lookout cut by them
  const near = (p: Vec3, m: number) => hub.spokes.some((sp) => {
    const c = Math.cos(sp.angle), s = Math.sin(sp.angle);
    const along = Math.abs(-s * p[0] + c * p[1]), across = Math.abs(p[2]);
    return c * p[0] + s * p[1] > rh && along < w + m && across < d + m;
  });
  level.boxes = level.boxes.filter((b) => b.kind === 'wall' || !near(b.center, 4 + Math.max(b.half[0], b.half[2])));
  level.pickupSpots = level.pickupSpots.filter((sp) => !near(sp.pos, 3));
  level.vehicleSpots = level.vehicleSpots.filter((sp) => !near(sp.pos, 4));
  level.boxes.push(...boxes);
  // prizes in the hub (on its floor, between the spokes), and some cover up there
  const items: ItemKind[] = ['cannon', 'jetpack', 'rocket', 'laconic'];
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.75) / n) * 2 * Math.PI, r = rh - 1;
    level.pickupSpots.push({ pos: [r * Math.cos(a), r * Math.sin(a), 0], item: items[i % items.length] });
    const ac = a + (rngNext(rng) - 0.5) * 0.3, rc = rh - 0.6, z = (rngNext(rng) < 0.5 ? -1 : 1) * hub.halfLen * 0.55;
    level.boxes.push({ id: nextId(), type: 'box', kind: 'cover', angle: ac, tilt: 0, center: [rc * Math.cos(ac), rc * Math.sin(ac), z], half: [1.2, 0.7, 1.6] });
  }
  level.hub = hub;
}
