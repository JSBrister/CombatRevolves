// The wire: what a client and the server say to each other.
//
// Every message is one binary frame. Byte 0 is its kind:
//   0  a control message: the rest is encode(obj) (the sim's own lossless
//      binary encoding), obj.t says which (see ClientMsg / ServerMsg);
//   1  a snapshot (server -> client): a small fixed header that differs per
//      client (which match, the last of that client's inputs the server has
//      used, how many are waiting), then the shared body: encode({ dyn, ev }),
//      encoded once for everybody.
//
// The level itself is never sent: both sides build it from the match's
// description (the level's definition, the setup, and so the seed).

import { decode, encode, type GameSetup, type InputCmd, type LevelDef, type SimEvent, type SimState } from '../sim';

/** What a match is: enough for anyone to build the same level and rules. */
export interface MatchSpec { def: LevelDef; setup: GameSetup }

export type ClientMsg =
  | { t: 'hello'; name: string; color: number; team: number }
  | { t: 'input'; seq: number; cmds: NetInput[] } // seq: the first one's number; they count up from there
  | { t: 'start'; spec: MatchSpec } // (re)start the match with this level and setup
  | { t: 'ping'; c: number };

export type ServerMsg =
  | { t: 'match'; id: number; matchId: number; spec: MatchSpec; tickRate: number; snapEvery: number } // a (new) match: your player's id in it
  | { t: 'pong'; c: number }
  | { t: 'error'; text: string };

/** An input as sent (the player and tick are the server's to fill in). */
export type NetInput = Pick<InputCmd, 'moveX' | 'moveY' | 'yaw' | 'pitch' | 'buttons' | 'weapon'>;

/** The part of the sim's state that changes: everything but the config and the level. */
export type Dyn = Pick<SimState, 'tick' | 'frameAngle' | 'rng' | 'nextId' | 'outcome' | 'flags' | 'captures' | 'winner' | 'over' | 'spinF' | 'spinRate' | 'spinTarget' | 'objective' | 'players' | 'bolts' | 'grenades' | 'props' | 'explosions' | 'pickups' | 'vehicles'>;
const DYN_KEYS: (keyof Dyn)[] = ['tick', 'frameAngle', 'rng', 'nextId', 'outcome', 'flags', 'captures', 'winner', 'over', 'spinF', 'spinRate', 'spinTarget', 'objective', 'players', 'bolts', 'grenades', 'props', 'explosions', 'pickups', 'vehicles'];

export function dynOf(state: SimState): Dyn {
  const d = {} as Record<string, unknown>;
  for (const k of DYN_KEYS) d[k] = state[k];
  return d as unknown as Dyn;
}

/** Lay a snapshot over a state (which then shares the snapshot's objects: don't step it, copy it first). */
export function applyDyn(state: SimState, dyn: Dyn) {
  for (const k of DYN_KEYS) (state as unknown as Record<string, unknown>)[k] = dyn[k];
}

export interface Snapshot { matchId: number; ack: number; queued: number; dyn: Dyn; ev: SimEvent[] }

export function encodeControl(msg: ClientMsg | ServerMsg): Uint8Array {
  const body = encode(msg);
  const out = new Uint8Array(body.length + 1);
  out[0] = 0;
  out.set(body, 1);
  return out;
}

/** The shared part of a snapshot, encoded once. */
export function encodeSnapshotBody(dyn: Dyn, ev: SimEvent[]): Uint8Array {
  return encode({ dyn, ev });
}

const HEADER = 10;
/** One client's snapshot: its own header on the shared body. */
export function frameSnapshot(matchId: number, ack: number, queued: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + body.length);
  const v = new DataView(out.buffer);
  out[0] = 1;
  v.setUint32(1, matchId);
  v.setInt32(5, ack);
  out[9] = Math.min(255, queued);
  out.set(body, HEADER);
  return out;
}

export type Incoming = { kind: 'control'; msg: ClientMsg | ServerMsg } | { kind: 'snapshot'; snap: Snapshot };

export function decodeFrame(bytes: Uint8Array): Incoming {
  if (bytes[0] === 1) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const body = decode<{ dyn: Dyn; ev: SimEvent[] }>(bytes.subarray(HEADER));
    return { kind: 'snapshot', snap: { matchId: v.getUint32(1), ack: v.getInt32(5), queued: bytes[9], dyn: body.dyn, ev: body.ev } };
  }
  return { kind: 'control', msg: decode<ClientMsg | ServerMsg>(bytes.subarray(1)) };
}
