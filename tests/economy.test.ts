import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILDINGS, DAY, PROVINCE } from '../src/game/balance.ts';
import { allRates, defaultConsumption, netRate, provinceOutput, toShares } from '../src/game/economy.ts';
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
