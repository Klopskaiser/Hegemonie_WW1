// Regressionstests zu gemeldeten Fehlern: Besatzung nach dem Aufteilen und unter Beschuss, KI unter Beschuss,
// liegengebliebene Armeen, Hinterland, Kriegsziele von Inselnationen.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR } from '../src/game/balance.ts';
import { rangedRound } from '../src/game/military.ts';
import { BasicAI } from '../src/game/ai.ts';
import { setRelation } from '../src/game/diplomacy.ts';
import { nationRates } from '../src/game/economy.ts';
import { distanceKm, type MapData } from '../src/game/mapdata.ts';
import { armyPosition, unitCount } from '../src/game/military.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Action } from '../src/game/actions.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;

function newSim(day = 0) {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  state.time = day * DAY;
  return new Simulation(state, map);
}

const decide = (sim: Simulation, nation: string, random = 0.5): Action[] =>
  new BasicAI().decide({ state: sim.state, map, nation, rates: nationRates(sim.state, map, nation), random: () => random });

describe('Besatzung nach dem Aufteilen', () => {
  const setup = () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const to = map.provinces[berlin].neighbors.find((n) => sim.state.provinces[n].owner === 'DE')!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== berlin);
    const army: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { infantry: 10, artillery: 1 }, morale: 1 };
    sim.state.armies.push(army);
    return { sim, berlin, to, army };
  };
  const infantryAt = (sim: Simulation, node: number) =>
    sim.state.armies.filter((a) => a.node === node && !a.move).reduce((t, a) => t + (a.units.infantry ?? 0), 0);

  it('zieht alle Infanterie ab und nur Artillerie bliebe, bleibt ein Infanterist als Besatzung', () => {
    const { sim, berlin, to, army } = setup();
    const r = sim.apply('DE', { type: 'split', army: army.id, units: { infantry: 10 } });
    if (!r.ok) throw new Error(r.error);
    expect(r.ok).toBe(true);
    expect(sim.apply('DE', { type: 'move', army: r.army!, to }).ok).toBe(true);
    expect(infantryAt(sim, berlin)).toBe(1);
    expect(army.units).toEqual({ artillery: 1 });
    expect(unitCount(sim.state.armies.find((a) => a.id === r.army)!)).toBe(9);
  });

  it('der letzte Infanterist neben reiner Artillerie darf die Stadt nicht verlassen', () => {
    const { sim, to, army } = setup();
    army.units = { infantry: 1, artillery: 1 };
    const r = sim.apply('DE', { type: 'split', army: army.id, units: { infantry: 1 } });
    if (!r.ok) throw new Error(r.error);
    expect(sim.apply('DE', { type: 'move', army: r.army!, to }).ok).toBe(false);
  });

  it('die Artillerie darf abziehen, solange Infanterie in der Stadt bleibt', () => {
    const { sim, berlin, to, army } = setup();
    const r = sim.apply('DE', { type: 'split', army: army.id, units: { artillery: 1 } });
    if (!r.ok) throw new Error(r.error);
    expect(sim.apply('DE', { type: 'move', army: r.army!, to }).ok).toBe(true);
    expect(army.units).toEqual({ infantry: 10 });
    expect(infantryAt(sim, berlin)).toBe(10);
  });
});

