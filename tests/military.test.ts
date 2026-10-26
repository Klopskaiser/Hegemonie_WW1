import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, HOUR, MINUTE } from '../src/game/balance.ts';
import { atWar } from '../src/game/diplomacy.ts';
import { edgeLength, isSea, nodePos } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { findPath, meleeOutput, segmentHours, unitCount } from '../src/game/military.ts';
import { MILITARY } from '../src/game/balance.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';
import { armyVisible, sightRange, visibleNodes } from '../src/game/visibility.ts';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));

/** Spiel ohne KI-Eingriffe, damit die Tests nur die Mechanik prüfen. */
function newSim(seed = 3) {
  const state = createGame(map, { id: 't', name: 'Test', playerNation: 'DE', speed: 1, seed, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  return new Simulation(state, map);
}

const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;
const garrison = (sim: Simulation, owner: string, node: number) =>
  sim.state.armies.find((a) => a.owner === owner && a.node === node && !a.move);

describe('Bewegung', () => {
  it('marschiert in eine Nachbarprovinz und kommt nach der berechneten Zeit an', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const army = garrison(sim, 'DE', berlin)!;
    const to = map.provinces[berlin].neighbors.find((n) => sim.state.provinces[n].owner === 'DE')!;
    const r = findPath(sim.state, map, army, berlin, to)!;
    expect(r.path).toEqual([berlin, to]);
    expect(sim.apply('DE', { type: 'move', army: army.id, to }).ok).toBe(true);
    sim.advance(Math.floor(r.hours * HOUR) - HOUR);
    expect(army.node).toBe(berlin);
    sim.advance(2 * HOUR);
    expect(army.node).toBe(to);
    expect(army.move).toBeNull();
  });

  it('darf nicht in Provinzen einer Nation marschieren, mit der Frieden herrscht', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const army = garrison(sim, 'DE', berlin)!;
    const r = sim.apply('DE', { type: 'move', army: army.id, to: prov('Amsterdam') });
    expect(r.ok).toBe(false);
  });

  it('nutzt Seewege für Landtruppen (Einschiffen)', () => {
    const sim = newSim();
    const london = prov('London');
    const army = garrison(sim, 'GB', london)!;
    const dublin = prov('Dublin');
    const r = findPath(sim.state, map, army, london, dublin);
    expect(r).not.toBeNull();
    expect(r!.path.some((n) => isSea(map, n))).toBe(true);
  });
});

describe('Krieg', () => {
  it('erobert eine unverteidigte Provinz nach Kriegserklärung', () => {
    const sim = newSim();
    expect(sim.apply('DE', { type: 'declareWar', nation: 'NL' }).ok).toBe(true);
    expect(atWar(sim.state, 'DE', 'NL')).toBe(true);
    const target = map.provinces.find((p) => p.nation === 'NL' && !p.capital)!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== target.id);
    const start = map.provinces.find((p) => p.nation === 'DE' && p.neighbors.includes(target.id))!;
    const army: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: start.id, units: { infantry: 3 } };
    sim.state.armies.push(army);
    expect(sim.apply('DE', { type: 'move', army: army.id, to: target.id }).ok).toBe(true);
    sim.advance(2 * DAY);
    expect(sim.state.provinces[target.id].owner).toBe('DE');
  });

  it('Kämpfe kosten Einheiten, die stärkere Seite gewinnt', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'NL' });
    const ams = prov('Amsterdam');
    const nl = garrison(sim, 'NL', ams)!;
    const nlBefore = unitCount(nl);
    const attacker: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: ams, units: { infantry: 12, artillery: 2 } };
    sim.state.armies.push(attacker);
    sim.advance(3 * DAY);
    expect(sim.state.armies.find((a) => a.id === nl.id)).toBeUndefined();
    // der Angreifer hat Schaden genommen (Verluste oder Verwundungen)
    const hurt = unitCount(attacker) < 14 || Object.values(attacker.wounds ?? {}).some((w) => (w ?? 0) > 0);
    expect(hurt).toBe(true);
    expect(nlBefore).toBeGreaterThan(0);
    expect(sim.state.provinces[ams].owner).toBe('DE');
  });

  it('Friedensschluss beendet den Krieg', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    expect(sim.apply('DE', { type: 'propose', nation: 'FR', kind: 'peace' }).ok).toBe(true);
    expect(sim.apply('FR', { type: 'answer', nation: 'DE', accept: true }).ok).toBe(true);
    expect(atWar(sim.state, 'DE', 'FR')).toBe(false);
  });
});

