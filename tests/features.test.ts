import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_RES, DAY, HOUR, MORALE } from '../src/game/balance.ts';
import { conquer } from '../src/game/military.ts';
import { capitalOf, moraleTarget, nationRates, recruitHours, totalUse, useSources } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { segmentHours } from '../src/game/military.ts';
import { armyName } from '../src/game/names.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;
function newSim() {
  const state = createGame(map, { id: 't', name: 'Test', playerNation: 'DE', speed: 1, seed: 5, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  return new Simulation(state, map);
}

describe('Abschaltbare Gebäude', () => {
  it('abgeschaltete Kaserne kostet kein Getreide und rekrutiert nicht schneller', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const ps = sim.state.provinces[berlin];
    ps.buildings.barracks = 2;
    ps.buildings.recruitment = 1;
    const on = nationRates(sim.state, map, 'DE').cons.grain;
    const fast = recruitHours(ps)!;
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'barracks', on: false }).ok).toBe(true);
    expect(nationRates(sim.state, map, 'DE').cons.grain).toBe(on - 2000);
    expect(recruitHours(ps)!).toBeGreaterThan(fast);
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'barracks', on: true }).ok).toBe(true);
    expect(nationRates(sim.state, map, 'DE').cons.grain).toBe(on);
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'fortress', on: false }).ok).toBe(false);
  });

  it('abgeschaltete Eisenbahn: kein Kohleunterhalt, kein Tempo- und Produktionsbonus', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const ps = sim.state.provinces[berlin];
    ps.buildings.railroad = 1;
    const n = map.provinces[berlin].links!.find((x) => map.provinces[x].nation === 'DE')!;
    const a: Army = { id: 999, owner: 'DE', node: berlin, units: { infantry: 1 } };
    const fast = segmentHours(sim.state, map, a, berlin, n);
    const coal = nationRates(sim.state, map, 'DE').cons.coal;
    const prod = nationRates(sim.state, map, 'DE').prod[map.provinces[berlin].resource];
    sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'railroad', on: false });
    expect(segmentHours(sim.state, map, a, berlin, n)).toBeGreaterThan(fast);
    expect(nationRates(sim.state, map, 'DE').cons.coal).toBe(coal - 500);
    expect(nationRates(sim.state, map, 'DE').prod[map.provinces[berlin].resource]).toBeLessThan(prod);
  });
});

describe('Verbrauch nach Verursachern', () => {
  it('die Quellen ergeben zusammen den Gesamtverbrauch; Einheiten je Typ zusammengefasst', () => {
    const sim = newSim();
    sim.state.provinces[prov('Berlin')].buildings.barracks = 1;
    const src = useSources(sim.state, map, 'DE');
    const r = nationRates(sim.state, map, 'DE');
    for (const res of ALL_RES) expect(src[res].reduce((s, x) => s + x.amount, 0)).toBeCloseTo(totalUse(r, res), 6);
    expect(src.grain.filter((s) => s.label.startsWith('Infanterie'))).toHaveLength(1);
    expect(src.grain.some((s) => s.label.startsWith('Kaserne'))).toBe(true);
  });
});

describe('Moral, Abschüsse, Namen', () => {
  it('Kämpfe in der Provinz senken das Moralziel bis zum Tageswechsel', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const before = moraleTarget(sim.state, map, berlin).target;
    sim.state.provinces[berlin].fought = true;
    const mt = moraleTarget(sim.state, map, berlin);
    expect(mt.parts.some((p) => p.label === 'Kämpfe in der Provinz')).toBe(true);
    expect(mt.target).toBeCloseTo(Math.max(MORALE.min, before - MORALE.battle), 6);
    sim.advance(DAY);
    expect(sim.state.provinces[berlin].fought).toBeUndefined();
  });

  it('Armeen zählen Abschüsse; Schlachtschiffe bekommen Namen und lassen sich umbenennen', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'DK' });
    const target = map.provinces.find((p) => p.nation === 'DK' && p.neighbors.some((n) => map.provinces[n].nation === 'DE'))!;
    const from = target.neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== target.id && a.node !== from);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: target.id, units: { infantry: 40 } };
    const dk: Army = { id: sim.state.nextArmyId++, owner: 'DK', node: target.id, units: { infantry: 5 } };
    sim.state.armies.push(de, dk);
    sim.advance(6 * HOUR);
    expect(de.kills ?? 0).toBeGreaterThan(0);

    const kiel = map.provinces.find((p) => p.nation === 'DE' && p.coastal)!.id;
    sim.spawn(kiel, 'DE', 'battleship', 1);
    const ship = sim.state.armies.find((a) => a.owner === 'DE' && a.units.battleship)!;
    expect(ship.name).toMatch(/^SMS /);
    expect(armyName(ship)).toBe(ship.name);
    expect(sim.apply('DE', { type: 'rename', army: ship.id, name: 'SMS Testschiff' }).ok).toBe(true);
    expect(armyName(ship)).toBe('SMS Testschiff');
    sim.apply('DE', { type: 'rename', army: ship.id, name: '' });
    expect(ship.name).toBeUndefined();
  });
});

