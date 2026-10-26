import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, TROOP_MORALE } from '../src/game/balance.ts';
import { setRelation } from '../src/game/diplomacy.ts';
import { edgeLength, edgePoint, nodePos } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { armyPosition, defectionChance, defections, planRoute } from '../src/game/military.ts';
import { armyDesignation, armyName } from '../src/game/names.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;

function newSim(seed = 3) {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  return new Simulation(state, map);
}
const cityArmy = (sim: Simulation, owner: string, node: number) =>
  sim.state.armies.find((a) => a.owner === owner && a.node === node && !a.move && !a.pos)!;

describe('Wege', () => {
  it('Landwege knicken an der gemeinsamen Grenze', () => {
    const berlin = prov('Berlin'), n = map.provinces[berlin].neighbors[0];
    const straight = Math.hypot(nodePos(map, n)[0] - nodePos(map, berlin)[0], nodePos(map, n)[1] - nodePos(map, berlin)[1]);
    expect(edgeLength(map, berlin, n)).toBeGreaterThanOrEqual(straight - 1e-6);
    expect(edgePoint(map, berlin, n, 0)).toEqual(nodePos(map, berlin));
  });

  it('Armeen bleiben auf Wunsch mitten auf einem Weg stehen und ziehen von dort weiter', () => {
    const sim = newSim();
    const berlin = prov('Berlin'), next = map.provinces[berlin].neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    const a = cityArmy(sim, 'DE', berlin);
    expect(sim.apply('DE', { type: 'move', army: a.id, to: berlin, toward: next, frac: 0.4 }).ok).toBe(true);
    sim.advance(3 * DAY);
    expect(a.move).toBeNull();
    expect(a.pos).toEqual({ a: berlin, b: next, f: 0.4 });
    expect(a.node).toBe(berlin);
    const p = armyPosition(map, a, sim.state.time), q = edgePoint(map, berlin, next, 0.4);
    expect(p[0]).toBeCloseTo(q[0]);
    // weiter zum Nachbarn: Start mitten auf dem Weg
    const plan = planRoute(sim.state, map, a, sim.state.time, { node: next })!;
    expect(plan.path).toEqual([berlin, next]);
    expect(plan.startFrac).toBeCloseTo(0.4);
    sim.apply('DE', { type: 'move', army: a.id, to: next });
    sim.advance(3 * DAY);
    expect(a.node).toBe(next);
    expect(a.pos).toBeNull();
  });
});

describe('Besatzung', () => {
  it('verlässt die letzte Armee eine eigene Stadt, bleibt eine Infanterie zurück', () => {
    const sim = newSim();
    const berlin = prov('Berlin'), next = map.provinces[berlin].neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    const a = cityArmy(sim, 'DE', berlin);
    const before = a.units.infantry!;
    expect(sim.apply('DE', { type: 'move', army: a.id, to: next }).ok).toBe(true);
    expect(a.units.infantry).toBe(before - 1);
    const stay = cityArmy(sim, 'DE', berlin);
    expect(stay.units).toEqual({ infantry: 1 });
  });

  it('eine einzelne letzte Einheit lässt sich nicht abziehen', () => {
    const sim = newSim();
    const berlin = prov('Berlin'), next = map.provinces[berlin].neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    const a = cityArmy(sim, 'DE', berlin);
    a.units = { infantry: 1 };
    const r = sim.apply('DE', { type: 'move', army: a.id, to: next });
    expect(r.ok).toBe(false);
    expect(a.move).toBeFalsy();
  });
});

