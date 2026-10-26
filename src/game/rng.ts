// Deterministischer Zufall (mulberry32). Der Zustand liegt im Spielstand, damit
// Live-Spiel und Nachsimulation identische Ergebnisse liefern.

export function nextRandom(state: { rng: number }): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function makeRng(seed: number): () => number {
  const s = { rng: seed | 0 };
  return () => nextRandom(s);
}
