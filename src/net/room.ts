// The server's side of a match: the one authoritative simulation.
//
// A Room owns a SimState and steps it at the sim's fixed rate. Clients send
// their inputs (numbered); the room uses one per tick for each client, in
// order, and tells each client in every snapshot the number of the last one
// it used, so the client can replay the rest on top (see client.ts).
// Bots are driven here. Nothing a client says is trusted beyond its inputs.
//
// The room knows nothing about sockets: it's handed a `send` function per
// client, so the same code runs under a WebSocket server and in tests.

import {
  DT, botInput, joinPlayer, neutralInput, removePlayer, startLevel, step,
  type GameSetup, type InputCmd, type SimEvent, type SimState,
} from '../sim';
import { decodeFrame, dynOf, encodeControl, encodeSnapshotBody, frameSnapshot, type ClientMsg, type MatchSpec, type NetInput } from './protocol';

export interface RoomOptions {
  snapEvery: number; // ticks between snapshots (4: 30 a second)
  restartDelay: number; // seconds from a match ending to the next starting
  maxQueue: number; // inputs a client may have waiting; more than this and the oldest are skipped (a burst after a stall)
  log: (text: string) => void;
}

interface Client {
  id: number;
  send: (bytes: Uint8Array) => void;
  name: string;
  color: number;
  team: number; // asked for (-1: any)
  playerId: number; // in the current match (-1 before hello)
  queue: { seq: number; cmd: NetInput }[];
  lastSeq: number; // the last input used
  lastCmd: NetInput;
}

const NEUTRAL: NetInput = { moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };

/** The bots for a match with no "you" in it: the setup's, or the level's own shared out evenly. */
function serverBots(spec: MatchSpec): number[] {
  const teams = spec.setup.teams ?? 0, n = spec.def.bots ?? 0;
  if (spec.setup.bots) return spec.setup.bots;
  return teams >= 2 ? Array.from({ length: teams }, (_, t) => Math.floor(n / teams) + (t < n % teams ? 1 : 0)) : [n];
}

export class Room {
  state!: SimState;
  botIds: number[] = [];
  matchId = 0;
  spec!: MatchSpec;
  clients = new Map<number, Client>();
  opts: RoomOptions;
  private nextClient = 1;
  private pendingEvents: SimEvent[] = [];
  private overTick = -1;

  constructor(spec: MatchSpec, opts: Partial<RoomOptions> = {}) {
    this.opts = { snapEvery: 4, restartDelay: 8, maxQueue: 24, log: () => {}, ...opts };
    this.start(spec);
  }

  /** Start a (new) match: build the level, put everyone who's connected into it, and tell them. */
  start(spec: MatchSpec) {
    // (through JSON: a client's description of a level is data, nothing more)
    this.spec = JSON.parse(JSON.stringify({ def: { ...spec.def, mode: 'sandbox', enemies: undefined, tips: undefined }, setup: spec.setup })) as MatchSpec;
    const setup: GameSetup = { ...this.spec.setup, name: undefined, color: undefined, bots: serverBots(this.spec) };
    const started = startLevel(this.spec.def, {}, setup);
    this.state = started.state;
    removePlayer(this.state, started.localId); // (startLevel's "you": on a server, players join instead)
    this.botIds = started.botIds;
    this.matchId++;
    this.pendingEvents = [];
    this.overTick = -1;
    for (const c of this.clients.values()) if (c.playerId >= 0) this.enter(c);
    this.opts.log(`match ${this.matchId}: ${this.spec.def.name} (${this.clients.size} connected, ${this.botIds.length} bots)`);
  }

  private enter(c: Client) {
    c.playerId = joinPlayer(this.state, { name: c.name, color: c.color, team: c.team >= 0 ? c.team : undefined });
    c.queue = [];
    c.lastSeq = -1;
    c.lastCmd = NEUTRAL;
    c.send(encodeControl({ t: 'match', id: c.playerId, matchId: this.matchId, spec: this.spec, tickRate: Math.round(1 / DT), snapEvery: this.opts.snapEvery }));
  }

