// Regressionstests zur dritten Fehlerliste: Portrait, Kriegsverluste in der Zeitung, Schlachtschiffe zusammenlegen,
// Reichweite gemischter Batterien, Zielwahl und Restschaden im Fernkampf, Besatzung nur aus Infanterie,
// Begegnungen schneller Truppen.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAY, MINUTE, UNITS } from '../src/game/balance.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { edgePoint, nodePos, nodeNeighbors } from '../src/game/graph.ts';
import {
  armyPosition, closeEnoughToMerge, inCombat, conquer, engageRanged, garrisonKeep, mergeNearby, rangedRound, rangedVolleys, startMove, unitCount,
} from '../src/game/military.ts';
import { publishNewspaper } from '../src/game/newspaper.ts';
import { allRates } from '../src/game/economy.ts';
import { RESOURCES } from '../src/game/mapdata.ts';
import { Simulation } from '../src/game/sim.ts';
import { createGame } from '../src/game/state.ts';
import type { Army } from '../src/game/types.ts';
import { armyUnitImage, portraitImage, portraitUnit } from '../src/ui/Picture.tsx';

const map: MapData = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'maps', 'europe.json'), 'utf8'));
const prov = (name: string) => map.provinces.find((p) => p.name === name)!.id;
const dist = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function newSim(day = 8) {
  const state = createGame(map, { id: 't', name: 'T', playerNation: 'DE', speed: 1, seed: 3, now: 0 });
  for (const n of Object.values(state.nations)) n.controller = 'human';
  state.time = day * DAY;
  const sim = new Simulation(state, map);
  sim.apply('DE', { type: 'declareWar', nation: 'FR' });
  return sim;
}

const army = (sim: Simulation, owner: string, node: number, units: Army['units'], extra: Partial<Army> = {}): Army => {
  const a: Army = { id: sim.state.nextArmyId++, owner, node, units, morale: 1, ...extra };
  sim.state.armies.push(a);
  return a;
};

/** Wegpunkt auf dem Weg q–r, `km` (Luftlinie) von der Stadt q entfernt; null, wenn der Weg zu kurz ist */
function roadPoint(q: number, r: number, km: number): { a: number; b: number; f: number } | null {
  const c = nodePos(map, q);
  if (dist(edgePoint(map, q, r, 1), c) < km + 2) return null;
  let lo = 0, hi = 1;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (dist(edgePoint(map, q, r, mid), c) < km) lo = mid; else hi = mid;
  }
  return { a: q, b: r, f: hi };
}

/** Stadt einer Nation mit zwei Landwegen, auf denen Punkte in `kms` Entfernung liegen */
function cityWithRoads(sim: Simulation, owner: string, km1: number, km2: number) {
  for (const p of map.provinces) {
    if (sim.state.provinces[p.id].owner !== owner) continue;
    const land = nodeNeighbors(map, p.id).filter((n) => n < map.provinces.length);
    for (const r1 of land) for (const r2 of land) {
      if (r1 === r2) continue;
      const p1 = roadPoint(p.id, r1, km1), p2 = roadPoint(p.id, r2, km2);
      if (p1 && p2) {
        sim.state.armies = sim.state.armies.filter((a) => a.node !== p.id && a.node !== r1 && a.node !== r2);
        return { q: p.id, p1, p2 };
      }
    }
  }
  throw new Error('keine passende Stadt');
}

