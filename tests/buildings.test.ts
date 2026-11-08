import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBuild, unitHours } from '../src/game/actions.ts';
import { BUILDINGS, buildingLives, DAY, HOUR } from '../src/game/balance.ts';
import { allRates, provinceOutput } from '../src/game/economy.ts';
import { repairMachines } from '../src/game/military.ts';
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

  it('geht während eines Ausbaus eine Stufe verloren, setzt der Bau nur eine Stufe auf den neuen Stand', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    ps.buildings.workshop = 1;
    ps.buildings.factory = 2;
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'factory' }).ok).toBe(true);
    expect(ps.construction?.level).toBe(3);
    ps.buildings.factory = 1; // Stufe 2 im Kampf zerstört
    sim.advanceTo(ps.construction!.end + HOUR);
    expect(ps.construction).toBeNull();
    expect(ps.buildings.factory).toBe(2);
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
    sim.advance(59 * HOUR);
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
    expect(checkBuild(sim.state, map, 'DE', berlin, 'railroad').hours).toBe(60);
    ps.buildings.office = 1;
    expect(checkBuild(sim.state, map, 'DE', berlin, 'railroad').hours).toBe(45);
    expect(BUILDINGS.office.hours(1)).toBe(32);
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

  it('Werkstatt: zwei Stufen – Stufe 1 Fabrik-Voraussetzung und doppelte Reperatur, Stufe 2 +10 % Fertigung', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    expect(BUILDINGS.workshop.cost(1)).toEqual({ money: 3000, iron: 500, lumber: 500, oil: 500 });
    expect(buildingLives('workshop')).toBe(1);
    expect(checkBuild(sim.state, map, 'DE', berlin, 'factory').error).toBe('Benötigt Werkstatt');
    expect(sim.apply('DE', { type: 'build', province: berlin, building: 'workshop' }).ok).toBe(true);
    // geplante Werkstatt reicht für die Bauschleife
    expect(checkBuild(sim.state, map, 'DE', berlin, 'factory').ok).toBe(true);
    ps.construction = null;
    ps.buildQueue = [];
    ps.buildings.factory = 1;
    const slow = unitHours(sim.state, berlin, 'artillery');
    ps.buildings.workshop = 1;
    // Stufe 1 fertigt noch normal schnell, verdoppelt aber die Reperatur mechanischer Einheiten
    expect(unitHours(sim.state, berlin, 'artillery')).toBe(slow);
    const gun = { id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { tank: 1 }, wounds: { tank: 10 } };
    sim.state.armies.push(gun);
    repairMachines(sim.state, map);
    const boosted = 10 - (gun.wounds.tank ?? 0);
    gun.wounds.tank = 10;
    ps.buildings.workshop = 0;
    repairMachines(sim.state, map);
    expect(boosted).toBeCloseTo(2 * (10 - (gun.wounds.tank ?? 0)), 9);
    expect(BUILDINGS.workshop.morale(1)).toBeCloseTo(0.01, 9);
    expect(BUILDINGS.workshop.morale(2)).toBeCloseTo(0.02, 9);
    // Stufe 2: Fertigung 10 % schneller
    ps.buildings.workshop = 2;
    expect(unitHours(sim.state, berlin, 'artillery')).toBeCloseTo(slow / 1.1, 6);
    ps.buildings.office = 1;
    const on = allRates(sim.state, map).DE.cons.money;
    expect(sim.apply('DE', { type: 'switchBuilding', province: berlin, building: 'office', on: false }).ok).toBe(true);
    // abgeschaltet: kein Unterhalt, keine Verkürzung
    expect(on - allRates(sim.state, map).DE.cons.money).toBe(2000);
    expect(checkBuild(sim.state, map, 'DE', berlin, 'railroad').hours).toBe(60);
    expect(BUILDINGS.workshop.hours(1)).toBe(8);
  });

  it('Manufaktur erst ab Tag 4 baubar', () => {
    const sim = newSim();
    expect(checkBuild(sim.state, map, 'DE', berlin, 'manufactory').error).toBe('Erst ab Tag 4 baubar');
    sim.advance(DAY);
    expect(checkBuild(sim.state, map, 'DE', berlin, 'manufactory').ok).toBe(true);
  });

  it('Handelsposten: nur ohne Küste, Rohstoffe +8 %, Moral +2 %, Unterhalt 20 Fisch', () => {
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
    expect(after.amount / before.amount).toBeCloseTo(1.08, 6);
    expect(after.money / before.money).toBeCloseTo(1.08, 6);
    expect(allRates(sim.state, map).DE.cons.fish - fish).toBe(20);
    expect(BUILDINGS.tradepost.morale(1)).toBeCloseTo(0.02, 9);
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

describe('Fertige Gebäude wirken sofort', () => {
  it('eine fertige Fabrik beschleunigt den laufenden Fertigungsauftrag (Fortschritt bleibt)', () => {
    const sim = newSim();
    const ps = sim.state.provinces[berlin];
    ps.buildings.workshop = 1;
    ps.buildings.factory = 1;
    expect(sim.apply('DE', { type: 'enqueue', province: berlin, unit: 'artillery' }).ok).toBe(true);
    const o = ps.queue[0];
    const total = o.end! - o.start!;
    // Fabrik Stufe 2 wird nach einem Viertel der Fertigungszeit fertig
    const t = sim.state.time + Math.round(total / 4 / HOUR) * HOUR;
    ps.construction = { building: 'factory', level: 2, start: sim.state.time, end: t };
    sim.ctx.invalidate();
    sim.advanceTo(t);
    expect(ps.buildings.factory).toBe(2);
    const done = (t - o.start!) / (o.end! - o.start!);
    expect(done).toBeCloseTo(0.25, 2);
    expect(o.end! - t).toBeLessThan(total * 0.75 - HOUR);
  });

  it('eine fertige Eisenbahn beschleunigt einen laufenden Marsch durch die Provinz', () => {
    const arrival = (withRail: boolean) => {
      const sim = newSim();
      const ps = sim.state.provinces[berlin];
      const to = map.provinces[berlin].neighbors.find((n) => sim.state.provinces[n].owner === 'DE')!;
      const army = sim.state.armies.find((a) => a.owner === 'DE' && a.node === berlin && !a.move)!;
      expect(sim.apply('DE', { type: 'move', army: army.id, to }).ok).toBe(true);
      if (withRail) {
        ps.construction = { building: 'railroad', level: 1, start: sim.state.time, end: sim.state.time + HOUR };
        sim.ctx.invalidate();
      }
      sim.advance(HOUR + 2 * 60_000);
      return army.move!.segEnd;
    };
    expect(arrival(true)).toBeLessThan(arrival(false));
  });
});
