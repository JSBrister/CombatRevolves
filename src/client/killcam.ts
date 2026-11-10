// The kill cam: when you're killed, the last couple of seconds again, seen
// from the stars (a camera that doesn't turn with the station). From there
// the shot that got you flew dead straight, and the station turned under it.
//
// It records what was on screen every tick (players, projectiles,
// explosions), so it works the same in a network game; it never touches the
// simulation, which carries on (you respawn as usual while it plays).

import { DT, localBasis, type SimState, type Vec3 } from '../sim';

interface Frame { tick: number; frameAngle: number; players: SimState['players']; bolts: SimState['bolts']; grenades: SimState['grenades']; explosions: SimState['explosions'] }

const KEEP_S = 3.5; // what's remembered
const BEFORE_S = 2.2; // how far back the replay starts
const AFTER_S = 0.35; // and how long after the death it runs on

const copyBody = <T extends { pos: Vec3; vel: Vec3 }>(x: T): T => ({ ...x, pos: [x.pos[0], x.pos[1], x.pos[2]] as Vec3, vel: [x.vel[0], x.vel[1], x.vel[2]] as Vec3 });

export class KillCam {
  enabled = true;
  private frames: Frame[] = [];
  private pending: { deathTick: number; victim: number; killer: number } | null = null;
  private play: { frames: Frame[]; t: number; center: Vec3; offset: Vec3; up: Vec3; fa0: number; killer: number } | null = null;

  constructor() {
    try { this.enabled = localStorage.getItem('cr-killcam') !== 'off'; } catch { /* default on */ }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try { localStorage.setItem('cr-killcam', on ? 'on' : 'off'); } catch { /* not remembered */ }
    if (!on) this.stop();
  }

  /** Forget everything (a new level or match). */
  clear() { this.frames = []; this.pending = null; this.play = null; }

  stop() { this.play = null; this.pending = null; }

  get active() { return this.play !== null; }

  /** Once a tick: remember what's on screen. */
  record(s: SimState) {
    this.frames.push({
      tick: s.tick, frameAngle: s.frameAngle,
      players: s.players.map(copyBody), bolts: s.bolts.map(copyBody), grenades: s.grenades.map(copyBody), explosions: s.explosions.map((e) => ({ ...e })),
    });
    const keep = Math.round(KEEP_S / DT);
    if (this.frames.length > keep) this.frames.splice(0, this.frames.length - keep);
    // a death waiting for its aftermath to be recorded
    if (this.pending && s.tick >= this.pending.deathTick + Math.round(AFTER_S / DT)) this.begin();
  }

  /** You were killed (at the tick of the latest recorded frame). */
  onDeath(victim: number, killer: number) {
    if (!this.enabled || this.play) return;
    const last = this.frames[this.frames.length - 1];
    if (!last) return;
    this.pending = { deathTick: last.tick, victim, killer };
  }

  private begin() {
    const pd = this.pending!;
    this.pending = null;
    const from = pd.deathTick - Math.round(BEFORE_S / DT);
    const frames = this.frames.filter((f) => f.tick >= from);
    const death = frames.find((f) => f.tick >= pd.deathTick) ?? frames[frames.length - 1];
    if (!death || frames.length < 10) return;
    // frame the shot: between the victim and the killer (or, a fall or a suicide, where you were a moment before)
    const victim = death.players.find((p) => p.id === pd.victim) ?? frames[0].players.find((p) => p.id === pd.victim);
    if (!victim) return;
    const killer = pd.killer !== pd.victim ? death.players.find((p) => p.id === pd.killer) : undefined;
    const earlier = frames[0].players.find((p) => p.id === pd.victim);
    const a = victim.pos, b = killer?.pos ?? earlier?.pos ?? victim.pos;
    const center: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const span = Math.max(8, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    const up = localBasis(center).up;
    // off to one side along the axis, and up a little: side-on to the shot
    const offset: Vec3 = [up[0] * (0.3 * span + 3), up[1] * (0.3 * span + 3), up[2] * (0.3 * span + 3) + (center[2] > 0 ? -1 : 1) * (0.9 * span + 6)];
    this.play = { frames, t: 0, center, offset, up, fa0: death.frameAngle, killer: pd.killer };
  }

  /**
   * This frame of the replay (advanced by dt seconds of real time): the state
   * to draw, and the camera (fixed to the stars: it turns backward with the
   * station's spin). Null once it's over.
   */
  next(dt: number, base: SimState): { state: SimState; eye: Vec3; target: Vec3; up: Vec3; frameAngle: number; killer: number; progress: number } | null {
    const pl = this.play;
    if (!pl) return null;
    pl.t += dt;
    const i = Math.min(pl.frames.length - 1, Math.floor(pl.t / DT));
    if (pl.t / DT >= pl.frames.length) { this.play = null; return null; }
    const f = pl.frames[i];
    // the station has turned by (fa - fa0) since the death: a camera fixed to the stars turns back by that much in the station's frame
    const d = -(f.frameAngle - pl.fa0), c = Math.cos(d), s = Math.sin(d);
    const rot = (v: Vec3): Vec3 => [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
    const target = rot(pl.center);
    const eye = rot([pl.center[0] + pl.offset[0], pl.center[1] + pl.offset[1], pl.center[2] + pl.offset[2]]);
    const state: SimState = { ...base, tick: f.tick, frameAngle: f.frameAngle, players: f.players, bolts: f.bolts, grenades: f.grenades, explosions: f.explosions };
    return { state, eye, target, up: rot(pl.up), frameAngle: f.frameAngle, killer: pl.killer, progress: i / (pl.frames.length - 1) };
  }
}