describe('See', () => {
  it('Schlachtschiffe entstehen im Wasser vor dem Hafen und gehen nie an Land', () => {
    const sim = newSim();
    const hamburg = prov('Hamburg');
    sim.spawn(hamburg, 'DE', 'battleship', 1);
    const fleet = sim.state.armies.find((a) => a.owner === 'DE' && a.units.battleship)!;
    expect(isSea(map, fleet.node)).toBe(true);
    expect(map.provinces[hamburg].seas.map((z) => map.provinces.length + z)).toContain(fleet.node);
    expect(findPath(sim.state, map, fleet, fleet.node, hamburg)).toBeNull();
  });

  it('Einschiffen dauert 3 h, mit eigenem Hafen 1,5 h; fremde Häfen helfen nicht', () => {
    const sim = newSim();
    const hamburg = prov('Hamburg');
    const army = garrison(sim, 'DE', hamburg)!;
    const sea = map.provinces.length + (map.provinces[hamburg].seaLinks ?? map.provinces[hamburg].seas)[0];
    const travel = edgeLength(map, hamburg, sea) / MILITARY.transportSpeed;
    expect(segmentHours(sim.state, map, army, hamburg, sea)).toBeCloseTo(travel + 3);
    sim.state.provinces[hamburg].buildings.harbor = 1;
    expect(segmentHours(sim.state, map, army, hamburg, sea)).toBeCloseTo(travel + 1.5);
    expect(segmentHours(sim.state, map, army, sea, hamburg)).toBeCloseTo(travel + 1.5);
    sim.state.provinces[hamburg].owner = 'FR';
    expect(segmentHours(sim.state, map, army, sea, hamburg)).toBeCloseTo(travel + 3);
  });

  it('Landtruppen kämpfen auf See mit halber Stärke, Schlachtschiffe voll', () => {
    const sim = newSim();
    const sea = map.provinces.length;
    const troops: Army = { id: 999, owner: 'DE', node: sea, units: { infantry: 10 }, morale: 0.5 };
    const fleet: Army = { id: 998, owner: 'DE', node: sea, units: { battleship: 1 } };
    // Infanterie auf See: Angriffswert × halbe Stärke × Moralfaktor (50 % Moral = 1,0)
    expect(meleeOutput(sim.state, map, troops)).toBeCloseTo(10 * 1 * 0.5 * 1);
    // Schlachtschiff: keine Moral, im Nahkampf als Fernkampfeinheit halbe Wirkung
    expect(meleeOutput(sim.state, map, fleet)).toBeCloseTo(1 * 5 * 0.5);
  });

  it('Landung: die Flotte fährt vor die Küste, Truppen gehen an Land, Schiffe bleiben liegen', () => {
    const sim = newSim();
    const london = prov('London');
    const dublin = prov('Dublin');
    const sea = map.provinces.length + map.provinces[london].seas[0];
    const fleet: Army = { id: sim.state.nextArmyId++, owner: 'GB', node: sea, units: { battleship: 1, infantry: 4 } };
    sim.state.armies.push(fleet);
    const r = sim.apply('GB', { type: 'move', army: fleet.id, to: dublin });
    expect(r.ok).toBe(true);
    expect(fleet.move?.then).toBeTruthy();
    sim.advance(4 * DAY);
    expect(fleet.units.infantry).toBeUndefined();
    expect(isSea(map, fleet.node)).toBe(true);
    expect(fleet.move).toBeNull();
    const landed = sim.state.armies.find((a) => a.owner === 'GB' && a.node === dublin && (a.units.infantry ?? 0) >= 14);
    expect(landed).toBeTruthy(); // 10 Startinfanterie + 4 gelandete (zusammengelegt)
  });
});

