import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, MARKET } from '../src/game/balance.ts';
import { BasicAI } from '../src/game/ai.ts';
import { setRelation } from '../src/game/diplomacy.ts';
import { nationRates } from '../src/game/economy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';
import type { Action } from '../src/game/actions.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;

/** Spiel ohne KI-Eingriffe; die KI wird in den Tests gezielt für eine Nation befragt */
function newSim(day = 0) {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  state.time = day * DAY;
  return new Simulation(state, map);
}

const decide = (sim: Simulation, nation: string, random = 0.5): Action[] =>
  new BasicAI().decide({ state: sim.state, map, nation, rates: nationRates(sim.state, map, nation), random: () => random });

describe('KI: Kleinstaaten verteidigen sich', () => {
  it('ein Kleinstaat zieht Verstärkung in die angegriffene Provinz, auch wenn es allein nicht reicht', () => {
    const sim = newSim(4);
    sim.apply('ES', { type: 'declareWar', nation: 'PT' });
    const porto = prov('Porto'), evora = prov('Évora');
    sim.state.armies = sim.state.armies.filter((a) => a.owner !== 'PT' || a.node === evora);
    // spanische Übermacht steht in Porto, in Évora wartet die portugiesische Reserve
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'ES', node: porto, units: { infantry: 40 }, morale: 1 });
    const reserve: Army = { id: sim.state.nextArmyId++, owner: 'PT', node: evora, units: { infantry: 14 }, morale: 1 };
    sim.state.armies.push(reserve);
    const acts = decide(sim, 'PT');
    const moves = acts.filter((a) => a.type === 'move' && a.to === porto);
    expect(moves.length).toBeGreaterThan(0);
  });
});

describe('KI: Artillerie gehört nicht in den Nahkampf', () => {
  const setup = () => {
    const sim = newSim(8);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const p = map.provinces.find((x) => x.nation === 'DE' && x.neighbors.some((n) => map.provinces[n].nation === 'FR'))!.id;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== p);
    return { sim, p };
  };

  it('gemischte Armeen geben ihre Artillerie als eigene Batterie ab, die nie automatisch verschmilzt', () => {
    const { sim, p } = setup();
    const mixed: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 30, artillery: 4 }, morale: 1 };
    sim.state.armies.push(mixed);
    const split = decide(sim, 'DE').find((a) => a.type === 'split' && a.units.artillery);
    expect(split).toMatchObject({ type: 'split', army: mixed.id, units: { artillery: 4 }, apart: true });
    const r = sim.apply('DE', split!);
    expect(r.ok).toBe(true);
    const battery = sim.state.armies.find((a) => r.ok && a.id === r.army)!;
    expect(battery.keepApart).toBe(true);
    expect(battery.units).toEqual({ artillery: 4 });
  });

  it('beim Angriff fährt die Batterie nur bis vor das Ziel (in Schussweite, auf dem Weg davor)', () => {
    const { sim, p } = setup();
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 60 }, morale: 1 });
    const battery: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { artillery: 4 }, morale: 1, keepApart: true };
    sim.state.armies.push(battery);
    const acts = decide(sim, 'DE');
    const attack = acts.find((a) => a.type === 'move' && a.army !== battery.id && sim.state.provinces[a.to]?.owner === 'FR');
    expect(attack).toBeTruthy();
    const target = attack!.type === 'move' ? attack!.to : -1;
    const gun = acts.find((a) => a.type === 'move' && a.army === battery.id);
    expect(gun).toBeTruthy();
    if (gun?.type !== 'move') return;
    // Ziel ist ein Wegpunkt vor der feindlichen Provinz, nicht die Provinz selbst
    expect(gun.to).not.toBe(target);
    expect(gun.toward).toBe(target);
    expect(gun.frac!).toBeGreaterThan(0);
    expect(gun.frac!).toBeLessThan(1);
    expect(acts).toContainEqual({ type: 'setMarch', army: battery.id, aggressive: true });
  });
});

describe('KI: Kriegsziele', () => {
  it('zuerst Kleinstaaten in Reichweite, nicht die Großmacht nebenan', () => {
    const sim = newSim(8);
    const berlin = prov('Berlin');
    // deutlich überlegen, damit Klein- wie Großmächte als Ziel in Frage kämen
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: berlin, units: { infantry: 400 }, morale: 1 });
    const war = decide(sim, 'DE', 0.001).find((a) => a.type === 'declareWar');
    expect(war).toBeTruthy();
    if (war?.type !== 'declareWar') return;
    expect(map.nations.find((n) => n.id === war.nation)?.major).toBe(false);
  });
});

describe('KI: Bündnisse', () => {
  it('Bündnisfall: der Partner liegt mit unserem Nachbarn im Krieg – wir stehen ihm bei', () => {
    const sim = newSim(8);
    setRelation(sim.state, 'FR', 'DE', 'sharedMap');
    sim.apply('DE', { type: 'declareWar', nation: 'CH' });
    const acts = decide(sim, 'FR', 0.1);
    expect(acts).toContainEqual({ type: 'declareWar', nation: 'CH' });
  });

  it('Bündnisangebote werden nach Interessenlage beantwortet: ohne gemeinsamen Gegner nein, mit ja', () => {
    const sim = newSim(8);
    sim.apply('IT', { type: 'propose', nation: 'FR', kind: 'rightOfWay' });
    expect(decide(sim, 'FR', 0.01).find((a) => a.type === 'answer')).toMatchObject({ nation: 'IT', accept: false });
    // gemeinsamer Kriegsgegner: jetzt ja
    sim.apply('IT', { type: 'declareWar', nation: 'CH' });
    sim.apply('FR', { type: 'declareWar', nation: 'CH' });
    sim.apply('IT', { type: 'propose', nation: 'FR', kind: 'rightOfWay' });
    expect(decide(sim, 'FR', 0.99).find((a) => a.type === 'answer')).toMatchObject({ nation: 'IT', accept: true });
  });
});

describe('KI: Wirtschaft', () => {
  it('Werkstätten nur an den Fabrikstandorten (drei je Großmacht, bei Verlust ein Ersatz), keine Werkstatt-Flut', () => {
    const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
    for (const n of Object.values(state.nations)) n.controller = 'ai';
    const sim = new Simulation(state, map);
    sim.advance(10 * DAY);
    for (const n of map.nations.filter((x) => x.major)) {
      const shops = sim.state.provinces.filter((ps, i) => ps.owner === n.id && map.provinces[i].nation === n.id && ps.buildings.workshop > 0).length;
      // drei Standorte; geht einer verloren, kommt ein Ersatz dazu (nach Rückeroberung zählt der alte wieder)
      expect(shops).toBeLessThanOrEqual(4);
    }
  });

  it('die KI bietet an der Börse auch weit über dem Richtpreis, höchstens aber den Höchstpreis des Spiels', () => {
    const sim = newSim(2);
    sim.state.market.lastPrice.grain = 50;
    sim.state.nations.DE.stock.grain = 0;
    sim.state.nations.DE.stock.money = 5_000_000;
    sim.invalidate();
    const bids = decide(sim, 'DE').filter((a) => a.type === 'postOffer' && a.side === 'buy');
    const grain = bids.find((b) => b.type === 'postOffer' && b.res === 'grain');
    expect(grain?.type === 'postOffer' && grain.price).toBeGreaterThan(MARKET.basePrice.grain * 3);
    for (const b of bids) if (b.type === 'postOffer') expect(b.price).toBeLessThanOrEqual(MARKET.maxPrice);
  });
});
