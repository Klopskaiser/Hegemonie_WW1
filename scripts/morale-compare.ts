// Vergleicht Rechenweisen der Kampfmoral (Mechanik 1 und 2, je mit und ohne Übermacht) ohne Browser:
//   1. gestellte Gefechte vor einer französischen Stadt (ohne KI, ohne Nachschub), je Aufstellung mehrere Zufallsläufe
//   2. ganze KI-Partien
// Aufruf: npx tsx scripts/morale-compare.ts [Läufe je Gefecht=12] [Partien=3] [Tage=30]
import fs from 'node:fs';
import { HOUR } from '../src/game/balance.ts';
import { inMelee, unitCount } from '../src/game/military.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army, CombatMoraleMode } from '../src/game/types.ts';

const RUNS = Number(process.argv[2] ?? 12);
const GAMES = Number(process.argv[3] ?? 3);
const DAYS = Number(process.argv[4] ?? 30);
const MAX_HOURS = 96;

interface Variant { name: string; mode: CombatMoraleMode; superiority: boolean }
const VARIANTS: Variant[] = [
  { name: 'M1', mode: 1, superiority: false },
  { name: 'M1+Ü', mode: 1, superiority: true },
  { name: 'M2', mode: 2, superiority: false },
  { name: 'M2+Ü', mode: 2, superiority: true },
];

const map: MapData = JSON.parse(fs.readFileSync('public/maps/europe.json', 'utf8'));
const fr = map.provinces.find((p) => p.nation === 'FR' && !p.capital && (p.links ?? []).some((n) => map.provinces[n].nation === 'DE'))!;
const q = fr.id;

type Side = Partial<Record<'infantry' | 'artillery' | 'tank', number>>;
interface Scenario {
  name: string;
  /** Angreifer (DE) am Ort; mehrere Einträge = getrennte Armeen */
  attack: Side[];
  /** Verteidiger (FR) in der eigenen Stadt */
  defend: Side;
  fortress?: number;
  /** Artillerie des Angreifers, die aus rund 20 km auf den Verteidiger schießt */
  guns?: number;
  /** Start-Moral (Standard 70 %) */
  attackMorale?: number;
  defendMorale?: number;
}
const SCENARIOS: Scenario[] = [
  { name: '20 Inf gegen 20 Inf', attack: [{ infantry: 20 }], defend: { infantry: 20 } },
  { name: '30 Inf gegen 20 Inf', attack: [{ infantry: 30 }], defend: { infantry: 20 } },
  { name: '40 Inf gegen 20 Inf', attack: [{ infantry: 40 }], defend: { infantry: 20 } },
  { name: '20 Inf + 3 Art gegen 25 Inf', attack: [{ infantry: 20, artillery: 3 }], defend: { infantry: 25 } },
  { name: '2 × 15 Inf gegen 25 Inf', attack: [{ infantry: 15 }, { infantry: 15 }], defend: { infantry: 25 } },
  { name: '25 Inf gegen 20 Inf, Festung 2', attack: [{ infantry: 25 }], defend: { infantry: 20 }, fortress: 2 },
  { name: '20 Inf + 4 Art aus 20 km gegen 20 Inf', attack: [{ infantry: 20 }], defend: { infantry: 20 }, guns: 4 },
  // Übermacht mit unterschiedlicher Moral, jeweils in beiden Rollen
  { name: '20 Inf (90 %) greift 65 Inf (50 %) an', attack: [{ infantry: 20 }], defend: { infantry: 65 }, attackMorale: 0.9, defendMorale: 0.5 },
  { name: '65 Inf (50 %) greift 20 Inf (90 %) an', attack: [{ infantry: 65 }], defend: { infantry: 20 }, attackMorale: 0.5, defendMorale: 0.9 },
  { name: '100 Inf + 1 Pz (30 %) greift 25 Inf (95 %) an', attack: [{ infantry: 100, tank: 1 }], defend: { infantry: 25 }, attackMorale: 0.3, defendMorale: 0.95 },
  { name: '25 Inf (95 %) greift 100 Inf + 1 Pz (30 %) an', attack: [{ infantry: 25 }], defend: { infantry: 100, tank: 1 }, attackMorale: 0.95, defendMorale: 0.3 },
];

interface Result {
  hours: number;
  winner: 'Angreifer' | 'Verteidiger' | 'offen';
  attLeft: number;
  defLeft: number;
  attMin: number;
  defMin: number;
  attEnd: number;
  defEnd: number;
}

const count = (s: Side) => Object.values(s).reduce((x, y) => x + (y ?? 0), 0);

