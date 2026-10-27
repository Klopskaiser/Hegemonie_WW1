import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBuild, unitHours } from '../src/game/actions.ts';
import { BUILDINGS, buildingLives, DAY, HOUR } from '../src/game/balance.ts';
import { allRates, provinceOutput } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const berlin = map.provinces.find((p) => p.name === 'Berlin')!.id;

function newSim() {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  for (const r of Object.keys(state.nations.DE.stock) as (keyof typeof state.nations.DE.stock)[]) state.nations.DE.stock[r] = 200000;
  // Eisenbahn, Fabrik und Hafen sind erst ab Tag 3 baubar
  state.time = 2 * DAY;
  return new Simulation(state, map);
}

describe('Bauschleife', () => {
  it('plant weitere Gebäude ein und baut sie nacheinander', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    ps.buildings.workshop = 1; // Voraussetzung für die Fabrik
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'railroad' }).ok).toBe(true);
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'factory' }).ok).toBe(true);
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'factory' }).ok).toBe(true);
    expect(ps.construction?.building).toBe('railroad');
    expect(ps.buildQueue).toEqual(['factory', 'factory']);
    // bezahlt wird erst beim Start
    expect(checkBuild(sim.state, map, 'DE', berlin, 'factory').level).toBe(3);
    sim.advance((72 + 48 + 48) * HOUR + HOUR);
    expect(ps.buildings.railroad).toBe(1);
    expect(ps.buildings.factory).toBe(2);
    expect(ps.buildQueue).toEqual([]);
  });

  it('Voraussetzungen zählen geplante Gebäude mit; entfernte Einträge lassen Folgebauten entfallen', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    ps.buildings.recruitment = 0;
    sim.apply('DE', { type: 'build', province: berlin, building: 'railroad' });
    expect(checkBuild(sim.state, map, 'DE', berlin, 'barracks').ok).toBe(false);
    sim.apply('DE', { type: 'build', province: berlin, building: 'recruitment' });
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'barracks' }).ok).toBe(true);
    sim.apply('DE', { type: 'dequeueBuild', province: berlin, index: 0 });
    sim.advance(73 * HOUR);
    expect(ps.buildQueue).toEqual([]);
    expect(ps.construction).toBeNull();
    expect(sim.state.events.some((e) => /entfällt/.test(e.text))).toBe(true);
  });

  it('wartet auf Rohstoffe und startet, sobald sie reichen', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    sim.apply('DE', { type: 'build', province: berlin, building: 'railroad' });
    sim.apply('DE', { type: 'build', province: berlin, building: 'office' });
    sim.advance(71 * HOUR);
    sim.state.nations.DE.stock.money = 0;
    sim.advance(2 * HOUR);
    expect(ps.construction).toBeNull();
    expect(ps.buildQueue).toEqual(['office']);
    sim.state.nations.DE.stock.money = 100000;
    sim.advance(HOUR);
    expect(ps.construction?.building).toBe('office');
  });
});

