// Multiplayer, in one process: a Room and some NetClients joined by a fake
// network with delay and jitter, on a virtual clock.
import { describe, expect, it } from 'vitest';
import { BTN_FIRE, BTN_JUMP, DT, damagePlayer, dist, levelById, type InputCmd, type SimEvent, type Vec3 } from '../src/sim';
import { NetClient } from '../src/net/client';
import { Room } from '../src/net/room';
import type { MatchSpec } from '../src/net/protocol';

const TICK_MS = 1000 * DT;

/** A virtual network: every message is delayed by `delay` +- `jitter` ms, and arrives in order (as over TCP). */
class Net {
  now = 0;
  private queue: { at: number; run: () => void }[] = [];
  private lastAt = new Map<string, number>();
  private n = 1;
  constructor(public delay = 50, public jitter = 15) {}
  private rand() { this.n = (this.n * 1664525 + 1013904223) >>> 0; return this.n / 4294967296; }
  post(channel: string, run: () => void) {
    const at = Math.max(this.lastAt.get(channel) ?? 0, this.now + this.delay + (this.rand() * 2 - 1) * this.jitter);
    this.lastAt.set(channel, at);
    this.queue.push({ at, run });
  }
  deliver() {
    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length && this.queue[0].at <= this.now) this.queue.shift()!.run();
  }
}

interface Peer { client: NetClient; id: number; events: { e: SimEvent; predicted: boolean }[]; matches: number; renames: [number, number][]; input: (tick: number) => Partial<InputCmd> }

function setup(spec: MatchSpec, net: Net, roomOpts = {}) {
  const room = new Room(spec, roomOpts);
  const peers: Peer[] = [];
  const join = (name: string, team = -1): Peer => {
    const peer = { events: [], matches: 0, renames: [], input: () => ({}) } as unknown as Peer;
    const cid = room.connect((bytes) => net.post(`s>${name}`, () => peer.client.receive(bytes)));
    peer.id = cid;
    peer.client = new NetClient((bytes) => net.post(`${name}>s`, () => room.receive(cid, bytes)), {
      onMatch: () => { peer.matches++; },
      onEvent: (e, predicted) => { peer.events.push({ e, predicted }); },
      onRename: (a, b) => { peer.renames.push([a, b]); },
      now: () => net.now,
    });
    peer.client.hello(name, -1, team);
    peers.push(peer);
    return peer;
  };
  /** Run the whole thing for n ticks; `each` is called after every tick. */
  const run = (n: number, each?: (i: number) => void) => {
    for (let i = 0; i < n; i++) {
      net.now += TICK_MS;
      net.deliver();
      room.tick();
      for (const p of peers) p.client.tick((playerId, tick) => ({ playerId, tick, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0, ...p.input(tick) }));
      each?.(i);
    }
  };
  return { room, peers, join, run };
}

const quiet = (id = 's-standard', setupOpts = {}): MatchSpec => ({ def: { ...levelById(id)!, props: false, bots: 0 }, setup: { ...setupOpts } });
const serverPlayer = (room: Room, c: NetClient) => room.state.players.find((p) => p.id === c.localId)!;

describe('net 1. joining', () => {
  it('a client that says hello is put in the match, builds the same level, and starts getting snapshots', () => {
    const net = new Net(40, 10);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann');
    run(60);
    expect(a.matches).toBe(1);
    expect(a.client.localId).toBe(room.state.players[0].id);
    expect(room.state.players[0].name).toBe('Ann');
    const w = a.client.world!;
    expect(w.level.boxes.length).toBe(room.state.level.boxes.length);
    expect(w.level.boxes.map((b) => b.center)).toEqual(room.state.level.boxes.map((b) => b.center));
    expect(w.config.R).toBe(room.state.config.R);
    expect(a.client.stats.snapshots).toBeGreaterThan(5);
    expect(w.players.length).toBe(1);
  });
  it('leaving takes your player out; a second player sees the first', () => {
    const net = new Net(40, 10);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann'), b = join('Bob');
    run(60);
    expect(room.state.players.length).toBe(2);
    expect(b.client.world!.players.map((p) => p.name).sort()).toEqual(['Ann', 'Bob']);
    room.disconnect(a.id);
    run(30);
    expect(room.state.players.map((p) => p.name)).toEqual(['Bob']);
    expect(b.client.world!.players.length).toBe(1);
  });
});