describe('Portrait', () => {
  const a = (units: Army['units'], morale = 1): Army => ({ id: 1, owner: 'DE', node: 0, units, morale });
  it('zeigt die Maschinen mit der größten Gesamtstärke, Infanterie nur ohne Maschinen', () => {
    expect(portraitUnit(a({ infantry: 30, armoredCar: 1 }))).toBe('armoredCar');
    expect(portraitUnit(a({ armoredCar: 10, artillery: 1 }))).toBe('armoredCar');
    expect(portraitUnit(a({ armoredCar: 10, tank: 1 }))).toBe('armoredCar');
    expect(portraitUnit(a({ armoredCar: 3, tank: 1 }))).toBe('tank');
    expect(portraitUnit(a({ artillery: 9, railgun: 1, infantry: 3 }))).toBe('artillery');
    expect(portraitUnit(a({ infantry: 3, battleship: 1, tank: 2 }))).toBe('battleship');
    expect(portraitUnit(a({ infantry: 3 }))).toBe('infantry');
    expect(portraitUnit(a({}))).toBeNull();
  });
  it('im Kampf und eingeschifft eigene Bilder (Ersatz: Portrait-Einheit); Schlachtschiffe nie „eingeschifft“', () => {
    const quiet = { fighting: false, embarked: false };
    expect(portraitImage(a({ tank: 2, infantry: 9 }), 1, { ...quiet, fighting: true })).toEqual({ src: '/images/units/combat.png', fallback: '/images/units/tank.png' });
    expect(portraitImage(a({ infantry: 9 }), 1, { ...quiet, embarked: true })).toEqual({ src: '/images/units/embarked.png', fallback: '/images/units/infantry.png' });
    expect(portraitImage(a({ battleship: 1, infantry: 9 }), 1, { ...quiet, embarked: true })!.src).toBe('/images/units/battleship.png');
    // Kampf geht vor eingeschifft
    expect(portraitImage(a({ infantry: 9 }), 1, { fighting: true, embarked: true })!.src).toContain('combat');
    expect(portraitImage(a({ infantry: 9 }), 0.2, quiet)!.src).toContain('infantry_low');
    expect(portraitImage(a({}), 1, quiet)).toBeNull();
  });
  it('Infanterie unter 30 % Moral bekommt ein eigenes Bild (mit dem normalen als Ersatz)', () => {
    expect(armyUnitImage(a({ infantry: 3 }), 'infantry', 0.29).src).toContain('infantry_low');
    expect(armyUnitImage(a({ infantry: 3 }), 'infantry', 0.29).fallback).toContain('infantry.png');
    expect(armyUnitImage(a({ infantry: 3 }), 'infantry', 0.3).src).toContain('infantry.png');
    expect(armyUnitImage(a({ tank: 3 }), 'tank', 0.1).src).toContain('tank.png');
  });
});

describe('Schlachtschiffe zusammenlegen', () => {
  it('Schiffe mit selbständig erfasstem Ziel werden trotzdem zu einem Verband', () => {
    const sim = newSim();
    const sea = map.provinces.length; // erstes Seegebiet
    const s1 = army(sim, 'DE', sea, { battleship: 1 }, { target: 999, autoTarget: true });
    const s2 = army(sim, 'DE', sea, { battleship: 2 }, { target: 999, autoTarget: true });
    mergeNearby(sim.ctx);
    const left = sim.state.armies.filter((x) => x === s1 || x === s2);
    expect(left.length).toBe(1);
    expect(left[0].units.battleship).toBe(3);
  });
  it('von Hand genügt es, nahe beieinander zu stehen (nicht exakt derselbe Wegpunkt)', () => {
    const sim = newSim();
    const sea = map.provinces.length;
    const next = nodeNeighbors(map, sea).find((n) => n >= map.provinces.length)!;
    const s1 = army(sim, 'DE', sea, { battleship: 1 }, { pos: { a: sea, b: next, f: 0.1 }, keepApart: true });
    const s2 = army(sim, 'DE', sea, { battleship: 1 }, { pos: { a: sea, b: next, f: 0.1 + 0.3 / Math.max(1, dist(nodePos(map, sea), nodePos(map, next))) }, keepApart: true });
    expect(closeEnoughToMerge(map, s1, s2, sim.state.time)).toBe(true);
    expect(sim.apply('DE', { type: 'merge', army: s2.id, into: s1.id }).ok).toBe(true);
    expect(s1.units.battleship).toBe(2);
  });
});