describe('Besatzung unter Beschuss', () => {
  it('zieht eine eigene Armee gerade durch die Stadt, überlebt der letzte Mann der Besatzung trotzdem', () => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const berlin = prov('Berlin'), danzig = prov('Danzig'), hamburg = prov('Hamburg');
    sim.state.armies = sim.state.armies.filter((a) => ![berlin, danzig, hamburg].includes(a.node));
    const garrison: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { infantry: 1 }, morale: 1 };
    const passing: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: danzig, units: { infantry: 30 }, morale: 1 };
    sim.state.armies.push(garrison, passing);
    expect(sim.apply('DE', { type: 'move', army: passing.id, to: hamburg }).ok).toBe(true);
    // bis die Armee auf dem Weg durch Berlin ist (Ankerknoten Berlin, noch im Marsch)
    for (let h = 0; h < 48 && !(passing.move && passing.node === berlin); h++) sim.advance(HOUR);
    expect(passing.move && passing.node === berlin).toBeTruthy();
    // starke Batterie dicht vor Berlin, Ziel: die Besatzung
    const other = map.provinces[berlin].neighbors.find((n) => n !== danzig && n !== hamburg)!;
    const f = Math.max(0.05, 1 - 30 / distanceKm(map, berlin, other));
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'FR', node: berlin, pos: { a: other, b: berlin, f }, units: { artillery: 40 }, morale: 1, target: garrison.id });
    for (let k = 0; k < 3; k++) rangedRound(sim.ctx);
    expect(sim.state.armies.includes(garrison)).toBe(true);
    expect(garrison.units.infantry).toBe(1);
  });
});

describe('KI unter Beschuss', () => {
  /** deutsche Grenzprovinz mit französischem Nachbarn, Geschütze auf dem Weg dazwischen in Schussweite */
  const setup = (escort: number) => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    let pair: [number, number] | null = null;
    for (const p of map.provinces) {
      if (p.nation !== 'DE' || pair) continue;
      const q = (p.links ?? []).find((n) => map.provinces[n].nation === 'FR' && distanceKm(map, p.id, n) > 80);
      if (q !== undefined) pair = [p.id, q];
    }
    const [p, q] = pair!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p && a.node !== q);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 40 }, morale: 1 };
    // Geschütze 40 km vor der deutschen Stadt: der nähere Knoten ist die deutsche Provinz
    const f = 1 - 40 / distanceKm(map, p, q);
    const guns: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: p, pos: { a: q, b: p, f }, units: { artillery: 6 }, morale: 1, target: de.id };
    sim.state.armies.push(de, guns);
    if (escort) sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'FR', node: p, pos: { a: q, b: p, f }, units: { infantry: escort }, morale: 1, keepApart: true });
    return { sim, p, de, guns };
  };

  it('schwach gedeckte Geschütze werden angegriffen', () => {
    const { sim, de, guns } = setup(0);
    const acts = decide(sim, 'DE');
    expect(acts).toContainEqual({ type: 'attack', army: de.id, target: guns.id });
  });

  it('zu stark gedeckte Geschütze: Rückzug aus der Reichweite statt Stehenbleiben', () => {
    const { sim, de, guns } = setup(200);
    const acts = decide(sim, 'DE');
    expect(acts.some((a) => a.type === 'attack' && a.army === de.id)).toBe(false);
    const move = acts.find((a) => a.type === 'move' && a.army === de.id);
    expect(move).toBeTruthy();
    if (move?.type !== 'move') return;
    const [gx, gy] = armyPosition(map, guns, sim.state.time);
    const [cx, cy] = map.provinces[move.to].center;
    expect(Math.hypot(cx - gx, cy - gy)).toBeGreaterThan(60);
  });
});

