// Tests zu Vorgaben des Auftraggebers: Panzerwagen, Zeitung (Verluste, nur Krieg und Frieden), kostenlose
// Hauptstadtverlegung nach Verlust, Verbrauchsregler der KI.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPITAL_MOVE, DAY, UNITS } from '../src/game/balance.ts';
import { BasicAI } from '../src/game/ai.ts';
import { checkCapitalMove } from '../src/game/actions.ts';
import { activeCapital, nationRates, type NationRates } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { combatRound, unitCount } from '../src/game/military.ts';
import { publishNewspaper } from '../src/game/newspaper.ts';
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

const decide = (sim: Simulation, nation: string, rates?: NationRates): Action[] =>
  new BasicAI().decide({ state: sim.state, map, nation, rates: rates ?? nationRates(sim.state, map, nation), random: () => 0.5 });

describe('Panzerwagen', () => {
  it('kostet 1000 Eisen und 1000 Öl und braucht doppelt so lange (32 h)', () => {
    expect(UNITS.armoredCar.cost.iron).toBe(1000);
    expect(UNITS.armoredCar.cost.oil).toBe(1000);
    expect(UNITS.armoredCar.hours).toBe(32);
  });
});

describe('Zeitung', () => {
  it('meldet die Verluste je Krieg als laufenden Zähler: je verlorene Einheit 1000 Mann', () => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const p = prov('Hamburg');
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 30, armoredCar: 2 }, morale: 1 };
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: p, units: { infantry: 30 }, morale: 1 };
    sim.state.armies.push(de, fr);
    for (let k = 0; k < 4; k++) combatRound(sim.ctx);
    const lostDe = 32 - (de.units.infantry ?? 0) - (de.units.armoredCar ?? 0);
    const lostFr = 30 - (fr.units.infantry ?? 0);
    expect(lostDe + lostFr).toBeGreaterThan(0);
    const paper = publishNewspaper(sim.state, map);
    const battle = paper.items.find((i) => i.kind === 'battle');
    expect(battle?.text).not.toContain('Bei Hamburg'); // keine Einzelschlachten
    expect(battle?.text).toContain('Krieg ');
    const fmt = (n: number) => String(n * 1000).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    if (lostDe) expect(battle!.text).toContain(`Deutsches Reich ${fmt(lostDe)}`);
    if (lostFr) expect(battle!.text).toContain(`${fmt(lostFr)} Mann`);
    // ohne neue Verluste keine Meldung; weitere Kämpfe zählen weiter (seit Kriegsbeginn)
    expect(publishNewspaper(sim.state, map).items.some((i) => i.kind === 'battle')).toBe(false);
    for (let k = 0; k < 4 && unitCount(de) && unitCount(fr); k++) combatRound(sim.ctx);
    const lostDe2 = 32 - (de.units.infantry ?? 0) - (de.units.armoredCar ?? 0);
    const lostFr2 = 30 - (fr.units.infantry ?? 0);
    if (lostDe2 + lostFr2 > lostDe + lostFr) {
      const again = publishNewspaper(sim.state, map).items.find((i) => i.kind === 'battle')!;
      if (lostDe2) expect(again.text).toContain(`Deutsches Reich ${fmt(lostDe2)}`);
    }
    // Frieden setzt den Zähler zurück
    sim.apply('DE', { type: 'propose', nation: 'FR', kind: 'peace' });
    sim.apply('FR', { type: 'answer', nation: 'DE', accept: true });
    expect(sim.state.warLosses?.['DE|FR']).toBeUndefined();
  });

  it('öffentlich sind nur Krieg und Frieden, nicht Durchmarschrecht, Bündnis, Embargo oder Herabstufung', () => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'propose', nation: 'AU', kind: 'rightOfWay' });
    sim.apply('AU', { type: 'answer', nation: 'DE', accept: true });
    sim.apply('DE', { type: 'downgrade', nation: 'IT', to: 'embargo' });
    sim.apply('DE', { type: 'downgrade', nation: 'AU', to: 'peace' });
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    sim.apply('DE', { type: 'propose', nation: 'FR', kind: 'peace', tribute: { money: 1000 } });
    sim.apply('FR', { type: 'answer', nation: 'DE', accept: true });
    const kinds = publishNewspaper(sim.state, map).items.map((i) => i.kind);
    expect(kinds).toContain('war');
    expect(kinds).toContain('peace');
    for (const k of ['agreement', 'embargo', 'downgrade'] as const) expect(kinds).not.toContain(k);
    const texts = sim.state.newspapers.at(-1)!.items.map((i) => i.text).join(' ');
    expect(texts).not.toContain('Tribut');
    // die Beteiligten erfahren es trotzdem
    expect(sim.state.events.some((e) => e.nation === 'IT' && /embargo/i.test(e.text))).toBe(true);
  });
});