describe('Provinzmoral und Hauptstadt', () => {
  it('Moralziel: Grundwert 100 %, kein Hauptstadtbonus, Entfernung 1 % je 100 km, Unruhe der Nachbarn −2 %', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const cap = moraleTarget(sim.state, map, berlin);
    expect(cap.parts[0]).toEqual({ label: 'Grundwert', value: 1 });
    expect(cap.parts.some((p) => p.label === 'Hauptstadt')).toBe(false);
    const far = map.provinces.filter((p) => p.nation === 'DE' && !p.capital)
      .map((p) => ({ p, d: Math.hypot(p.center[0] - map.provinces[berlin].center[0], p.center[1] - map.provinces[berlin].center[1]) }))
      .sort((x, y) => y.d - x.d)[0];
    const dist = moraleTarget(sim.state, map, far.p.id).parts.find((x) => x.label === 'Entfernung zur Hauptstadt');
    if (far.d > MORALE.distanceFree) expect(dist!.value).toBeCloseTo(-Math.min(MORALE.distanceMax, ((far.d - MORALE.distanceFree) / 100) * 0.01), 6);
    const n = map.provinces[berlin].neighbors.find((x) => map.provinces[x].nation === 'DE')!;
    sim.state.provinces[n].morale = 0.2;
    expect(moraleTarget(sim.state, map, berlin).parts.find((p) => p.label.startsWith('Unruhe'))!.value).toBeCloseTo(-0.02, 9);
  });

  it('Moral ändert sich je Tag um höchstens 10 Prozentpunkte', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    sim.state.provinces[berlin].morale = 0.2;
    sim.advance(DAY);
    expect(sim.state.provinces[berlin].morale).toBeCloseTo(0.3, 9);
  });

  it('eroberte Provinzen starten bei 25 %, Rückeroberung am selben Tag bei 40 %', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'DK' });
    const t = map.provinces.find((p) => p.nation === 'DK' && !p.capital)!.id;
    const ps = sim.state.provinces[t];
    ps.morale = 0.9;
    conquer(sim.ctx, t, 'DE');
    expect(ps.morale).toBe(0.25);
    conquer(sim.ctx, t, 'DK');
    expect(ps.morale).toBe(0.4);
  });

  it('Hauptstadt verlegen: kostet, dauert 48 h, nur eine Verlegung gleichzeitig; Abbruch erstattet die Hälfte', () => {
    const sim = newSim();
    const target = prov('Hamburg'), other = map.provinces.find((p) => p.nation === 'DE' && !p.capital && p.id !== target)!.id;
    const stock = sim.state.nations.DE.stock;
    Object.assign(stock, { money: 50000, lumber: 20000, iron: 20000, grain: 20000, coal: 20000 });
    const money = stock.money;
    expect(sim.apply('DE', { type: 'moveCapital', province: target }).ok).toBe(true);
    expect(stock.money).toBe(money - 20000);
    expect(sim.apply('DE', { type: 'moveCapital', province: other }).ok).toBe(false);
    sim.advance(47 * HOUR);
    expect(capitalOf(sim.state, map, 'DE')).toBe(prov('Berlin'));
    sim.advance(2 * HOUR);
    expect(capitalOf(sim.state, map, 'DE')).toBe(target);
    expect(moraleTarget(sim.state, map, target).parts.some((p) => p.label === 'Entfernung zur Hauptstadt')).toBe(false);
    // Abbruch
    expect(sim.apply('DE', { type: 'moveCapital', province: other }).ok).toBe(true);
    const before = stock.money;
    expect(sim.apply('DE', { type: 'cancelCapitalMove' }).ok).toBe(true);
    expect(stock.money).toBe(before + 10000);
  });
});

describe('Untergang einer Nation', () => {
  it('Angebote der untergegangenen Nation (diplomatisch und an der Börse) verschwinden', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'MN' });
    sim.state.proposals.push({ from: 'MN', to: 'DE', kind: 'peace', time: 0 }, { from: 'FR', to: 'MN', kind: 'peace', time: 0 }, { from: 'FR', to: 'DE', kind: 'peace', time: 0 });
    sim.state.market.offers.push({ id: 900, nation: 'MN', side: 'sell', res: 'grain', amount: 100, price: 1, time: 0 });
    for (const [i, p] of sim.state.provinces.entries()) if (p.owner === 'MN') conquer(sim.ctx, i, 'DE');
    expect(sim.state.nations.MN.alive).toBe(false);
    expect(sim.state.proposals).toEqual([{ from: 'FR', to: 'DE', kind: 'peace', time: 0 }]);
    expect(sim.state.market.offers.some((o) => o.nation === 'MN')).toBe(false);
  });
});
