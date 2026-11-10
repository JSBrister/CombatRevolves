// A client's side of a network match.
//
// Three things happen here, the usual three for a server-authoritative game:
//
//  1. Prediction. Your own player doesn't wait for the server. Every tick your
//     input goes to the server AND is applied at once to a small local world
//     (`pred`) holding just you, your shots and the bike you're riding, on
//     the real level, with the real physics.
//
//  2. Reconciliation. Every snapshot says which of your inputs the server has
//     used. The client rebuilds `pred` from the server's version of you and
//     replays the inputs the server hasn't seen yet. If the server agreed
//     with the prediction (it nearly always does: same code, same inputs),
//     nothing moves. If it didn't (someone shoved you, a grenade went off),
//     you end up where the server says, and the visible jump is smoothed away
//     over a tenth of a second.
//
//  3. Interpolation. Everyone and everything else is drawn in the past (about
//     100 ms back), blended between the two snapshots either side of that
//     moment, so they move smoothly however the snapshots arrive.
//
// Like the room, this knows nothing about sockets: it's given `send`.

import {
  DT, decode, encode, startLevel, step, syncLifts,
  type InputCmd, type Player, type SimEvent, type SimState, type Vec3,
} from '../sim';
import { applyDyn, decodeFrame, encodeControl, type Dyn, type MatchSpec, type NetInput, type ServerMsg } from './protocol';

export interface NetHooks {
  /** A (new) match has begun: `world` is built; rebuild the scene. */
  onMatch(client: NetClient): void;
  /** Something happened: from the server, or (predicted: true) from your own predicted actions, heard at once. */
  onEvent(e: SimEvent, predicted: boolean): void;
  /** A predicted projectile turned into the server's (same thing, new id): keep drawing it as one. */
  onRename?(from: number, to: number): void;
  onError?(text: string): void;
  now(): number; // ms
}

const PRED_ID_BASE = 1_000_000; // ids made while predicting: kept clear of the server's
const INTERP_SNAPSHOTS = 3; // how far in the past everyone else is drawn, in snapshot intervals
const SMOOTH_TIME = 0.1; // s: a correction's visible error fades over about this long
const SNAP_LIMIT = 3; // m: a correction bigger than this isn't smoothed (a respawn, a teleport)