describe('KI: liegengebliebene Armeen', () => {
  it('eine Armee, die nach einem Gefecht auf einem Weg steht, bekommt einen neuen Befehl (Krieg)', () => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const berlin = prov('Berlin');
    const to = map.provinces[berlin].neighbors.find((n) => sim.state.provinces[n].owner === 'DE')!;
    const stray: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: to, pos: { a: berlin, b: to, f: 0.6 }, units: { infantry: 15 }, morale: 1 };
    sim.state.armies.push(stray);
    expect(decide(sim, 'DE').some((a) => a.type === 'move' && a.army === stray.id)).toBe(true);
  });

  it('auch im Frieden kehrt sie in eine Stadt zurück', () => {
    const sim = newSim(1);
    const berlin = prov('Berlin');
    const to = map.provinces[berlin].neighbors.find((n) => sim.state.provinces[n].owner === 'DE')!;
    const stray: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: to, pos: { a: berlin, b: to, f: 0.6 }, units: { infantry: 15 }, morale: 1 };
    sim.state.armies.push(stray);
    expect(decide(sim, 'DE')).toContainEqual({ type: 'move', army: stray.id, to });
  });

  /** deutsche Armee in einer Stadt des Verbündeten Österreich */
  const allied = (day: number) => {
    const sim = newSim(day);
    setRelation(sim.state, 'DE', 'AU', 'sharedMap');
    const prag = prov('Prag');
    const stray: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: prag, units: { infantry: 4 }, morale: 1 };
    sim.state.armies.push(stray);
    return { sim, stray };
  };

  it('eine Armee in einer verbündeten Stadt bleibt im Krieg nicht ewig stehen', () => {
    const { sim, stray } = allied(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    expect(decide(sim, 'DE').some((a) => a.type === 'move' && a.army === stray.id)).toBe(true);
  });

  it('im Frieden kehrt eine Armee aus einer verbündeten Stadt in eine eigene Provinz zurück', () => {
    const { sim, stray } = allied(1);
    const move = decide(sim, 'DE').find((a) => a.type === 'move' && a.army === stray.id);
    expect(move).toBeTruthy();
    if (move?.type !== 'move') return;
    expect(sim.state.provinces[move.to].owner).toBe('DE');
  });
});

describe('KI: Hinterland', () => {
  /** deutsche Provinz ohne fremde Nachbarn (nicht die Hauptstadt) mit `n` Infanteristen, Krieg gegen Frankreich */
  const setup = (n: number) => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const p = map.provinces.find((x) => x.nation === 'DE' && !x.capital
      && x.neighbors.every((k) => map.provinces[k].nation === 'DE'))!.id;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p);
    const army: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: n }, morale: 1 };
    sim.state.armies.push(army);
    return { sim, army };
  };

  it('nur eine Einheit bleibt als Besatzung, der Rest zieht an die Front', () => {
    const { sim, army } = setup(8);
    const acts = decide(sim, 'DE');
    expect(acts).toContainEqual({ type: 'split', army: army.id, units: { infantry: 1 } });
    const move = acts.find((a) => a.type === 'move' && a.army === army.id);
    expect(move).toBeTruthy();
  });

  it('auch eine einzelne überzählige Einheit wird frei', () => {
    const { sim, army } = setup(2);
    const acts = decide(sim, 'DE');
    expect(acts).toContainEqual({ type: 'split', army: army.id, units: { infantry: 1 } });
    expect(acts.some((a) => a.type === 'move' && a.army === army.id)).toBe(true);
  });
});

describe('KI: Inselnationen', () => {
  it('Großbritannien (ohne Landgrenze) sucht sich ein Kriegsziel über See', () => {
    const sim = newSim(8);
    const london = prov('London');
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'GB', node: london, units: { infantry: 400 }, morale: 1 });
    const war = decide(sim, 'GB', 0.001).find((a) => a.type === 'declareWar');
    expect(war).toBeTruthy();
  });

  it('zu schwach für eine Landung allein: sammelt im Küstenhafen nahe dem Ziel statt untätig zu bleiben', () => {
    const sim = newSim(8);
    sim.apply('GB', { type: 'declareWar', nation: 'FR' });
    const gbProvs = map.provinces.filter((p) => p.nation === 'GB').map((p) => p.id);
    sim.state.armies = sim.state.armies.filter((a) => a.owner !== 'GB');
    // je Provinz eine kleine Armee: allein reicht keine für eine Landung
    for (const k of gbProvs) sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'GB', node: k, units: { infantry: 12 }, morale: 1 });
    const moves = decide(sim, 'GB').filter((a) => a.type === 'move');
    expect(moves.length).toBeGreaterThan(0);
    const targets = new Set(moves.map((a) => (a.type === 'move' ? a.to : -1)));
    // alle ziehen an denselben Sammelpunkt (eine eigene Küstenprovinz)
    expect(targets.size).toBeLessThanOrEqual(2);
    for (const t of targets) expect(sim.state.provinces[t].owner).toBe('GB');
  });
});
