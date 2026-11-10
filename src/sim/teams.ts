// Teams: colours, and "team bases": each team gets a home on the level,
// where its players spawn, with a flag stand (for capture the flag, later),
// and the pickups are made symmetric between the teams' sides so neither
// side is better off.
//
// Most levels are the same all the way round the spin axis, so N teams get
// N equal sectors, one turned into the next. Twin rings (one ring each) and
// the Spin Tower (one arm each) are made for two teams.

import { spawnPosition } from './level';
import { towerPoint } from './tower';
import type { Level, SimConfig, SpawnPoint, TeamBase } from './types';
import type { Vec3 } from './vec';

export const TEAM_COLORS = [0x3d7bd9, 0xd2553a, 0xe0c040, 0xa050d0];
export const TEAM_NAMES = ['Blue', 'Red', 'Gold', 'Violet'];

/** How many teams this level can give bases to (0: none). */
export function maxTeamBases(cfg: SimConfig): number {
  if (!cfg.spin) return 0; // (Earth: a strip, not the same all round)
  if (cfg.R < 40) return 0; // (no room on a tiny ring)
  if (cfg.arena > 0) return 2; // (a stretch of ring, sealed at the ends: a base at each end)
  if (cfg.twin || cfg.tower > 0) return 2;
  if (cfg.world === 'planet' && cfg.planetSpin > 1) return 0; // (only the poles hold you: no room for bases)
  return 4;
}

const rotZ = (p: Vec3, a: number): Vec3 => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
};

/** Give each of cfg.teams teams a base, and make the pickups the same on every team's side. */
export function applyTeamBases(cfg: SimConfig, level: Level) {
  const n = cfg.teams;
  if (n < 2 || !cfg.teamBases || n > maxTeamBases(cfg)) return;
  const bases: TeamBase[] = [];
  const R = cfg.R;
  if (cfg.arena > 0) {
    // a sealed stretch of ring: a base at each end (team 0 at the antispinward end), the pickups mirrored end to end
    for (let t = 0; t < 2; t++) {
      const a = (t ? 1 : -1) * Math.max(0, cfg.arena / 2 - 14) / R;
      const spawns: SpawnPoint[] = [[-6, -4], [-6, 4], [6, -4], [6, 4]].map(([s, dz]) => ({ angle: a + s / R, z: dz }));
      bases.push({ team: t, pos: spawnPosition(cfg, { angle: a, z: 0 }, 0, level), spawns });
    }
    level.pickupSpots = level.pickupSpots.filter((s) => Math.atan2(s.pos[1], s.pos[0]) < -0.02);
    level.pickupSpots.push(...level.pickupSpots.map((s) => ({ item: s.item, pos: [s.pos[0], -s.pos[1], s.pos[2]] as Vec3 })));
  } else if (cfg.twin) {
    // one ring each: ring A (z < 0) is team 0, ring B (z > 0) team 1, in its own frame.
    // Ring B is ring A mirrored (and turning the other way): (x, y, z) -> (x, -y, -z).
    const hw = cfg.halfWidth;
    for (let t = 0; t < 2; t++) {
      const sz = t ? 1 : -1, zc = sz * hw / 2;
      const spawns: SpawnPoint[] = [[-8, -4], [-8, 4], [8, -4], [8, 4]].map(([s, dz]) => ({ angle: s / R, z: zc + dz }));
      bases.push({ team: t, pos: spawnPosition(cfg, { angle: 0, z: zc }, 0, level), spawns });
    }
    level.pickupSpots = level.pickupSpots.filter((s) => s.pos[2] < 0);
    level.pickupSpots.push(...level.pickupSpots.map((s) => ({ item: s.item, pos: [s.pos[0], -s.pos[1], -s.pos[2]] as Vec3 })));
  } else if (cfg.tower > 0) {
    // one arm each (already the same, half a turn apart): the middle of each bottom floor
    for (let t = 0; t < 2; t++) {
      const spawns: SpawnPoint[] = [[-8, -4], [-8, 4], [8, -4], [8, 4]].map(([y, z]) => ({ angle: Math.asin(y / R) + t * Math.PI, z }));
      bases.push({ team: t, pos: towerPoint(R, 0, 0, t as 0 | 1), spawns });
    }
  } else {
    // N equal sectors round the axis; team k's home is at angle 2 pi k / N
    const sector = (2 * Math.PI) / n;
    const disk = cfg.world === 'disk', planet = cfg.world === 'planet';
    for (let t = 0; t < n; t++) {
      const a = t * sector;
      // (spawn points: on a ring, (angle, z across); on a planet, (longitude, metres north); on a disk, (angle, distance out))
      const z0 = disk ? 0.6 * R : 0;
      const rr = planet ? R : disk ? z0 : R;
      const spawns: SpawnPoint[] = [[-8, -4], [-8, 4], [8, -4], [8, 4]].map(([s, dz]) => ({ angle: a + s / rr, z: z0 + dz }));
      bases.push({ team: t, pos: spawnPosition(cfg, { angle: a, z: z0 }, 0, level), spawns });
    }
    // keep the pickups in team 0's sector, and copy them into the others
    const mine = level.pickupSpots.filter((s) => {
      const a = Math.atan2(s.pos[1], s.pos[0]);
      return a >= -sector / 2 && a < sector / 2;
    });
    level.pickupSpots = [];
    for (let t = 0; t < n; t++) for (const s of mine) level.pickupSpots.push({ item: s.item, pos: rotZ(s.pos, t * sector) });
  }
  // clear loose cover off each base (crates, not structures)
  level.boxes = level.boxes.filter((b) => b.kind !== 'cover' || !bases.some((bs) => Math.hypot(b.center[0] - bs.pos[0], b.center[1] - bs.pos[1], b.center[2] - bs.pos[2]) < 12));
  level.bases = bases;
}

/**
 * Spin control's engine room: halfway between the two bases (round the
 * spin), on the ground; nothing loose left lying in it. Not for the twin
 * rings or the tower (their two halves aren't round the spin from each other).
 */
export function placeObjective(cfg: SimConfig, level: Level): { pos: Vec3; radius: number; holder: number } | null {
  const b = level.bases;
  if (!cfg.spinControl || !b || b.length !== 2 || cfg.twin || cfg.tower > 0) return null;
  const a0 = Math.atan2(b[0].pos[1], b[0].pos[0]), a1 = Math.atan2(b[1].pos[1], b[1].pos[0]);
  const gap = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  const a = a0 + gap / 2; // (opposite each other: a quarter turn on from team 0's)
  const z = b[0].spawns.reduce((n, s) => n + s.z, 0) / b[0].spawns.length; // (a disk's "z" is how far out)
  const pos = spawnPosition(cfg, { angle: a, z }, 0, level);
  const radius = 7;
  level.boxes = level.boxes.filter((x) => x.kind === 'wall' || x.kind === 'struct' || Math.hypot(x.center[0] - pos[0], x.center[1] - pos[1], x.center[2] - pos[2]) > radius + 3);
  level.pickupSpots = level.pickupSpots.filter((s) => Math.hypot(s.pos[0] - pos[0], s.pos[1] - pos[1], s.pos[2] - pos[2]) > radius);
  return { pos, radius, holder: -1 };
}