describe('Fernkampf: Reichweite je Einheitentyp', () => {
  it('Artillerie neben Eisenbahngeschützen schießt nicht auf deren Reichweite', () => {
    const sim = newSim();
    const { q, p2 } = cityWithRoads(sim, 'DE', 5, 120);
    const gun = army(sim, 'DE', p2.b, { railgun: 1, artillery: 50 }, { pos: p2 });
    const foe = army(sim, 'FR', q, { infantry: 30 });
    expect(dist(armyPosition(map, gun, sim.state.time), armyPosition(map, foe, sim.state.time))).toBeGreaterThan(UNITS.artillery.range);
    gun.target = foe.id;
    gun.autoTarget = false;
    const v = rangedVolleys(sim.state, map, gun);
    expect(v.length).toBe(1);
    expect(v[0].units).toEqual(['railgun']);
    rangedRound(sim.ctx);
    // ein Eisenbahngeschütz (Angriff 3) tötet keinen Infanteristen in einer Runde – 50 Artillerie hätten es getan
    expect(foe.units.infantry).toBe(30);
  });
});

describe('Fernkampf: Zielwahl und Restschaden', () => {
  it('ein einzelner Stadtbewacher ist kein Vorrangziel, wenn andere Gegner in Reichweite stehen', () => {
    const sim = newSim();
    // FR-Stadt mit einem Mann; FR-Truppen 20 km jenseits der Stadt, Geschütze 35 km davor
    const { q, p1, p2 } = cityWithRoads(sim, 'FR', 20, 35);
    const guard = army(sim, 'FR', q, { infantry: 1 });
    const field = army(sim, 'FR', p1.b, { infantry: 10 }, { pos: p1 });
    const gun = army(sim, 'DE', p2.b, { artillery: 10 }, { pos: p2 });
    const d = (x: Army) => dist(armyPosition(map, gun, sim.state.time), armyPosition(map, x, sim.state.time));
    expect(d(guard)).toBeLessThan(d(field)); // der Bewacher wäre das nähere Ziel
    expect(d(field)).toBeLessThan(UNITS.artillery.range);
    engageRanged(sim.ctx);
    expect(gun.target).toBe(field.id);
    // ein schon erfasster Einzelbewacher wird zugunsten des lohnenden Ziels aufgegeben
    gun.target = guard.id;
    gun.autoTarget = true;
    engageRanged(sim.ctx);
    expect(gun.target).toBe(field.id);
  });

  it('nach dem Vernichten eines Mini-Trupps trifft der Restschaden sofort das nächste Ziel', () => {
    const sim = newSim();
    const { p1, p2 } = cityWithRoads(sim, 'FR', 15, 30);
    const p0 = roadPoint(p1.a, p1.b, 5)!;
    const tiny = army(sim, 'FR', p0.b, { infantry: 1 }, { pos: p0 });
    const big = army(sim, 'FR', p1.b, { infantry: 20 }, { pos: p1 });
    const gun = army(sim, 'DE', p2.b, { artillery: 60 }, { pos: p2, target: tiny.id, autoTarget: true });
    expect(dist(armyPosition(map, gun, sim.state.time), armyPosition(map, big, sim.state.time))).toBeLessThan(UNITS.artillery.range);
    rangedRound(sim.ctx);
    expect(unitCount(tiny)).toBe(0);
    expect(big.units.infantry ?? 0).toBeLessThan(20);
  });
});

