// Runs the simulation headless in Node (no DOM, no three.js): proof that the
// sim module can become the authoritative server.
//   npm run headless -- [seconds]
import { DT, addPlayer, botInput, createState, encode, step } from '../src/sim';

declare const process: { argv: string[] };
const seconds = Number(process.argv[2] ?? 60);
const s = createState({ seed: 7 });
const bots = [1, 2, 3, 4].map((i) => addPlayer(s, 'bot', `Bot ${i}`));
const counts: Record<string, number> = {};
const t0 = performance.now();
const n = Math.round(seconds / DT);
let maxBolts = 0;
for (let i = 0; i < n; i++) {
  step(s, bots.map((b) => botInput(s, b)), s.tick);
  for (const e of s.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  maxBolts = Math.max(maxBolts, s.bolts.length);
}
const ms = performance.now() - t0;
console.log(`simulated ${seconds}s (${n} ticks) in ${ms.toFixed(0)} ms -> ${(ms / n * 1000).toFixed(1)} us/tick`);
console.log('events:', counts);
console.log('peak live bolts:', maxBolts, ' snapshot size:', encode(s).byteLength, 'bytes');
for (const p of s.players.filter((p) => p.kind === 'bot')) console.log(`  ${p.name}: ${p.kills} kills / ${p.deaths} deaths`);