describe('net 2. prediction and reconciliation', () => {
  const wander = (tick: number): Partial<InputCmd> => ({
    moveY: 1, moveX: Math.sin(tick / 90) > 0.5 ? 1 : 0, yaw: 0.6 * Math.sin(tick / 200), buttons: tick % 300 === 0 ? BTN_JUMP : 0,
  });
  it('your own player moves at once, ahead of the server, and the server agrees: no corrections', () => {
    const net = new Net(60, 20);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann');
    run(60);
    a.input = wander;
    let ahead = 0;
    run(120 * 6, (i) => {
      if (i === 300) {
        // the prediction is where the server will be, not where the last snapshot says you were
        const me = a.client.localPlayer!, seen = a.client.world!.players.find((p) => p.id === a.client.localId)!;
        ahead = dist(me.pos, seen.pos);
      }
    });
    expect(ahead).toBeGreaterThan(0.4); // (about 150 ms of running)
    expect(a.client.stats.maxCorrection).toBeLessThan(1e-6);
    // stop, let everything arrive: the same place exactly
    a.input = () => ({});
    run(240);
    expect(dist(a.client.localPlayer!.pos, serverPlayer(room, a.client).pos)).toBeLessThan(1e-9);
    expect(a.client.stats.queued).toBeLessThan(room.opts.maxQueue);
  });
  it('when the server disagrees (you get shoved), you end up where it says, without a visible jump', () => {
    const net = new Net(60, 20);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann');
    run(60);
    a.input = wander;
    let last: Vec3 | null = null, maxStep = 0;
    run(120 * 4, (i) => {
      if (i === 120) { const p = serverPlayer(room, a.client); p.vel = [p.vel[0], p.vel[1], p.vel[2] + 9]; } // a shove the client knows nothing about
      const rs = a.client.renderState(1, DT)!;
      const me = rs.players.find((p) => p.id === a.client.localId)!;
      if (last) maxStep = Math.max(maxStep, dist(last, me.pos));
      last = [...me.pos] as Vec3;
    });
    expect(a.client.stats.maxCorrection).toBeGreaterThan(0.2); // it was wrong for a moment...
    expect(maxStep).toBeLessThan(0.35); // ...but what you saw never jumped (running is about 0.06 m a tick)
    a.input = () => ({});
    run(240);
    expect(dist(a.client.localPlayer!.pos, serverPlayer(room, a.client).pos)).toBeLessThan(1e-9); // ...and it's put right
  });
  it('your shots appear at once, and become the server\'s without doubling up', () => {
    const net = new Net(60, 20);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann'), b = join('Bob');
    run(90);
    a.input = (tick) => ({ buttons: tick % 60 < 30 ? BTN_FIRE : 0, pitch: 0.3 });
    let sawPredictedFirst = false, maxMine = 0;
    run(120 * 3, () => {
      const mine = a.client.renderState(1, DT)!.bolts.filter((x) => x.owner === a.client.localId);
      const serverSide = room.state.bolts.filter((x) => x.owner === a.client.localId).length;
      maxMine = Math.max(maxMine, mine.length - Math.max(serverSide, a.client.pred!.bolts.length));
      if (mine.length > 0 && a.client.world!.bolts.filter((x) => x.owner === a.client.localId).length === 0) sawPredictedFirst = true;
    });
    expect(sawPredictedFirst).toBe(true);
    expect(maxMine).toBeLessThanOrEqual(0); // never more of them on screen than really exist
    expect(a.renames.length).toBeGreaterThan(3); // predicted bolts carried on as the server's
    a.input = () => ({});
    run(120); // (let the last of it arrive)
    // the fire sound was played once, from the prediction, not again from the server
    const fires = a.events.filter((x) => x.e.type === 'fire');
    expect(fires.length).toBeGreaterThan(3);
    expect(fires.every((x) => x.predicted)).toBe(true);
    // the other player heard them from the server, and saw the bolts
    expect(b.events.filter((x) => x.e.type === 'fire' && !x.predicted).length).toBe(fires.length);
  });
});

