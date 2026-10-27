import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILDINGS, DAY, PROVINCE } from '../src/game/balance.ts';
import { allRates, defaultConsumption, netRate, provinceOutput, toShares, type NationRates } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));

function newSim() {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  return new Simulation(state, map);
}

describe('Geld und Unterhalt', () => {
  it('Geld: 1600 je Provinz bei 100 % Moral, Doppelprovinz das Doppelte; Rohstoff 3150', () => {
    const sim = newSim();
    const single = map.provinces.find((p) => !p.double)!, double = map.provinces.find((p) => p.double)!;
    const ps = { ...sim.state.provinces[single.id], morale: 1, buildings: { ...sim.state.provinces[single.id].buildings, railroad: 0, harbor: 0, factory: 0, manufactory: 0 } };
    expect(provinceOutput(map, ps, single.id).money).toBe(1600);
    expect(provinceOutput(map, ps, single.id).amount).toBe(3150);
    expect(provinceOutput(map, { ...sim.state.provinces[double.id], morale: 1 }, double.id).money).toBe(3200);
  });

  it('Provinzunterhalt 800 je Kategorie, Eisenbahn 500 Kohle', () => {
    const sim = newSim();
    const own = sim.state.provinces.filter((p) => p.owner === 'DE').length;
    const r = allRates(sim.state, map).DE;
    expect(r.upkeep).toBe(own * PROVINCE.upkeep);
    expect(BUILDINGS.railroad.upkeep?.coal).toBe(500);
    // Infanterie verbraucht fest Getreide
    const infantry = sim.state.armies.filter((a) => a.owner === 'DE').reduce((t, a) => t + (a.units.infantry ?? 0), 0);
    expect(r.cons.grain).toBe(infantry * 18);
  });
});

describe('Verbrauchsregler', () => {
  it('Startwerte je Kategorie anteilig zur eigenen Produktion, Summe 100', () => {
    const c = defaultConsumption(map, 'DE');
    expect(c.grain + c.fish).toBe(100);
    expect(c.iron + c.lumber).toBe(100);
    expect(c.coal + c.oil + c.gas).toBe(100);
    expect(toShares('energy', {})).toEqual({ coal: 34, oil: 33, gas: 33 });
  });

  it('verteilt den Provinzunterhalt nach Regler; 0 % wird nicht angetastet', () => {
    const sim = newSim();
    expect(sim.apply('DE', { type: 'setConsumption', category: 'energy', shares: { gas: 70, coal: 30, oil: 0 } }).ok).toBe(true);
    expect(sim.apply('DE', { type: 'setConsumption', category: 'food', shares: { fish: 80, grain: 20 } }).ok).toBe(true);
    const r = sim.rates.DE;
    const upkeep = r.upkeep;
    expect(netRate(r, 'oil')).toBeCloseTo(r.prod.oil - r.cons.oil, 6);
    expect(netRate(r, 'gas')).toBeCloseTo(r.prod.gas - r.cons.gas - upkeep * 0.7, 6);
    const st = sim.state.nations.DE.stock;
    const oil0 = st.oil, gas0 = st.gas;
    sim.advance(DAY / 2);
    expect(st.oil).toBeCloseTo(oil0 + (r.prod.oil - r.cons.oil) / 2, 0);
    expect(st.gas).toBeLessThan(gas0 + r.prod.gas / 2);
  });

  it('stur: fehlt ein Rohstoff, springen die anderen nicht ein – Engpass', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'setConsumption', category: 'materials', shares: { iron: 50, lumber: 50 } });
    const st = sim.state.nations.DE.stock;
    st.lumber = 0;
    sim.state.provinces.forEach((ps, i) => { if (ps.owner === 'DE' && map.provinces[i].resource === 'lumber') ps.morale = 0.05; });
    sim.invalidate();
    sim.advance(60_000);
    const r = sim.rates.DE;
    const iron0 = st.iron;
    sim.advance(DAY / 4);
    expect(sim.state.nations.DE.shortage.materials).toBe(true);
    // Eisen trägt nur seine 50 %, auch wenn Holz fehlt
    const usual = (r.prod.iron - r.cons.iron - r.upkeep * 0.5) / 4;
    expect(st.iron - iron0).toBeCloseTo(usual, -1);
  });

  it('lehnt ungültige Verteilungen ab', () => {
    const sim = newSim();
    expect(sim.apply('DE', { type: 'setConsumption', category: 'food', shares: { grain: 60, fish: 30 } }).ok).toBe(false);
    expect(sim.apply('DE', { type: 'setConsumption', category: 'food', shares: { grain: 50, coal: 50 } }).ok).toBe(false);
  });
});

