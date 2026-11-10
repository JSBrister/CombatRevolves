import { botInput, encode, levelById, startLevel, step } from '../src/sim';
import { dynOf, encodeSnapshotBody } from '../src/net/protocol';
const { state: s, botIds, localId } = startLevel(levelById('s-standard')!, {}, { bots: [7] });
for (let i = 0; i < 120 * 20; i++) step(s, [...botIds.map((b) => botInput(s, b))], s.tick);
void localId;
const d = dynOf(s);
const size = (x: unknown) => encode(x).length;
console.log('players', s.players.length, size(d.players), 'bolts', s.bolts.length, size(d.bolts), 'grenades', size(d.grenades), 'props', s.props.length, size(d.props), 'pickups', s.pickups.length, size(d.pickups), 'vehicles', size(d.vehicles), 'explosions', size(d.explosions), 'total', encodeSnapshotBody(d, []).length);
const t0 = performance.now(); for (let i = 0; i < 200; i++) encodeSnapshotBody(d, []); console.log('encode ms', ((performance.now() - t0) / 200).toFixed(3));

// with the socket's compression (deflate, its dictionary carried from one message to the next): a run of snapshots
import { createDeflateRaw, constants } from 'node:zlib';
const z = createDeflateRaw({ level: 3 });
let out = 0; z.on('data', (c: Uint8Array) => { out += c.length; });
let raw = 0; const N = 300;
for (let i = 0; i < N * 4; i++) {
  step(s, [...botIds.map((b) => botInput(s, b))], s.tick);
  if (i % 4) continue;
  const b = encodeSnapshotBody(dynOf(s), s.events);
  raw += b.length;
  z.write(b); z.flush(constants.Z_SYNC_FLUSH);
}
z.end(() => console.log('per snapshot: raw', Math.round(raw / N), 'compressed', Math.round(out / N), '-> at 30/s:', Math.round((out / N) * 30 / 1024), 'KB/s'));