  /** A connection opens. It's in the match once it says hello. */
  connect(send: (bytes: Uint8Array) => void): number {
    const id = this.nextClient++;
    this.clients.set(id, { id, send, name: '', color: -1, team: -1, playerId: -1, queue: [], lastSeq: -1, lastCmd: NEUTRAL });
    return id;
  }

  disconnect(id: number) {
    const c = this.clients.get(id);
    if (!c) return;
    if (c.playerId >= 0) removePlayer(this.state, c.playerId);
    this.clients.delete(id);
    this.opts.log(`${c.name || 'someone'} left (${this.clients.size} connected)`);
  }

  /** A frame from a client. Anything malformed is dropped (and a bad client can only hurt itself). */
  receive(id: number, bytes: Uint8Array) {
    const c = this.clients.get(id);
    if (!c) return;
    let msg: ClientMsg;
    try {
      const f = decodeFrame(bytes);
      if (f.kind !== 'control') return;
      msg = f.msg as ClientMsg;
    } catch { return; }
    switch (msg.t) {
      case 'hello':
        if (c.playerId >= 0) return;
        c.name = String(msg.name ?? '').slice(0, 16);
        c.color = Number.isFinite(msg.color) ? msg.color | 0 : -1;
        c.team = Number.isFinite(msg.team) ? msg.team | 0 : -1;
        this.enter(c);
        this.opts.log(`${c.name || 'Player'} joined (${this.clients.size} connected)`);
        break;
      case 'input': {
        if (c.playerId < 0 || !Array.isArray(msg.cmds)) return;
        let seq = msg.seq | 0;
        for (const raw of msg.cmds.slice(0, 64)) {
          const num = (x: unknown, lo: number, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : 0);
          const cmd: NetInput = { moveX: num(raw.moveX, -1, 1), moveY: num(raw.moveY, -1, 1), yaw: num(raw.yaw, -1e6, 1e6), pitch: num(raw.pitch, -2, 2), buttons: num(raw.buttons, 0, 0xffff) | 0, weapon: num(raw.weapon, 0, 255) | 0 };
          if (seq > c.lastSeq && (!c.queue.length || seq > c.queue[c.queue.length - 1].seq)) c.queue.push({ seq, cmd });
          seq++;
        }
        // a burst after a stall: skip ahead rather than fall ever further behind
        while (c.queue.length > this.opts.maxQueue) { const d = c.queue.shift()!; c.lastSeq = d.seq; }
        break;
      }
      case 'start':
        if (msg.spec && msg.spec.def && typeof msg.spec.def.config === 'object') {
          try { this.start({ def: msg.spec.def, setup: msg.spec.setup ?? {} }); } catch (e) { c.send(encodeControl({ t: 'error', text: `couldn't start that level: ${String(e)}` })); }
        }
        break;
      case 'ping':
        c.send(encodeControl({ t: 'pong', c: msg.c }));
        break;
    }
  }

  /** One tick of the match: everyone's next input, the bots', a step; a snapshot when one's due. */
  tick() {
    const s = this.state;
    const inputs: InputCmd[] = [];
    for (const c of this.clients.values()) {
      if (c.playerId < 0) continue;
      const next = c.queue.shift();
      if (next) { c.lastSeq = next.seq; c.lastCmd = next.cmd; }
      inputs.push({ ...neutralInput(c.playerId, s.tick), ...c.lastCmd, playerId: c.playerId, tick: s.tick });
    }
    for (const b of this.botIds) inputs.push(botInput(s, b));
    step(s, inputs, s.tick);
    for (const e of s.events) this.pendingEvents.push(e);
    if (s.tick % this.opts.snapEvery === 0) this.broadcast();
    // the match is over: a pause to read the result, then the same again
    if (s.over) {
      if (this.overTick < 0) this.overTick = s.tick;
      else if ((s.tick - this.overTick) * DT >= this.opts.restartDelay) this.start(this.spec);
    }
  }

  private broadcast() {
    const body = encodeSnapshotBody(dynOf(this.state), this.pendingEvents);
    this.pendingEvents = [];
    for (const c of this.clients.values()) if (c.playerId >= 0) c.send(frameSnapshot(this.matchId, c.lastSeq, c.queue.length, body));
  }
}