describe('net 3. interpolation', () => {
  it('another player is drawn smoothly, a little in the past, however unevenly the snapshots arrive', () => {
    const net = new Net(70, 30);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann'), b = join('Bob');
    run(120);
    a.input = (tick) => ({ moveY: 1, yaw: tick / 150 }); // running in a curve
    const truth = new Map<number, Vec3>(); // where Ann really was, tick by tick
    let last: Vec3 | null = null, maxStep = 0, minStep = Infinity, maxErr = 0, lagTicks = 0, n = 0;
    run(120 * 5, (i) => {
      truth.set(room.state.tick, [...serverPlayer(room, a.client).pos] as Vec3);
      if (i < 120) return;
      const seen = b.client.renderState(1, DT)!.players.find((p) => p.id === a.client.localId)!;
      if (last) { const d = dist(last, seen.pos); maxStep = Math.max(maxStep, d); minStep = Math.min(minStep, d); }
      last = [...seen.pos] as Vec3;
      // which past moment is this? the nearest true position
      let bestT = 0, bd = Infinity;
      for (const [t, p] of truth) { const d = dist(p, seen.pos); if (d < bd) { bd = d; bestT = t; } }
      maxErr = Math.max(maxErr, bd);
      lagTicks += room.state.tick - bestT;
      n++;
    });
    const speed = 0.06; // m per tick, about
    expect(maxStep).toBeLessThan(speed * 2.5); // no jumps
    expect(minStep).toBeGreaterThan(speed * 0.2); // no stalls
    expect(maxErr).toBeLessThan(0.05); // on her real path (to within the curve between snapshots)
    const lagMs = (lagTicks / n) * TICK_MS;
    expect(lagMs).toBeGreaterThan(100); // the network's delay plus the interpolation buffer
    expect(lagMs).toBeLessThan(260);
  });
});

describe('net 4. matches', () => {
  it('a match that ends starts again after a pause, and anyone can ask for another level', () => {
    const net = new Net(30, 5);
    const { room, join, run } = setup(quiet('s-standard', { scoreLimit: 1 }), net, { restartDelay: 1 });
    const a = join('Ann'), b = join('Bob');
    run(60);
    const first = a.client.matchId;
    const pa = serverPlayer(room, a.client), pb = serverPlayer(room, b.client);
    damagePlayer(room.state, pb, pa.id, 1e4, 1e4, 'test');
    run(30);
    expect(room.state.over).toBe(true);
    expect(a.client.world!.over).toBe(true);
    expect(a.client.world!.winner).toBe(pa.id);
    run(120 * 2);
    expect(a.client.matchId).toBe(first + 1);
    expect(a.matches).toBe(2);
    expect(room.state.over).toBe(false);
    expect(room.state.players.length).toBe(2);
    expect(a.client.localPlayer!.score).toBe(0);
    // Bob asks for the disk, as capture the flag
    b.client.requestStart({ def: levelById('s-disk')!, setup: { teams: 2, ctf: true, bots: [1, 1], scoreLimit: 3 } });
    run(90);
    expect(room.state.config.world).toBe('disk');
    expect(a.client.world!.config.world).toBe('disk');
    expect(a.client.world!.flags.length).toBe(2);
    expect(room.state.players.length).toBe(4);
    // put on different teams (the smaller one each time), in team colours
    const ta = serverPlayer(room, a.client).team, tb = serverPlayer(room, b.client).team;
    expect(new Set([ta, tb]).size).toBe(2);
    expect(a.client.world!.level.bases!.length).toBe(2);
  });
  it('rubbish from a client is ignored', () => {
    const net = new Net(10, 0);
    const { room, join, run } = setup(quiet(), net);
    const a = join('Ann');
    run(30);
    room.receive(a.id, new Uint8Array([9, 9, 9]));
    room.receive(a.id, new Uint8Array([0, 255, 1, 2]));
    room.receive(a.id, new Uint8Array(0));
    run(30);
    expect(room.state.players.length).toBe(1);
    expect(Number.isFinite(room.state.players[0].pos[0])).toBe(true);
  });
});