describe('Nahkampf und Fernkampf', () => {
  it('im Nahkampf gebundene Armeen können nicht abziehen', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const paris = prov('Paris');
    const attacker: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: paris, units: { infantry: 50 } };
    sim.state.armies.push(attacker);
    const r = sim.apply('DE', { type: 'move', army: attacker.id, to: map.provinces[paris].neighbors[0] });
    expect(r.ok).toBe(false);
  });

  it('Artillerie erfasst Feinde in Reichweite sofort und bleibt stehen', () => {
    const sim = newSim();
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const paris = prov('Paris');
    const gun: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: paris, units: { artillery: 3 } };
    sim.state.armies.push(gun);
    sim.advance(10 * MINUTE);
    expect(gun.target).toBe(garrison(sim, 'FR', paris)!.id);
    expect(gun.autoTarget).toBe(true);
  });

  it('Maschinen kämpfen unabhängig von Moral und Zustand, Infanterie nach ihrer Moral', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const tanks: Army = { id: 901, owner: 'DE', node: berlin, units: { tank: 2 }, morale: 1 };
    const inf: Army = { id: 902, owner: 'DE', node: berlin, units: { infantry: 2 }, morale: 1 };
    const t1 = meleeOutput(sim.state, map, tanks), i1 = meleeOutput(sim.state, map, inf);
    // 100 % Moral: Infanterie mit 1,2-facher Stärke (Verteidigung 1,5)
    expect(i1).toBeCloseTo(2 * 1.5 * 1.2);
    tanks.morale = 0.1;
    tanks.wounds = { tank: 40 };
    inf.morale = 0.5;
    expect(meleeOutput(sim.state, map, tanks)).toBeCloseTo(t1);
    expect(meleeOutput(sim.state, map, inf)).toBeCloseTo(2 * 1.5 * 1.0);
  });

  it('Truppen steigen nur auf See zu einer Flotte', () => {
    const sim = newSim();
    const hamburg = prov('Hamburg');
    const sea = map.provinces.length + map.provinces[hamburg].seas[0];
    const fleet: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: sea, units: { battleship: 1 } };
    const troops: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: sea, units: { infantry: 5 } };
    sim.state.armies.push(fleet, troops);
    expect(sim.apply('DE', { type: 'merge', army: troops.id, into: fleet.id }).ok).toBe(true);
    expect(fleet.units.infantry).toBe(5);
    expect(sim.apply('DE', { type: 'split', army: fleet.id, units: { battleship: 1 } }).ok).toBe(true);
    const onLand = garrison(sim, 'DE', hamburg)!;
    const ship: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: hamburg, units: { battleship: 1 } };
    sim.state.armies.push(ship);
    expect(sim.apply('DE', { type: 'merge', army: onLand.id, into: ship.id }).ok).toBe(false);
  });
});

describe('Gebäudeschäden', () => {
  it('Kämpfe in einer Provinz beschädigen Gebäude', () => {
    const sim = newSim(5);
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    const paris = prov('Paris');
    Object.assign(sim.state.provinces[paris].buildings, { fortress: 5, factory: 4, railroad: 1, barracks: 2 });
    const levels = () => Object.values(sim.state.provinces[paris].buildings).reduce((s, v) => s + v, 0);
    const before = levels();
    // ausgeglichener, langer Kampf
    sim.state.armies.push({ id: sim.state.nextArmyId++, owner: 'DE', node: paris, units: { infantry: 200 } });
    garrison(sim, 'FR', paris)!.units.infantry = 200;
    sim.advance(2 * DAY);
    expect(levels()).toBeLessThan(before);
  });
});

describe('Nebel des Krieges', () => {
  it('zeigt eigene und benachbarte, aber keine fernen fremden Armeen', () => {
    const sim = newSim();
    const vis = visibleNodes(sim.state, map, 'DE');
    const madrid = garrison(sim, 'ES', prov('Madrid'))!;
    const berlin = garrison(sim, 'DE', prov('Berlin'))!;
    expect(armyVisible(sim.state, map, 'DE', berlin, vis)).toBe(true);
    expect(armyVisible(sim.state, map, 'DE', madrid, vis)).toBe(false);
  });

  it('eigene Provinzen ganz, sonst Sichtkreis von 100 km (Eisenbahngeschütz 200 km) um die Armeen', () => {
    const sim = newSim();
    const vis = visibleNodes(sim.state, map, 'DE');
    sim.state.provinces.forEach((ps, i) => expect(vis.full.has(i)).toBe(ps.owner === 'DE'));
    const berlin = garrison(sim, 'DE', prov('Berlin'))!;
    expect(sightRange(berlin)).toBe(100);
    expect(sightRange({ ...berlin, units: { infantry: 5, railgun: 1 } })).toBe(200);
    const [x, y] = nodePos(map, prov('Berlin'));
    const here = vis.circles.filter(([cx, cy]) => Math.hypot(cx - x, cy - y) < 1);
    expect(here.length).toBeGreaterThan(0);
    expect(vis.sees(x + 99, y)).toBe(true);
  });
});

describe('Determinismus mit Kämpfen und KI', () => {
  it('liefert bei Nachsimulation und Live-Lauf denselben Stand', () => {
    const mk = () => {
      const s = new Simulation(createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 11, now: 0 }), map);
      s.apply('DE', { type: 'declareWar', nation: 'DK' });
      return s;
    };
    const a = mk(), b = mk();
    a.advance(6 * DAY);
    for (let t = 0; t < 6 * DAY; t += 53_011) b.advance(Math.min(53_011, 6 * DAY - t));
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });
});
