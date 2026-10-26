// Misst die Simulationsgeschwindigkeit und zeigt, was die KI tut: npx tsx scripts/bench.ts [Tage]
import fs from 'node:fs';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import { DAY } from '../src/game/balance.ts';
const days = Number(process.argv[2] ?? 30);
const map = JSON.parse(fs.readFileSync('public/maps/europe.json', 'utf8'));
const state = createGame(map, { id: 'b', name: 'b', playerNation: 'DE', speed: 1, seed: 1, now: 0 });
state.nations.DE.controller = 'ai';
const sim = new Simulation(state, map);
const all: { time: number; text: string }[] = [];
const orig = sim.log;
sim.log = (...args: Parameters<typeof orig>) => {
  const [t, n] = args;
  if (!n) all.push({ time: sim.state.time, text: t });
  orig.apply(sim, args);
};
const t0 = performance.now();
sim.advance(days * DAY);
console.log(`${days} Tage: ${Math.round(performance.now() - t0)} ms`);
const ev = all.filter((e) => /Krieg|Frieden|gefallen|existieren/.test(e.text));
for (const e of ev) console.log(`Tag ${Math.floor(e.time / DAY) + 1}: ${e.text}`);
const count: Record<string, number> = {};
for (const p of sim.state.provinces) count[p.owner] = (count[p.owner] ?? 0) + 1;
console.log(Object.entries(count).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('Armeen:', sim.state.armies.length, 'unterwegs:', sim.state.armies.filter((a) => a.move).length, 'Tag', sim.state.time / DAY, sim.state.winner ? `Sieger ${sim.state.winner}` : '');
const units: Record<string, number> = {};
for (const a of sim.state.armies) for (const [u, n] of Object.entries(a.units)) units[u] = (units[u] ?? 0) + (n ?? 0);
console.log('Einheiten:', Object.entries(units).map(([k, v]) => `${k}:${v}`).join(' '));