describe('Fokus der Verbrauchsregler', () => {
  it('die anderen Rohstoffe tragen, was ihr Überschuss hergibt; der Fokus nur den Rest', async () => {
    const { focusShares } = await import('../src/game/economy.ts');
    const zero = { grain: 0, fish: 0, iron: 0, lumber: 0, coal: 0, oil: 0, gas: 0 };
    const r = (prod: Record<string, number>, cons: Record<string, number> = {}) => ({ prod: { ...zero, ...prod }, cons: { ...zero, ...cons }, upkeep: 1000, shares: {} }) as never;
    // Fisch kann 600 tragen: Fisch 60 %, Getreide (Fokus) 40 %
    expect(focusShares('food', 'grain', r({ grain: 5000, fish: 600 }))).toEqual({ fish: 60, grain: 40 });
    // Fisch kann alles tragen: Getreide 0 %
    expect(focusShares('food', 'grain', r({ grain: 5000, fish: 3000 }))).toEqual({ fish: 100, grain: 0 });
    // fester Verbrauch zählt: 900 Fisch, 500 davon schon verbraucht → 40 %
    expect(focusShares('food', 'grain', r({ grain: 5000, fish: 900 }, { fish: 500 }))).toEqual({ fish: 40, grain: 60 });
    // Energie: Kohle im Fokus, Öl und Gas anteilig zu ihrem Überschuss (abgerundet)
    expect(focusShares('energy', 'coal', r({ coal: 9000, oil: 300, gas: 300 }))).toEqual({ oil: 30, gas: 30, coal: 40 });
    // Kohle und Gas tragen zusammen alles: Öl (Fokus) 0 %, kein Rundungsrest von 1 %
    expect(focusShares('energy', 'oil', r({ coal: 2000, gas: 1000, oil: 500 }))).toEqual({ coal: 67, gas: 33, oil: 0 });
    // der Rundungsrest geht nur an einen Rohstoff, dessen Überschuss ihn trägt (Gas 33,3 % → höchstens 33)
    expect(focusShares('energy', 'oil', r({ coal: 334, gas: 333 }))).toEqual({ coal: 33, gas: 33, oil: 34 });
  });

  it('die Simulation stellt den Regler mit Fokus selbst ein; ohne Fokus gilt wieder die Hand', () => {
    const sim = newSim();
    const n = sim.state.nations.DE;
    expect(sim.apply('DE', { type: 'setConsumptionFocus', category: 'food', resource: 'fish' }).ok).toBe(true);
    expect(sim.apply('DE', { type: 'setConsumptionFocus', category: 'food', resource: 'coal' }).ok).toBe(false);
    const r = sim.rates.DE;
    const want = focusSharesOf(r);
    expect(n.consumption.grain).toBe(want.grain);
    expect(n.consumption.fish).toBe(want.fish);
    expect(sim.apply('DE', { type: 'setConsumptionFocus', category: 'food', resource: null }).ok).toBe(true);
    expect(n.consumptionFocus).toBeUndefined();
    expect(sim.apply('DE', { type: 'setConsumption', category: 'food', shares: { grain: 50, fish: 50 } }).ok).toBe(true);
    sim.advance(2 * 60 * 60_000);
    expect(n.consumption.grain).toBe(50);
  });
});

function focusSharesOf(r: NationRates) {
  const avail = Math.max(0, r.prod.grain - r.cons.grain);
  const grain = Math.floor(Math.min(1, avail / r.upkeep) * 100);
  return { grain, fish: 100 - grain };
}
