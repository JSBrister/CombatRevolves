// Seeded RNG (mulberry32). The state is a single uint32 that lives inside
// SimState, so snapshots capture it and replays are exact.

export function rngNext(holder: { rng: number }): number {
  let t = (holder.rng = (holder.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const rngRange = (h: { rng: number }, a: number, b: number) => a + (b - a) * rngNext(h);
export const rngInt = (h: { rng: number }, n: number) => Math.floor(rngNext(h) * n);

/** Stateless integer hash -> [0,1). Used by bots (pure functions of state). */
export function hash01(...xs: number[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    h = Math.imul(h ^ (x | 0), 16777619);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  }
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
