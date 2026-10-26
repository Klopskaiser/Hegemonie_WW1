import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MARKET } from '../src/game/balance.ts';
import { relation } from '../src/game/diplomacy.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { findPath } from '../src/game/military.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import { visibleNodes, armyVisible } from '../src/game/visibility.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));

function newSim(seed = 3) {
  const state = createGame(map, { id: 't', name: 'Test', playerNation: 'DE', speed: 1, seed, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  return new Simulation(state, map);
}
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;
const garrison = (sim: Simulation, owner: string, node: number) => sim.state.armies.find((a) => a.owner === owner && a.node === node);

describe('Diplomatie-Stufen', () => {
  it('Verbessern nur per Angebot, Verschlechtern einseitig', () => {
    const sim = newSim();
    expect(sim.apply('DE', { type: 'propose', nation: 'SE', kind: 'rightOfWay' }).ok).toBe(true);
    expect(relation(sim.state, 'DE', 'SE')).toBe('peace');
    expect(sim.apply('SE', { type: 'answer', nation: 'DE', accept: true }).ok).toBe(true);
    expect(relation(sim.state, 'DE', 'SE')).toBe('rightOfWay');
    expect(sim.apply('DE', { type: 'downgrade', nation: 'SE', to: 'embargo' }).ok).toBe(true);
    expect(relation(sim.state, 'SE', 'DE')).toBe('embargo');
    expect(sim.apply('DE', { type: 'downgrade', nation: 'SE', to: 'peace' }).ok).toBe(false);
  });

  it('Durchmarschrecht erlaubt das Betreten fremden Gebiets', () => {
    const sim = newSim();
    const army = garrison(sim, 'DE', prov('Berlin'))!;
    const target = prov('Amsterdam');
    expect(findPath(sim.state, map, army, army.node, target)).toBeNull();
    sim.apply('DE', { type: 'propose', nation: 'NL', kind: 'rightOfWay' });
    sim.apply('NL', { type: 'answer', nation: 'DE', accept: true });
    expect(findPath(sim.state, map, army, army.node, target)).not.toBeNull();
  });

  it('geteilte Karte zeigt die Armeen des Partners', () => {
    const sim = newSim();
    const madrid = garrison(sim, 'ES', prov('Madrid'))!;
    expect(armyVisible(sim.state, map, 'DE', madrid, visibleNodes(sim.state, map, 'DE'))).toBe(false);
    sim.apply('DE', { type: 'propose', nation: 'ES', kind: 'sharedMap' });
    sim.apply('ES', { type: 'answer', nation: 'DE', accept: true });
    expect(armyVisible(sim.state, map, 'DE', madrid, visibleNodes(sim.state, map, 'DE'))).toBe(true);
  });
});

describe('Börse', () => {
  it('Verkaufsangebot legt Ware zurück; Kauf überträgt Ware und Geld und setzt den Kurs', () => {
    const sim = newSim();
    const de = sim.state.nations.DE.stock, fr = sim.state.nations.FR.stock;
    const coal0 = de.coal, money0 = de.money, frCoal0 = fr.coal, frMoney0 = fr.money;
    expect(sim.apply('DE', { type: 'postOffer', side: 'sell', res: 'coal', amount: 1000, price: 2 }).ok).toBe(true);
    expect(de.coal).toBe(coal0 - 1000);
    const id = sim.state.market.offers[0].id;
    expect(sim.apply('FR', { type: 'acceptOffer', id, amount: 400 }).ok).toBe(true);
    expect(fr.coal).toBe(frCoal0 + 400);
    expect(fr.money).toBe(frMoney0 - 800);
    expect(de.money).toBe(money0 + 800);
    expect(sim.state.market.offers[0].amount).toBe(600);
    expect(sim.state.market.lastPrice.coal).toBe(2);
    expect(sim.apply('DE', { type: 'cancelOffer', id }).ok).toBe(true);
    expect(de.coal).toBe(coal0 - 400);
  });

  it('kein Handel bei Krieg oder Embargo', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'postOffer', side: 'sell', res: 'coal', amount: 1000, price: 2 });
    const id = sim.state.market.offers[0].id;
    sim.apply('FR', { type: 'downgrade', nation: 'DE', to: 'embargo' });
    expect(sim.apply('FR', { type: 'acceptOffer', id, amount: 100 }).ok).toBe(false);
  });

  it('abgelaufene Angebote geben die Rücklage zurück', () => {
    const sim = newSim();
    const before = sim.state.nations.DE.stock.coal;
    sim.apply('DE', { type: 'postOffer', side: 'sell', res: 'coal', amount: 1000, price: 2 });
    sim.advance(MARKET.offerLifetime + HOUR);
    expect(sim.state.market.offers.length).toBe(0);
    expect(sim.state.nations.DE.stock.coal).toBeGreaterThan(before - 1000);
  });
});

describe('Zeitung und Sieg', () => {
  it('erscheint täglich mit Tageskarte und Rangliste', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'NL' });
    sim.advance(DAY);
    const paper = sim.state.newspapers.at(-1)!;
    expect(paper.owners.length).toBe(map.provinces.length);
    expect(paper.items.some((i) => /Krieg/.test(i.text))).toBe(true);
    expect(paper.ranking.length).toBeGreaterThan(10);
  });

  it('wer genug Siegpunkte hält, gewinnt; das Spiel hält an', () => {
    const sim = newSim();
    for (const ps of sim.state.provinces) if (!map.nations.find((n) => n.id === ps.owner)?.major || ps.owner === 'FR' || ps.owner === 'GB' || ps.owner === 'AU' || ps.owner === 'RU' || ps.owner === 'IT') ps.owner = 'DE';
    sim.advance(DAY);
    expect(sim.state.winner).toBe('DE');
    expect(sim.state.paused).toBe(true);
  });
});