function battle(sc: Scenario, v: Variant, seed: number): Result {
  const state = createGame(map, { id: 'm', name: 'm', playerNation: 'DE', speed: 1, seed, now: 0, combatMorale: v.mode, superiority: v.superiority });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  const sim = new Simulation(state, map);
  sim.apply('DE', { type: 'declareWar', nation: 'FR' });
  const ps = sim.state.provinces[q];
  ps.buildings.fortress = sc.fortress ?? 0;
  ps.buildings.barracks = 0;
  ps.off = { ...(ps.off ?? {}), recruitment: true };
  sim.state.armies = sim.state.armies.filter((a) => a.node !== q && !(fr.links ?? []).includes(a.node));
  const add = (owner: string, units: Side, extra: Partial<Army> = {}): Army => {
    const morale = owner === 'FR' ? sc.defendMorale ?? 0.7 : sc.attackMorale ?? 0.7;
    const a = { id: sim.state.nextArmyId++, owner, node: q, units: { ...units }, morale, keepApart: true, ...extra } as Army;
    sim.state.armies.push(a);
    return a;
  };
  const def = add('FR', sc.defend);
  const att = sc.attack.map((u) => add('DE', u));
  if (sc.guns) {
    const p = (fr.links ?? []).find((n) => map.provinces[n].nation === 'DE')!;
    const c = map.provinces[q].center, o = map.provinces[p].center;
    const f = Math.min(0.9, 20 / Math.hypot(o[0] - c[0], o[1] - c[1]));
    add('DE', { artillery: sc.guns }, { pos: { a: q, b: p, f }, target: def.id });
  }
  const inf = (a: Army) => (a.units.infantry ? a.morale ?? 0.7 : 1);
  // Angreifer = deutsche Armeen am Ort (die Geschütze aus der Ferne zählen nicht zum Sieg)
  const attackers = () => sim.state.armies.filter((a) => a.owner === 'DE' && a.node === q && !a.pos && unitCount(a) > 0);
  const defAlive = () => sim.state.armies.includes(def) && unitCount(def) > 0;
  let attMin = Math.min(...att.map(inf)), defMin = inf(def), hours = 0;
  while (hours < MAX_HOURS && defAlive() && attackers().length) {
    sim.advance(HOUR);
    hours++;
    for (const a of attackers()) attMin = Math.min(attMin, inf(a));
    if (defAlive()) defMin = Math.min(defMin, inf(def));
  }
  const attUnits = attackers().reduce((t, a) => t + unitCount(a), 0);
  const defUnits = defAlive() ? unitCount(def) : 0;
  return {
    hours,
    winner: defUnits === 0 ? 'Angreifer' : attUnits === 0 ? 'Verteidiger' : 'offen',
    attLeft: attUnits / sc.attack.reduce((t, s) => t + count(s), 0),
    defLeft: defUnits / count(sc.defend),
    attMin,
    defMin,
    attEnd: attUnits ? Math.min(...attackers().map(inf)) : 0,
    defEnd: defUnits ? inf(def) : 0,
  };
}

const pct = (v: number) => `${Math.round(v * 100)} %`;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

console.log(`# Kampfmoral: ${VARIANTS.map((v) => v.name).join(', ')} (M = Mechanik, Ü = Übermacht)`);
console.log('');
console.log(`## Gestellte Gefechte (${RUNS} Läufe je Aufstellung, Verteidiger in eigener Stadt, Start-Moral 70 % wenn nicht angegeben, höchstens ${MAX_HOURS} h)`);
console.log('');
console.log('Rest = übrige Einheiten in % der Startzahl; Moral Ende = Moral der Überlebenden am Schluss (ausgelöschte Seite 0).');
console.log('');
console.log('| Aufstellung | Variante | Dauer Ø h | Sieg Angreifer | Rest A | Rest V | tiefste Moral A | tiefste Moral V | Moral Ende A | Moral Ende V |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const sc of SCENARIOS) {
  for (const v of VARIANTS) {
    const rs = Array.from({ length: RUNS }, (_, i) => battle(sc, v, 1000 + i));
    const cells = [
      sc.name, v.name, avg(rs.map((r) => r.hours)).toFixed(1), `${rs.filter((r) => r.winner === 'Angreifer').length}/${RUNS}`,
      pct(avg(rs.map((r) => r.attLeft))), pct(avg(rs.map((r) => r.defLeft))),
      pct(avg(rs.map((r) => r.attMin))), pct(avg(rs.map((r) => r.defMin))),
      pct(avg(rs.map((r) => r.attEnd))), pct(avg(rs.map((r) => r.defEnd))),
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}

if (GAMES > 0 && DAYS > 0) {
  console.log('');
  console.log(`## KI-Partien (${GAMES} Partien je Variante, ${DAYS} Tage, alle Nationen KI)`);
  console.log('');
  console.log('| Variante | Eroberungen | vernichtete Armeen | Kriegserklärungen | Ø Moral im Nahkampf | Ø Moral Infanterie Tagesende | Infanterie am Ende |');
  console.log('|---|---|---|---|---|---|---|');
  for (const v of VARIANTS) {
    const rows: number[][] = [];
    for (let g = 0; g < GAMES; g++) {
      const state = createGame(map, { id: 'g', name: 'g', playerNation: 'DE', speed: 1, seed: 1 + g, now: 0, combatMorale: v.mode, superiority: v.superiority });
      state.nations.DE.controller = 'ai';
      const sim = new Simulation(state, map);
      let conquests = 0, destroyed = 0, wars = 0;
      const orig = sim.log;
      sim.log = (...args: Parameters<typeof orig>) => {
        const [text, nation] = args;
        if (!nation) {
          if (/ erobert die Stadt | ist an .* gefallen/.test(text)) conquests++;
          if (/vernichtet\./.test(text)) destroyed++;
          if (/den Krieg!/.test(text)) wars++;
        }
        orig.apply(sim, args);
      };
      const melee: number[] = [], daily: number[] = [];
      for (let h = 0; h < DAYS * 24; h++) {
        sim.advance(HOUR);
        for (const a of sim.state.armies) if (a.units.infantry && inMelee(sim.state, map, a)) melee.push(a.morale ?? 0.7);
        if ((h + 1) % 24 === 0) daily.push(avg(sim.state.armies.filter((a) => a.units.infantry).map((a) => a.morale ?? 0.7)));
      }
      rows.push([conquests, destroyed, wars, avg(melee), avg(daily), sim.state.armies.reduce((t, a) => t + (a.units.infantry ?? 0), 0)]);
    }
    const m = (i: number) => avg(rows.map((r) => r[i]));
    console.log(`| ${v.name} | ${m(0).toFixed(1)} | ${m(1).toFixed(1)} | ${m(2).toFixed(1)} | ${pct(m(3))} | ${pct(m(4))} | ${Math.round(m(5))} |`);
  }
}