describe('Besatzung: Bewacher ist immer Infanterie', () => {
  it('Maschinen ziehen ganz aus der Stadt ab, auch eine einzelne', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    sim.state.armies = sim.state.armies.filter((a) => a.node !== berlin);
    const tank = army(sim, 'DE', berlin, { tank: 1 });
    expect(garrisonKeep(sim.state, map, tank)).toBeNull();
    const mixedMech = army(sim, 'DE', berlin, { tank: 2, artillery: 3 }, { keepApart: true });
    expect(garrisonKeep(sim.state, map, mixedMech)).toBeNull();
  });
  it('mit Infanterie bleibt ein Infanterist, die Maschinen ziehen ab', () => {
    const sim = newSim();
    const berlin = prov('Berlin');
    const to = map.provinces[berlin].neighbors.find((n) => sim.state.provinces[n].owner === 'DE')!;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== berlin);
    const a = army(sim, 'DE', berlin, { infantry: 1, tank: 2 });
    expect(garrisonKeep(sim.state, map, a)).toEqual({ unit: 'infantry', node: berlin });
    expect(sim.apply('DE', { type: 'move', army: a.id, to }).ok).toBe(true);
    expect(a.units).toEqual({ tank: 2 });
    const stay = sim.state.armies.filter((x) => x.node === berlin && !x.move);
    expect(stay.map((x) => x.units)).toEqual([{ infantry: 1 }]);
  });
  it('nur Maschinen erobern: ein Infanterist des Besatzers zieht in die Stadt', () => {
    const sim = newSim();
    const metz = map.provinces.find((p) => sim.state.provinces[p.id].owner === 'FR' && p.city)!.id;
    sim.state.armies = sim.state.armies.filter((a) => a.node !== metz);
    army(sim, 'DE', metz, { tank: 3 });
    conquer(sim.ctx, metz, 'DE');
    const inf = sim.state.armies.filter((x) => x.owner === 'DE' && x.node === metz && (x.units.infantry ?? 0) > 0);
    expect(inf.length).toBe(1);
    expect(inf[0].units.infantry).toBe(1);
  });
  it('unter Beschuss bleibt die Infanterie stehen, Maschinen daneben fallen', () => {
    const sim = newSim();
    const { q, p2 } = cityWithRoads(sim, 'DE', 5, 30);
    sim.state.provinces[q].buildings.fortress = 0;
    const guard = army(sim, 'DE', q, { infantry: 1, artillery: 2 });
    const gun = army(sim, 'FR', p2.b, { artillery: 60 }, { pos: p2, target: guard.id });
    gun.autoTarget = false;
    for (let k = 0; k < 3; k++) rangedRound(sim.ctx);
    expect(sim.state.armies.includes(guard)).toBe(true);
    expect(guard.units).toEqual({ infantry: 1 });
  });
});

describe('Begegnungen schneller Truppen', () => {
  it('eine schnelle Armee rast nicht an einem Gegner vorbei, der gerade die Stadt verlässt', () => {
    const sim = newSim();
    // Knoten mit drei Landnachbarn
    const v = map.provinces.find((p) => sim.state.provinces[p.id].owner === 'DE'
      && nodeNeighbors(map, p.id).filter((n) => n < map.provinces.length).length >= 3)!.id;
    const [u, w, y] = nodeNeighbors(map, v).filter((n) => n < map.provinces.length);
    sim.state.armies = sim.state.armies.filter((a) => ![u, v, w, y].includes(a.node));
    for (const n of [u, v, w]) sim.state.provinces[n].buildings.railroad = 1;
    // eigene Bahn, Panzerwagen im Gewaltmarsch: gut 4 km je Minute
    const A = army(sim, 'DE', u, { armoredCar: 5 }, { forcedMarch: true });
    const B = army(sim, 'FR', v, { infantry: 5 });
    startMove(sim.ctx, A, [u, v, w]);
    startMove(sim.ctx, B, [v, y]);
    // A erreicht v zwischen zwei Minutentakten; B ist eine halbe Minute vorher aus v losmarschiert
    const T = sim.state.time + MINUTE / 2;
    const D = A.move!.segEnd - A.move!.segStart;
    A.move!.segStart = T - D;
    A.move!.segEnd = T;
    const E = B.move!.segEnd - B.move!.segStart;
    B.move!.segStart = T - MINUTE / 2;
    B.move!.segEnd = B.move!.segStart + E;
    sim.ctx.invalidate(); // Ereignisplanung neu (Ankunftszeit geändert)
    for (let k = 0; k < 3; k++) sim.advance(MINUTE);
    expect(A.move).toBeNull();
    expect(dist(armyPosition(map, A, sim.state.time), armyPosition(map, B, sim.state.time))).toBeLessThan(1.1);
  });
});