const clone = <T,>(x: T): T => decode<T>(encode(x));
const lerp3 = (a: Vec3, b: Vec3, f: number): Vec3 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
const lerpAngle = (a: number, b: number, f: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * f;

export class NetClient {
  /** The server's latest word on everything (never stepped here). Null until a match begins. */
  world: SimState | null = null;
  /** The prediction world: you, your shots, your bike. Stepped every tick with your input. */
  pred: SimState | null = null;
  localId = -1;
  matchId = -1;
  spec: MatchSpec | null = null;
  snapEvery = 4;
  /** Diagnostics. */
  stats = { rtt: 0, corrections: 0, lastCorrection: 0, maxCorrection: 0, snapshots: 0, bytes: 0, queued: 0, pending: 0 };

  private seq = 0;
  private pending: { seq: number; cmd: NetInput }[] = [];
  private snaps: { tick: number; at: number; dyn: Dyn }[] = [];
  private tickOffset = NaN; // server tick - local time (in ticks), smoothed
  private prevMePos: Vec3 | null = null;
  private prevFrameAngle = 0;
  private smooth: Vec3 = [0, 0, 0];
  private lastPing = 0;

  constructor(private send: (bytes: Uint8Array) => void, private hooks: NetHooks) {}

  hello(name: string, color: number, team: number) {
    this.send(encodeControl({ t: 'hello', name, color, team }));
  }

  /** Ask the server to start a match (anyone may). */
  requestStart(spec: MatchSpec) {
    this.send(encodeControl({ t: 'start', spec }));
  }

  /** How fast the local clock should run so the server neither starves for our inputs nor piles them up (1 = real time). */
  get timeScale(): number {
    const q = this.stats.queued; // inputs the server had waiting: 2-3 is comfortable
    return q > 6 ? 0.97 : q > 4 ? 0.99 : q < 1 ? 1.02 : q < 2 ? 1.005 : 1;
  }

  receive(bytes: Uint8Array) {
    this.stats.bytes += bytes.length;
    const f = decodeFrame(bytes);
    if (f.kind === 'control') {
      const msg = f.msg as ServerMsg;
      if (msg.t === 'match') this.beginMatch(msg);
      else if (msg.t === 'pong') this.stats.rtt = this.hooks.now() - msg.c;
      else if (msg.t === 'error') this.hooks.onError?.(msg.text);
      return;
    }
    const snap = f.snap;
    if (!this.world || snap.matchId !== this.matchId) return; // (a straggler from the last match)
    this.stats.snapshots++;
    this.stats.queued = snap.queued;
    const now = this.hooks.now();
    // the server's clock, as ticks: follow it gently (snapshots arrive unevenly), jump only if we're well out
    const sample = snap.dyn.tick - (now / 1000) / DT;
    if (!(Math.abs(sample - this.tickOffset) < 60)) this.tickOffset = sample;
    else this.tickOffset += (sample - this.tickOffset) * 0.05;
    this.snaps.push({ tick: snap.dyn.tick, at: now, dyn: snap.dyn });
    if (this.snaps.length > 40) this.snaps.shift();
    applyDyn(this.world, snap.dyn);
    for (const e of snap.ev) if (!this.predictedHere(e)) this.hooks.onEvent(e, false);
    this.reconcile(snap.dyn, snap.ack);
  }

  private beginMatch(msg: Extract<ServerMsg, { t: 'match' }>) {
    this.spec = msg.spec;
    this.matchId = msg.matchId;
    this.localId = msg.id;
    this.snapEvery = msg.snapEvery;
    // the same level the server built: from the same description (no bots: the players come in snapshots)
    const teams = msg.spec.setup.teams ?? 0;
    const started = startLevel(msg.spec.def, {}, { ...msg.spec.setup, name: undefined, color: undefined, bots: teams >= 2 ? Array(teams).fill(0) : [0] });
    this.world = started.state;
    this.world.players = [];
    this.pred = null;
    this.pending = [];
    this.snaps = [];
    this.tickOffset = NaN;
    this.smooth = [0, 0, 0];
    this.prevMePos = null;
    this.hooks.onMatch(this);
  }

  /** Events your own prediction already produced (so the server's copy would be an echo). */
  private predictedHere(e: SimEvent): boolean {
    const me = this.localId;
    switch (e.type) {
      case 'fire': return e.owner === me;
      case 'impact': return e.owner === me && e.target < 0; // (hitting the level; hitting a player only the server knows)
      case 'melee': case 'jump': case 'reload': case 'overheat': case 'pad': return e.id === me;
      default: return false;
    }
  }

  /** Rebuild the prediction from the server's state and replay what it hasn't seen yet. */
  private reconcile(dyn: Dyn, ack: number) {
    const world = this.world!;
    this.pending = this.pending.filter((p) => p.seq > ack);
    const before = this.me();
    const oldPos = before ? [...before.pos] as Vec3 : null;
    const oldBolts = this.pred ? [...this.pred.bolts, ...this.pred.grenades].filter((b) => b.id >= PRED_ID_BASE).map((b) => ({ id: b.id, kind: (b as { kind?: string }).kind ?? 'g', pos: b.pos })) : [];
    const mine = dyn.players.find((p) => p.id === this.localId);
    if (!mine) { this.pred = null; return; }
    // you, your shots, the bike you're on: copies (the snapshot's own objects stay as the server sent them)
    const own = clone({
      players: [mine],
      bolts: dyn.bolts.filter((b) => b.owner === this.localId),
      grenades: dyn.grenades.filter((g) => g.owner === this.localId),
      vehicles: dyn.vehicles.filter((v) => v.id === mine.vehicle),
    });
    own.players[0].canRespawn = false; // (where you respawn is the server's call)
    this.pred = {
      ...world, ...own,
      props: [], explosions: [], pickups: [], flags: [], captures: [], events: [],
      tick: dyn.tick, frameAngle: dyn.frameAngle, rng: dyn.rng, nextId: Math.max(dyn.nextId, 0) + PRED_ID_BASE,
    };
    for (const p of this.pending) this.stepPred(p.cmd, false);
    syncLifts(this.pred);
    this.stats.pending = this.pending.length;
    // how far off was the prediction? (smoothed away on screen unless it's a real jump)
    const after = this.me();
    if (oldPos && after) {
      const err: Vec3 = [oldPos[0] - after.pos[0], oldPos[1] - after.pos[1], oldPos[2] - after.pos[2]];
      const mag = Math.hypot(...err);
      this.stats.lastCorrection = mag;
      if (mag > 1e-3) { this.stats.corrections++; this.stats.maxCorrection = Math.max(this.stats.maxCorrection, mag); }
      if (mag < SNAP_LIMIT && before!.alive && after.alive) this.smooth = [this.smooth[0] + err[0], this.smooth[1] + err[1], this.smooth[2] + err[2]];
      else { this.smooth = [0, 0, 0]; this.prevMePos = null; }
    }
    // shots you predicted that the server now has: the same thing under its real id
    if (this.hooks.onRename && oldBolts.length) {
      const fresh = [...this.pred.bolts, ...this.pred.grenades].filter((b) => b.id < PRED_ID_BASE);
      const known = new Set(this.knownIds);
      for (const nb of fresh) {
        if (known.has(nb.id)) continue;
        let best = -1, bd = 9;
        oldBolts.forEach((ob, i) => { const d = (ob.pos[0] - nb.pos[0]) ** 2 + (ob.pos[1] - nb.pos[1]) ** 2 + (ob.pos[2] - nb.pos[2]) ** 2; if (ob.kind === ((nb as { kind?: string }).kind ?? 'g') && d < bd) { bd = d; best = i; } });
        if (best >= 0) { this.hooks.onRename(oldBolts[best].id, nb.id); oldBolts.splice(best, 1); }
      }
    }
    this.knownIds = [...this.pred.bolts, ...this.pred.grenades].filter((b) => b.id < PRED_ID_BASE).map((b) => b.id);
  }
  private knownIds: number[] = [];

  private me(): Player | undefined {
    return this.pred?.players[0];
  }

  private stepPred(cmd: NetInput, live: boolean) {
    const pred = this.pred!;
    const full: InputCmd = { ...cmd, playerId: this.localId, tick: pred.tick };
    step(pred, [full], pred.tick);
    if (live) for (const e of pred.events) if (this.predictedHere(e) || e.type === 'grenadeBounce') this.hooks.onEvent(e, true);
  }

  /**
   * One tick of the local clock: take this tick's input, send it, apply it.
   * `sample` is given your player id and the tick it will run on.
   */
  tick(sample: (playerId: number, tick: number) => InputCmd) {
    const now = this.hooks.now();
    if (now - this.lastPing > 1000) { this.lastPing = now; this.send(encodeControl({ t: 'ping', c: now })); }
    if (!this.pred) return;
    const c = sample(this.localId, this.pred.tick);
    const cmd: NetInput = { moveX: c.moveX, moveY: c.moveY, yaw: c.yaw, pitch: c.pitch, buttons: c.buttons, weapon: c.weapon };
    const seq = this.seq++;
    this.pending.push({ seq, cmd });
    if (this.pending.length > 360) this.pending.shift(); // (the server's gone quiet: don't hoard)
    this.send(encodeControl({ t: 'input', seq, cmds: [cmd] }));
    const me = this.me();
    this.prevMePos = me ? [...me.pos] as Vec3 : null;
    this.prevFrameAngle = this.pred.frameAngle;
    this.stepPred(cmd, true);
  }

  /** Your predicted player (for the camera, the HUD, aiming), or the server's if there's no prediction. */
  get localPlayer(): Player | undefined {
    return this.me() ?? this.world?.players.find((p) => p.id === this.localId);
  }

  /**
   * What to draw this frame: everyone else interpolated between snapshots (in
   * the past), you and your shots from the prediction (now), `alpha` of the
   * way from the last tick to this one. `dt`: seconds since the last frame.
   */
  renderState(alpha: number, dt: number): SimState | null {
    const world = this.world;
    if (!world) return null;
    const k = Math.exp(-dt / SMOOTH_TIME);
    this.smooth = [this.smooth[0] * k, this.smooth[1] * k, this.smooth[2] * k];
    // the moment in the past we're drawing the others at, and the snapshots either side of it
    const rt = (this.hooks.now() / 1000) / DT + this.tickOffset - INTERP_SNAPSHOTS * this.snapEvery;
    const snaps = this.snaps;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].tick > rt) i--;
    const a = snaps[i]?.dyn, b = snaps[Math.min(i + 1, snaps.length - 1)]?.dyn;
    if (!a || !b) return { ...world, players: this.me() ? [this.me()!] : world.players };
    const f = b.tick > a.tick ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 0;
    const ahead = Math.max(0, Math.min(this.snapEvery, rt - b.tick)) * DT; // (past the newest snapshot: coast a little on velocity)
    const blend = <T extends { id: number; pos: Vec3; vel: Vec3 }>(as: T[], bs: T[], skip: (x: T) => boolean): T[] => {
      const byId = new Map(bs.map((x) => [x.id, x]));
      const out: T[] = [];
      for (const x of as) {
        if (skip(x)) continue;
        const y = byId.get(x.id);
        // (a body that changed rings between the two is in a different frame in each: don't blend across that)
        const sameFrame = !world.config.twin || !y || (x.pos[2] >= 0) === (y.pos[2] >= 0);
        const pos = y && sameFrame ? lerp3(x.pos, y.pos, f) : x.pos;
        out.push({ ...x, pos: ahead > 0 && y ? [pos[0] + y.vel[0] * ahead, pos[1] + y.vel[1] * ahead, pos[2] + y.vel[2] * ahead] : pos });
      }
      return out;
    };
    const me = this.me();
    const players = blend(a.players, b.players, (p) => !!me && p.id === this.localId).map((p) => {
      const q = b.players.find((y) => y.id === p.id);
      return q ? { ...p, yaw: lerpAngle(p.yaw, q.yaw, f), pitch: p.pitch + (q.pitch - p.pitch) * f } : p;
    });
    const mineToo = !me; // (no prediction: draw the server's version of your things)
    const bolts = blend(a.bolts, b.bolts, (x) => !mineToo && x.owner === this.localId);
    const grenades = blend(a.grenades, b.grenades, (x) => !mineToo && x.owner === this.localId);
    const vehicles = blend(a.vehicles, b.vehicles, (v) => !!me && v.id === me.vehicle);
    const props = blend(a.props, b.props, () => false);
    const flags = a.flags.map((fl) => { const y = b.flags.find((z) => z.team === fl.team); return y && y.state === fl.state ? { ...fl, pos: lerp3(fl.pos, y.pos, f) } : fl; });
    let frameAngle = a.frameAngle + (b.frameAngle - a.frameAngle) * f;
    if (me && this.pred) {
      // you, now: between the last tick and this one, plus whatever correction is still fading out
      const p0 = this.prevMePos ?? me.pos;
      const pos = lerp3(p0, me.pos, alpha);
      players.push({ ...me, canRespawn: true, pos: [pos[0] + this.smooth[0], pos[1] + this.smooth[1], pos[2] + this.smooth[2]] });
      const back = (1 - alpha) * DT;
      for (const x of this.pred.bolts) bolts.push({ ...x, pos: [x.pos[0] - x.vel[0] * back, x.pos[1] - x.vel[1] * back, x.pos[2] - x.vel[2] * back] });
      for (const x of this.pred.grenades) grenades.push({ ...x, pos: [x.pos[0] - x.vel[0] * back, x.pos[1] - x.vel[1] * back, x.pos[2] - x.vel[2] * back] });
      for (const v of this.pred.vehicles) vehicles.push({ ...v, pos: [v.pos[0] - v.vel[0] * back + this.smooth[0], v.pos[1] - v.vel[1] * back + this.smooth[1], v.pos[2] - v.vel[2] * back + this.smooth[2]] });
      frameAngle = this.prevFrameAngle + (this.pred.frameAngle - this.prevFrameAngle) * alpha;
    }
    return { ...world, players, bolts, grenades, vehicles, props, flags, frameAngle, pickups: a.pickups, explosions: world.explosions };
  }
}