describe('Armeenamen', () => {
  const army = (units: Army['units'], extra: Partial<Army> = {}): Army => ({ id: 1, owner: 'DE', node: 0, units, num: 3, ...extra });
  it('Größe nach Stärke, Art nach der stärksten Einheit, Nummer je Nation eindeutig', () => {
    expect(armyDesignation(army({ infantry: 4 }))).toBe('Infanteriebrigade');
    expect(armyDesignation(army({ infantry: 12 }))).toBe('Infanteriedivision');
    // Beispiel: Stärke um 25 mit 2 Panzern und 1 Artillerie = Panzerdivision
    expect(armyName(army({ infantry: 5, tank: 2, artillery: 1 }))).toBe('3. Panzerdivision');
    expect(armyDesignation(army({ infantry: 40 }))).toBe('Heeresgruppe');
    expect(armyDesignation(army({ infantry: 200 }))).toBe('Armee');
    expect(armyDesignation(army({ battleship: 1, infantry: 3 }))).toBe('Geschwader');
    const sim = newSim();
    const nums = sim.state.armies.filter((a) => a.owner === 'DE').map((a) => a.num);
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe('Truppenmoral', () => {
  it('Nahkampf senkt die Moral der Infanterie', () => {
    const sim = newSim();
    setRelation(sim.state, 'DE', 'FR', 'war');
    const berlin = prov('Berlin');
    const a = cityArmy(sim, 'DE', berlin);
    a.morale = 0.8;
    sim.state.armies.push({ id: 9999, owner: 'FR', node: berlin, units: { infantry: 40 }, morale: 0.5 });
    sim.advance(HOUR);
    expect(a.morale!).toBeLessThan(0.8);
  });

  it('ohne Getreide sinkt sie, in eigener Provinz nähert sie sich deren Moral; Steigen etwas schneller', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const a = cityArmy(sim, 'DE', berlin);
    sim.state.provinces[berlin].morale = 1;
    a.morale = 0.5;
    sim.advance(DAY);
    const up = a.morale! - 0.5;
    expect(up).toBeGreaterThan(0);
    sim.state.nations.DE.stock.grain = 0;
    sim.state.nations.DE.consumption.grain = 100;
    sim.state.nations.DE.consumption.fish = 0;
    const m = a.morale!;
    sim.advance(DAY);
    expect(a.morale!).toBeLessThan(m);
    expect(m - a.morale!).toBeLessThanOrEqual(TROOP_MORALE.fall.max + 1e-9);
  });
});

describe('Überlaufen', () => {
  it('Provinzen unter 33 % Moral laufen zu einem Nachbarn über; ein Teil der Truppen wechselt, mindestens eine Einheit', () => {
    expect(defectionChance(0.5)).toBe(0);
    expect(defectionChance(0.1)).toBeGreaterThan(defectionChance(0.3));
    const sim = newSim();
    const target = map.provinces.find((p) => p.nation === 'DE' && !p.capital && p.neighbors.some((n) => map.provinces[n].nation !== 'DE'))!;
    const ps = sim.state.provinces[target.id];
    ps.morale = 0;
    const garrison = cityArmy(sim, 'DE', target.id);
    garrison.units = { infantry: 8 };
    let flipped = false;
    for (let k = 0; k < 30 && !flipped; k++) {
      defections(sim.ctx);
      flipped = ps.owner !== 'DE';
      if (!flipped) ps.morale = 0;
    }
    expect(flipped).toBe(true);
    expect(sim.state.armies.some((a) => a.owner === 'DE' && a.node === target.id)).toBe(false);
    const turned = sim.state.armies.find((a) => a.owner === ps.owner && a.node === target.id)!;
    expect(turned.units.infantry!).toBeGreaterThanOrEqual(1);
    expect(sim.state.events.some((e) => /^Revolution/.test(e.text))).toBe(true);
  });

  it('Truppen allein laufen nicht über', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const a = cityArmy(sim, 'DE', berlin);
    a.morale = TROOP_MORALE.min;
    for (let k = 0; k < 10; k++) defections(sim.ctx);
    expect(a.owner).toBe('DE');
  });
});

describe('Börse', () => {
  it('protokolliert Abschlüsse', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'postOffer', side: 'sell', res: 'coal', amount: 1000, price: 2 });
    const id = sim.state.market.offers[0].id;
    sim.apply('FR', { type: 'acceptOffer', id, amount: 300 });
    expect(sim.state.market.trades.at(-1)).toMatchObject({ seller: 'DE', buyer: 'FR', res: 'coal', amount: 300, price: 2 });
  });
});