describe('Bauamt und Manufaktur', () => {
  it('Bauamt verkürzt Bauzeiten der Provinz um 25 % und kostet 2000 Geld am Tag', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    expect(checkBuild(sim.state, map, 'DE', berlin, 'railroad').hours).toBe(72);
    ps.buildings.office = 1;
    expect(checkBuild(sim.state, map, 'DE', berlin, 'railroad').hours).toBe(54);
    expect(BUILDINGS.office.hours(1)).toBe(48);
    expect(BUILDINGS.office.cost(1)).toEqual({ money: 30000, lumber: 500 });
    // Unterhalt: das Bauamt kostet 2000 Geld zusätzlich (Wehrämter und Kasernen kosten eigenes Geld)
    ps.buildings.office = 0;
    const without = allRates(sim.state, map).DE.cons.money;
    ps.buildings.office = 1;
    expect(allRates(sim.state, map).DE.cons.money - without).toBe(2000);
    // Moral +2 % für die Provinz
    expect(BUILDINGS.office.morale(1)).toBeCloseTo(0.02, 9);
  });

  it('Manufaktur: +11 % Rohstoffe je Stufe, nicht Geld; schließt Fabrik aus und stellt keine Einheiten her', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    const before = provinceOutput(map, ps, berlin);
    ps.buildings.manufactory = 3;
    const after = provinceOutput(map, ps, berlin);
    expect(after.amount / before.amount).toBeCloseTo(1.33, 6);
    expect(after.money).toBe(before.money);
    expect(checkBuild(sim.state, map, 'DE', berlin, 'factory').ok).toBe(false);
    expect(sim.apply('DE', { type: 'enqueue', province: berlin, unit: 'artillery' }).ok).toBe(false);
    ps.buildings.manufactory = 0;
    ps.buildings.factory = 1;
    expect(checkBuild(sim.state, map, 'DE', berlin, 'manufactory').ok).toBe(false);
  });

  it('Werkstatt: Voraussetzung für die Fabrik, Fertigung 10 % schneller, Moral +1 %; Bauamt abschaltbar', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    expect(BUILDINGS.workshop.cost(1)).toEqual({ money: 5000, iron: 1500, lumber: 500 });
    expect(checkBuild(sim.state, map, 'DE', berlin, 'factory').error).toBe('Benötigt Werkstatt');
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'workshop' }).ok).toBe(true);
    // geplante Werkstatt reicht für die Bauschleife
    expect(checkBuild(sim.state, map, 'DE', berlin, 'factory').ok).toBe(true);
    ps.construction = null;
    ps.buildQueue = [];
    ps.buildings.factory = 1;
    const slow = unitHours(sim.state, berlin, 'artillery');
    ps.buildings.workshop = 1;
    expect(unitHours(sim.state, berlin, 'artillery')).toBeCloseTo(slow / 1.1, 6);
    expect(BUILDINGS.workshop.morale(1)).toBeCloseTo(0.01, 9);
    ps.buildings.office = 1;
    const on = allRates(sim.state, map).DE.cons.money;
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'office', on: false }).ok).toBe(true);
    // abgeschaltet: kein Unterhalt, keine Verkürzung
    expect(on - allRates(sim.state, map).DE.cons.money).toBe(2000);
    expect(checkBuild(sim.state, map, 'DE', berlin, 'railroad').hours).toBe(72);
    expect(BUILDINGS.workshop.hours(1)).toBe(24);
  });

  it('Handelsposten: nur ohne Küste, Rohstoffe +7 %, Moral +3 %, Unterhalt 20 Fisch', () => {
    const sim = newSim();
    const inland = map.provinces.find((p) => p.nation === 'DE' && !p.coastal)!.id;
    const coast = map.provinces.find((p) => p.nation === 'DE' && p.coastal)!.id;
    expect(BUILDINGS.tradepost.cost(1)).toEqual({ money: 12000, iron: 500, lumber: 2500 });
    expect(checkBuild(sim.state, map, 'DE', coast, 'tradepost').error).toBe('Nur in Provinzen ohne Küste');
    expect(checkBuild(sim.state, map, 'DE', inland, 'tradepost').ok).toBe(true);
    const ps = sim.state.provinces[inland];
    const before = provinceOutput(map, ps, inland);
    const fish = allRates(sim.state, map).DE.cons.fish;
    ps.buildings.tradepost = 1;
    const after = provinceOutput(map, ps, inland);
    expect(after.amount / before.amount).toBeCloseTo(1.07, 6);
    expect(after.money).toBe(before.money);
    expect(allRates(sim.state, map).DE.cons.fish - fish).toBe(20);
    expect(BUILDINGS.tradepost.morale(1)).toBeCloseTo(0.03, 9);
  });

  it('auch geplante Fabriken schließen die Manufaktur aus', () => {
    const sim = newSim();
    sim.state.provinces[berlin].buildings.workshop = 1;
    sim.apply('DE', { type: 'build', province: berlin, building: 'railroad' });
    sim.apply('DE', { type: 'build', province: berlin, building: 'factory' });
    expect(checkBuild(sim.state, map, 'DE', berlin, 'manufactory').ok).toBe(false);
  });
});

describe('Leben der Gebäude', () => {
  it('Wehramt, Bauamt, Handelsposten, Werkstatt und Festung haben ein Leben, Eisenbahn und Hafen drei, sonst zwei', () => {
    for (const b of ['recruitment', 'office', 'tradepost', 'workshop', 'fortress'] as const) expect(buildingLives(b), b).toBe(1);
    expect(buildingLives('railroad')).toBe(3);
    expect(buildingLives('harbor')).toBe(3);
    expect(buildingLives('factory')).toBe(2);
  });
});