describe('Zeitung: Schlagzeilen', () => {
  it('Hauptstadtverlegung, Plünderung und Zusammenstoß bekommen die passende Schlagzeile', () => {
    const sim = newSim();
    sim.state.newsFeed = [];
    const t = sim.state.time;
    sim.state.newsFeed.push(
      { time: t, text: 'Deutsches Reich verlegt die Hauptstadt nach Hamburg.' },
      { time: t, text: 'Zusammenstoß bei Metz: Deutsches Reich und Italien sind im Krieg!' },
      { time: t, text: 'Die Hauptstadt Paris (Frankreich) ist an Deutsches Reich gefallen!' },
      { time: t, text: 'Deutsches Reich plündert 20.000 Pfund aus der Hauptstadt Paris.' },
    );
    const items = publishNewspaper(sim.state, map).items;
    const by = (title: string) => items.filter((i) => i.title === title);
    expect(by('Neue Hauptstadt').length).toBe(1);
    expect(by('Krieg ausgebrochen!')[0]?.kind).toBe('war');
    // die Plünderung steht in der Meldung zum Fall der Hauptstadt, nicht als zweite „Hauptstadt gefallen!“
    const fall = by('Hauptstadt gefallen!');
    expect(fall.length).toBe(1);
    expect(fall[0].text).toContain('plündert');
    expect(items.some((i) => i.title === 'Hauptstadt geplündert')).toBe(false);
    expect(items.some((i) => i.title === 'Meldung')).toBe(false);
  });
});

describe('Zeitung: Wirtschaftszahlen und Börse statt Rangliste', () => {
  it('Plätze 1–3 der Rohstoffförderung je Tag und die reichste Staatskasse; keine Provinzrangliste', () => {
    const sim = newSim();
    sim.state.nations.FR.stock.money = 9_876_543;
    const rates = allRates(sim.state, map);
    const best = Object.keys(sim.state.nations).filter((n) => sim.state.nations[n].alive)
      .map((n) => ({ n, t: RESOURCES.reduce((s, r) => s + rates[n].prod[r], 0) }))
      .sort((a, b) => b.t - a.t || a.n.localeCompare(b.n))[0];
    const items = publishNewspaper(sim.state, map).items;
    expect(items.some((i) => i.title === 'Die Mächte im Vergleich')).toBe(false);
    const eco = items.find((i) => i.kind === 'economy')!;
    expect(eco.title).toBe('Wirtschaftszahlen');
    const nameOf = (id: string) => map.nations.find((x) => x.id === id)!.name;
    expect(eco.text).toContain(`1. ${nameOf(best.n)} ${String(Math.round(best.t)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} Tonnen`);
    expect(eco.text).toContain('3. ');
    expect(eco.text).not.toContain('4. ');
    const market = items.find((i) => i.kind === 'market')!;
    expect(market.title).toBe('Börse');
    expect(market.text).toContain(`${nameOf('FR')} mit 9.876.543 Pfund`);
  });
});

describe('Im Gefecht (Anzeige)', () => {
  it('Nahkampf, Feuern und Beschuss zählen als Gefecht, Stillstand nicht', () => {
    const sim = newSim();
    const { q, p2 } = cityWithRoads(sim, 'FR', 5, 30);
    const foe = army(sim, 'FR', q, { infantry: 5 });
    const gun = army(sim, 'DE', p2.b, { artillery: 3 }, { pos: p2 });
    const idle = army(sim, 'DE', map.provinces.find((p) => sim.state.provinces[p.id].owner === 'DE')!.id, { infantry: 1 });
    expect(inCombat(sim.state, map, gun)).toBe(false);
    gun.target = foe.id;
    expect(inCombat(sim.state, map, gun)).toBe(true); // feuert
    expect(inCombat(sim.state, map, foe)).toBe(true); // unter Beschuss
    expect(inCombat(sim.state, map, idle)).toBe(false);
  });
});