describe('Revoltechance und Teilen', () => {
  it('1 % knapp unter 33 % Moral bis 33 % bei 0 %, je angefangene 5 Stärke Besatzung 1 Punkt weniger', () => {
    expect(defectionChance(0.3299)).toBeCloseTo(0.01, 3);
    expect(defectionChance(0)).toBeCloseTo(0.33);
    expect(defectionChance(0, 10)).toBeCloseTo(0.31);
    expect(defectionChance(0, 11)).toBeCloseTo(0.30);
    expect(defectionChance(0, 200)).toBe(0);
  });

  it('im Nahkampf kann nicht geteilt werden', () => {
    const sim = newSim();
    setRelation(sim.state, 'DE', 'FR', 'war');
    const berlin = prov('Berlin');
    const a = cityArmy(sim, 'DE', berlin);
    sim.state.armies.push({ id: 9998, owner: 'FR', node: berlin, units: { infantry: 3 } });
    expect(sim.apply('DE', { type: 'split', army: a.id, units: { infantry: 2 } }).ok).toBe(false);
  });

  it('abgetrennte Armeen ohne Befehl gliedern sich wieder ein, losgeschickte nicht', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const a = cityArmy(sim, 'DE', berlin);
    const n0 = a.units.infantry!;
    const r = sim.apply('DE', { type: 'split', army: a.id, units: { infantry: 3 } });
    expect(r.ok && r.army).toBeTruthy();
    const id = r.ok ? r.army! : -1;
    sim.advance(7 * HOUR);
    expect(sim.state.armies.some((x) => x.id === id)).toBe(false);
    expect(a.units.infantry!).toBeGreaterThanOrEqual(n0);
  });

  it('sofortiges Eingliedern beim Abwählen; losgeschickte Armeen bleiben getrennt', () => {
    const sim = newSim();
    const berlin = prov('Berlin'), next = map.provinces[berlin].neighbors.find((n) => map.provinces[n].nation === 'DE')!;
    const a = cityArmy(sim, 'DE', berlin);
    const r1 = sim.apply('DE', { type: 'split', army: a.id, units: { infantry: 2 } });
    const id1 = r1.ok ? r1.army! : -1;
    expect(sim.apply('DE', { type: 'rejoin', army: id1 }).ok).toBe(true);
    expect(sim.state.armies.some((x) => x.id === id1)).toBe(false);
    const r2 = sim.apply('DE', { type: 'split', army: a.id, units: { infantry: 2 } });
    const id2 = r2.ok ? r2.army! : -1;
    sim.apply('DE', { type: 'move', army: id2, to: next });
    sim.advance(7 * HOUR);
    expect(sim.state.armies.find((x) => x.id === id2)?.split ?? null).toBeNull();
  });
});

describe('Zeitung: Eroberungen und Schlachten', () => {
  it('meldet eroberte Städte und vernichtete Armeen mit Namen', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'NL' });
    const target = map.provinces.find((p) => p.nation === 'NL' && !p.capital)!;
    const start = map.provinces.find((p) => p.nation === 'DE' && p.neighbors.includes(target.id))!;
    // kleine niederländische Besatzung gegen eine große deutsche Armee
    sim.state.armies.find((a) => a.owner === 'NL' && a.node === target.id)!.units = { infantry: 1 };
    const attacker = cityArmy(sim, 'DE', start.id);
    attacker.units = { infantry: 60 };
    sim.apply('DE', { type: 'move', army: attacker.id, to: target.id });
    sim.advance(2 * DAY);
    const items = sim.state.newspapers.flatMap((p) => p.items);
    expect(items.some((i) => i.kind === 'war')).toBe(true);
    expect(items.some((i) => i.kind === 'conquest' && i.text.includes(target.name))).toBe(true);
    expect(items.some((i) => i.kind === 'battle' && /Infanterie|Brigade|Division/.test(i.text))).toBe(true);
    expect(sim.state.provinces[target.id].owner).toBe('DE');
  });
});