describe('Hauptstadt verlegen nach Verlust', () => {
  const lose = () => {
    const sim = newSim(8);
    const berlin = activeCapital(sim.state, map, 'DE');
    sim.state.provinces[berlin].owner = 'FR';
    for (const k of Object.keys(sim.state.nations.DE.stock) as (keyof typeof sim.state.nations.DE.stock)[]) sim.state.nations.DE.stock[k] = 0;
    return sim;
  };

  it('ist kostenlos, wenn die Hauptstadt verloren ist (sonst volle Kosten)', () => {
    const sim = lose();
    const target = prov('Hamburg');
    expect(checkCapitalMove(sim.state, map, 'DE', target).ok).toBe(true);
    expect(sim.apply('DE', { type: 'moveCapital', province: target }).ok).toBe(true);
    // Abbruch erstattet nur, was gezahlt wurde: nichts
    expect(sim.apply('DE', { type: 'cancelCapitalMove' }).ok).toBe(true);
    expect(sim.state.nations.DE.stock.money).toBe(0);
    // mit gehaltener Hauptstadt kostet es weiter
    const normal = newSim(8);
    for (const k of Object.keys(normal.state.nations.DE.stock) as (keyof typeof normal.state.nations.DE.stock)[]) normal.state.nations.DE.stock[k] = 0;
    expect(checkCapitalMove(normal.state, map, 'DE', target).ok).toBe(false);
    expect(CAPITAL_MOVE.cost.money).toBeGreaterThan(0);
  });

  it('die KI verlegt sofort, auch mit leerer Kasse', () => {
    const sim = lose();
    expect(decide(sim, 'DE').some((a) => a.type === 'moveCapital')).toBe(true);
  });
});

describe('KI: Verbrauchsregler', () => {
  /** Lage mit vorgegebenen Tageswerten: Förderung, fester Verbrauch, Provinzunterhalt je Kategorie, Vorräte */
  const setup = (prod: Record<string, number>, stock: Record<string, number>, upkeep: number, cons: Record<string, number> = {}) => {
    const sim = newSim(8);
    const rates = nationRates(sim.state, map, 'DE');
    for (const r of ['grain', 'fish', 'iron', 'lumber', 'coal', 'oil', 'gas'] as const) {
      rates.prod[r] = prod[r] ?? 0;
      rates.cons[r] = cons[r] ?? 0;
      sim.state.nations.DE.stock[r] = stock[r] ?? 0;
    }
    rates.upkeep = upkeep;
    return { sim, rates };
  };
  const shares = (acts: Action[], cat: string) => {
    const a = acts.find((x) => x.type === 'setConsumption' && x.category === cat);
    return a?.type === 'setConsumption' ? a.shares : null;
  };

  it('Öl wird geschont: Kohle und Gas zahlen, solange sie reichen', () => {
    const { sim, rates } = setup({ coal: 6000, gas: 6000, oil: 6000 }, { coal: 5000, gas: 5000, oil: 5000 }, 9000);
    sim.state.nations.DE.consumption = { ...sim.state.nations.DE.consumption, coal: 34, oil: 33, gas: 33 };
    const s = shares(decide(sim, 'DE', rates), 'energy')!;
    expect(s.oil).toBe(0);
    expect(s.coal! + s.gas!).toBe(100);
  });

  it('kein Engpass trotz Vorrat: reicht Kohle nicht, springt Öl ein (Kategorie im Plus)', () => {
    const { sim, rates } = setup({ coal: 2000, oil: 9000 }, { coal: 0, oil: 3000 }, 6000);
    const s = shares(decide(sim, 'DE', rates), 'energy')!;
    // Kohle trägt höchstens ihre Förderung (≤ 33 %), Öl den Rest
    expect(s.coal!).toBeLessThanOrEqual(33);
    expect(s.oil!).toBeGreaterThanOrEqual(67);
  });

  it('sehr viel Öl: es zahlt mit', () => {
    const { sim, rates } = setup({ coal: 6000, oil: 0 }, { coal: 20000, oil: 300000 }, 6000);
    sim.state.nations.DE.consumption = { ...sim.state.nations.DE.consumption, coal: 100, oil: 0, gas: 0 };
    const s = shares(decide(sim, 'DE', rates), 'energy')!;
    expect(s.oil!).toBeGreaterThan(0);
  });

  it('Baustoffe im Minus, egal wie die Regler stehen: ein Rohstoff zahlt alles, der andere wird gesammelt', () => {
    const { sim, rates } = setup({ iron: 2000, lumber: 2000 }, { iron: 500, lumber: 500 }, 6000);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' }); // Krieg ohne Einkaufsliste: Eisen sammeln
    sim.state.nations.DE.consumption = { ...sim.state.nations.DE.consumption, iron: 50, lumber: 50 };
    const s = shares(decide(sim, 'DE', rates), 'materials')!;
    expect(s).toEqual({ iron: 0, lumber: 100 });
  });

  it('Nahrung im Minus: Getreide hat Vorrang, Fisch trägt den Provinzunterhalt', () => {
    const { sim, rates } = setup({ grain: 3000, fish: 2000 }, { grain: 4000, fish: 300 }, 6000, { grain: 2500 });
    sim.state.nations.DE.consumption = { ...sim.state.nations.DE.consumption, grain: 60, fish: 40 };
    const s = shares(decide(sim, 'DE', rates), 'food')!;
    expect(s).toEqual({ grain: 0, fish: 100 });
  });
});
