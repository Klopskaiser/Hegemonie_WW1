import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILDINGS, DAY, HOUR, MINUTE, UNITS } from '../src/game/balance.ts';
import { atWar, setRelation } from '../src/game/diplomacy.ts';
import { edgeLength, edgeParts, edgePoint, edgePoints, edgeThrough, isSea, nodePos } from '../src/game/graph.ts';
import type { MapData } from '../src/game/mapdata.ts';
import { applyDamage, armyHp, armyPosition, findPath, meleeOutput, segmentHours, unitCount, unitHp, canEnter, conquer, harborLeg, isRangedOnly, maxRange } from '../src/game/military.ts';
import { addProvince, addVertex, exportDraft, insertBend, newDraft, provRef, seaRef, toggleLink } from '../src/game/draft.ts';
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

  it('Ein- und Ausschiffen dauern 2 h an der Wassergrenze, mit eigenem Hafen 1 h; fremde Häfen helfen nicht', () => {
    const sim = newSim();
    const hamburg = prov('Hamburg');
    const army = garrison(sim, 'DE', hamburg)!;
    const sea = map.provinces.length + (map.provinces[hamburg].seaLinks ?? map.provinces[hamburg].seas)[0];
    const land = harborLeg(map, hamburg, sea);
    const travel = land / UNITS.infantry.speed + (edgeLength(map, hamburg, sea) - land) / MILITARY.transportSpeed;
    expect(segmentHours(sim.state, map, army, hamburg, sea)).toBeCloseTo(travel + 2);
    sim.state.provinces[hamburg].buildings.harbor = 1;
    expect(segmentHours(sim.state, map, army, hamburg, sea)).toBeCloseTo(travel + 1);
    expect(segmentHours(sim.state, map, army, sea, hamburg)).toBeCloseTo(travel + 1);
    // fremder Hafen (Feind): kein Vorteil; dort zählt auch das halbe Tempo im Feindesland
    sim.state.provinces[hamburg].owner = 'FR';
    const hostile = land / (UNITS.infantry.speed * 0.5) + (edgeLength(map, hamburg, sea) - land) / MILITARY.transportSpeed;
    expect(segmentHours(sim.state, map, army, sea, hamburg)).toBeCloseTo(hostile + 2);
  });

  it('Knicke an Land bestimmen beim Einschiffen die Wassergrenze, Knicke im Wasser nicht', () => {
    // zwei Quadrate 100×100 km (Ost: x 150–250), Seepunkt bei x 300 – wie im Karten-Zeichner
    const d = newDraft('mh', 'Mini Hafen', 400, 200);
    const v = [[50, 50], [150, 50], [250, 50], [250, 150], [150, 150], [50, 150]].map((p) => addVertex(d, p as [number, number]));
    addProvince(d, [v[0], v[1], v[4], v[5]], { name: 'West', nation: 'A' });
    addProvince(d, [v[1], v[2], v[3], v[4]], { name: 'Ost', nation: 'A' });
    d.nations = [{ id: 'A', name: 'Alpha', color: '#aa0000', major: true, capital: d.provinces[0].id }];
    d.seas.push({ id: d.nextId++, name: 'S1', at: [300, 100] });
    toggleLink(d, provRef(d.provinces[1].id), seaRef(d.seas[0].id));
    insertBend(d, provRef(d.provinces[1].id), seaRef(d.seas[0].id), [230, 80]);   // an Land
    const m = exportDraft(d).map!;
    const P = m.provinces.length;
    const pts = edgePoints(m, 1, P);
    expect(pts[1]).toEqual([230, 80]);                       // der Verlauf biegt über den Landknick
    // erwartetes Landstück: beide Schenkel bis zum Küstenaustritt x = 250
    const t = (250 - pts[1][0]) / (pts[2][0] - pts[1][0]);
    const expected = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
      + t * Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
    const leg = harborLeg(m, 1, P);
    expect(leg).toBeCloseTo(expected, 0);                    // Landstück = geknickter Weg bis zur Küste
    expect(leg).toBeGreaterThan(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) + 5); // deutlich über Stadt→erster Knick
    expect(leg).toBeLessThan(edgeLength(m, 1, P));           // das Wasserstück bleibt Transporttempo
    // Tempo: Landanteil im Landtempo bis zur Küste, danach Transporttempo plus Einschiffen
    const state = createGame(m, { id: 'g', name: 'G', playerNation: 'A', speed: 1, seed: 1, now: 0 });
    const army: Army = { id: 1, owner: 'A', node: 1, units: { infantry: 4 } };
    const total = leg / UNITS.infantry.speed + (edgeLength(m, 1, P) - leg) / MILITARY.transportSpeed;
    expect(segmentHours(state, m, army, 1, P)).toBeCloseTo(total + MILITARY.embarkHours, 5);
  });

  it('Artillerie und Eisenbahngeschütze haben auf See keine Reichweite und kämpfen im Nahkampf; Geschütze an Land nur auf Bahn', () => {
    const sim = newSim();
    const sea = map.provinces.length;
    const art: Army = { id: 997, owner: 'DE', node: sea, units: { artillery: 2, railgun: 1 } };
    expect(maxRange(art, map)).toBe(0);
    expect(isRangedOnly(art, map)).toBe(false);
    // Nahkampf: volle Wirkung (kein Fernkampfabzug), aber halbe Stärke auf See
    expect(meleeOutput(sim.state, map, art)).toBeCloseTo((2 * UNITS.artillery.attack + UNITS.railgun.attack) * MILITARY.seaFactor);
    const berlin = prov('Berlin');
    const rg: Army = { id: 996, owner: 'DE', node: berlin, units: { railgun: 1 } };
    expect(maxRange(rg, map)).toBe(UNITS.railgun.range);
    expect(canEnter(sim.state, map, rg, sea)).toBe(true);
    const n = map.provinces[berlin].neighbors.find((x) => map.provinces[x].nation === 'DE')!;
    expect(canEnter(sim.state, map, rg, n)).toBe(false);
    sim.state.provinces[n].buildings.railroad = 1;
    expect(canEnter(sim.state, map, rg, n)).toBe(true);
  });

  it('Landtruppen haben auf See und beim Ein-/Ausschiffen halbe Lebenspunkte, Schlachtschiffe volle', () => {
    const sea = map.provinces.length;
    const berlin = prov('Berlin');
    const mixed: Army = { id: 997, owner: 'DE', node: sea, units: { infantry: 10, tank: 1, battleship: 1 }, morale: 1 / 1.2 };
    expect(unitHp(mixed, 'infantry', map)).toBeCloseTo(UNITS.infantry.hp * MILITARY.seaHpFactor, 9);
    expect(unitHp(mixed, 'tank', map)).toBeCloseTo(UNITS.tank.hp * MILITARY.seaHpFactor, 9);
    expect(unitHp(mixed, 'battleship', map)).toBe(UNITS.battleship.hp);
    expect(armyHp(mixed, map)).toBeCloseTo((10 * UNITS.infantry.hp + UNITS.tank.hp) * MILITARY.seaHpFactor + UNITS.battleship.hp, 9);
    // an Land voll, beim Ein-/Ausschiffen halb – nach überqueter Uferlinie bzw. vollständiger Landung wieder voll
    const pier = map.provinces.find((p) => p.id !== berlin && (p.seas ?? p.seaLinks)?.length)!;
    const z = (pier.seas ?? pier.seaLinks)![0];
    const land: Army = { id: 996, owner: 'DE', node: berlin, units: { infantry: 1 }, morale: 1 / 1.2 };
    expect(unitHp(land, 'infantry', map)).toBeCloseTo(UNITS.infantry.hp, 9);
    land.boarding = true;
    land.pos = { a: map.provinces.length + z, b: pier.id, f: 0.01 }; // noch auf dem Wasserabschnitt der Hafenstraße
    expect(unitHp(land, 'infantry', map)).toBeCloseTo(UNITS.infantry.hp * MILITARY.seaHpFactor, 9);
    land.pos = { a: pier.id, b: map.provinces.length + z, f: 0.01 }; // umgekehrt: auf dem Landabschnitt direkt an der Stadt
    expect(unitHp(land, 'infantry', map)).toBeCloseTo(UNITS.infantry.hp, 9);
    delete land.pos; // vollständig gelandet: volle Lebenspunkte trotz hängengebliebener Markung
    expect(unitHp(land, 'infantry', map)).toBeCloseTo(UNITS.infantry.hp, 9);
    expect(armyHp(land, map)).toBeCloseTo(UNITS.infantry.hp, 9);
    // 10 Schaden: an Land eine Wunde, auf See fällt der Infanterist
    const a: Army = { id: 995, owner: 'DE', node: berlin, units: { infantry: 1 }, morale: 1 / 1.2 };
    const b: Army = { ...a, id: 994, node: sea, units: { infantry: 1 } };
    applyDamage(a, 10, () => 0, 0, map);
    applyDamage(b, 10, () => 0, 0, map);
    expect(unitCount(a)).toBe(1);
    expect(unitCount(b)).toBe(0);
  });

  it('Landtruppen kämpfen auf See mit halber Stärke, Schlachtschiffe voll', () => {
    const sim = newSim();
    const sea = map.provinces.length;
    const troops: Army = { id: 999, owner: 'DE', node: sea, units: { infantry: 10 }, morale: 1 / 1.2 };
    const fleet: Army = { id: 998, owner: 'DE', node: sea, units: { battleship: 1 } };
    // Infanterie auf See: Angriffswert × halbe Stärke × Moralfaktor (83,3 % Moral = 1,0)
    expect(meleeOutput(sim.state, map, troops)).toBeCloseTo(10 * 1 * 0.5 * 1);
    // Schlachtschiff: keine Moral, im Nahkampf voll (nur Artillerie und Eisenbahngeschütze kämpfen dort halb)
    expect(meleeOutput(sim.state, map, fleet)).toBeCloseTo(UNITS.battleship.attack);
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
    // 100 % Moral: Infanterie mit 1,2-facher Stärke (Verteidigung 1,1)
    expect(i1).toBeCloseTo(2 * 1.1 * 1.2);
    // Maschinen: Angriff und Verteidigung gleich
    expect(t1).toBeCloseTo(2 * UNITS.tank.attack);
    tanks.morale = 0.1;
    tanks.wounds = { tank: 40 };
    inf.morale = 1 / 1.2;
    expect(meleeOutput(sim.state, map, tanks)).toBeCloseTo(t1);
    expect(meleeOutput(sim.state, map, inf)).toBeCloseTo(2 * 1.1 * 1.0);
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

describe('Begegnungen auf Wegen und Tempo', () => {
  /** Landweg zwischen einer Provinz von `a` und einer von `b`, ohne Abkürzung durch Dritte */
  const border = (a: string, b: string) => {
    for (const p of map.provinces) {
      if (p.nation !== a) continue;
      const q = (p.links ?? p.neighbors).find((n) => map.provinces[n].nation === b && !edgeThrough(map, p.id, n));
      if (q !== undefined) return [p.id, q] as const;
    }
    throw new Error('kein Grenzweg');
  };
  const clear = (sim: Simulation, ...nodes: number[]) => {
    sim.state.armies = sim.state.armies.filter((a) => !nodes.includes(a.node));
  };

  it('verfeindete Armeen, die sich auf demselben Weg entgegenkommen, bleiben stehen und kämpfen', () => {
    const sim = newSim();
    const [p, q] = border('DE', 'FR');
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    clear(sim, p, q);
    const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 5 } };
    const fr: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 5 } };
    sim.state.armies.push(de, fr);
    expect(sim.apply('DE', { type: 'move', army: de.id, to: q }).ok).toBe(true);
    expect(sim.apply('FR', { type: 'move', army: fr.id, to: p }).ok).toBe(true);
    sim.advance(DAY);
    const de2 = sim.state.armies.find((a) => a.id === de.id), fr2 = sim.state.armies.find((a) => a.id === fr.id);
    // keiner ist am anderen vorbei ans Ziel gekommen, und gekämpft wurde
    expect(sim.state.provinces[q].owner).toBe('FR');
    expect(sim.state.provinces[p].owner).toBe('DE');
    expect((de2 ? unitCount(de2) : 0) + (fr2 ? unitCount(fr2) : 0)).toBeLessThan(10);
  });

  it('im Frieden an Land beginnt bei einer Begegnung der Krieg, mit Durchmarschrecht nicht', () => {
    for (const row of [false, true]) {
      const sim = newSim();
      const [p, q] = border('DE', 'NL');
      if (row) setRelation(sim.state, 'DE', 'NL', 'rightOfWay');
      clear(sim, p, q);
      const de: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 5 } };
      const nl: Army = { id: sim.state.nextArmyId++, owner: 'NL', node: p, pos: { a: p, b: q, f: 0.3 }, units: { infantry: 5 } };
      sim.state.armies.push(de, nl);
      expect(sim.apply('DE', { type: 'move', army: de.id, to: p, toward: q, frac: 0.45 }).ok).toBe(true);
      sim.advance(DAY);
      expect(atWar(sim.state, 'DE', 'NL')).toBe(!row);
      if (row) expect(de.pos?.f).toBeCloseTo(0.45, 2);
    }
  });

  it('Nachrücker verschmelzen im Kampf mit der größeren eigenen Armee', () => {
    const sim = newSim();
    const [p, q] = border('DE', 'FR');
    sim.apply('DE', { type: 'declareWar', nation: 'FR' });
    clear(sim, p, q);
    const big: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: q, units: { infantry: 30 } };
    const foe: Army = { id: sim.state.nextArmyId++, owner: 'FR', node: q, units: { infantry: 30 } };
    const late: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 4 } };
    sim.state.armies.push(big, foe, late);
    expect(sim.apply('DE', { type: 'move', army: late.id, to: q }).ok).toBe(true);
    const hours = findPath(sim.state, map, late, p, q)!.hours;
    sim.advance(Math.ceil(hours * HOUR) + 2 * MINUTE);
    expect(sim.state.armies.includes(late)).toBe(false);
    expect(sim.state.armies.includes(big)).toBe(true);
  });

  it('halbes Tempo ohne Durchmarschrecht; der Marsch wird hinter der Grenze sichtbar langsamer', () => {
    const sim = newSim();
    const [p, q] = border('DE', 'FR');
    const a: Army = { id: sim.state.nextArmyId++, owner: 'DE', node: p, units: { infantry: 2 } };
    const [l1, d] = edgeParts(map, p, q);
    const v = UNITS.infantry.speed;
    expect(segmentHours(sim.state, map, a, p, q)).toBeCloseTo(l1 / v + (d - l1) / (v * 0.5), 6);
    setRelation(sim.state, 'DE', 'FR', 'rightOfWay');
    expect(segmentHours(sim.state, map, a, p, q)).toBeCloseTo(l1 / v + (d - l1) / (v * 0.7), 6);
    // Position: nach der Zeit bis zur Grenze steht die Armee an der Grenze
    setRelation(sim.state, 'DE', 'FR', 'war');
    clear(sim, p, q);
    sim.state.armies.push(a);
    expect(sim.apply('DE', { type: 'move', army: a.id, to: q })).toMatchObject({ ok: true });
    sim.advance(Math.round((l1 / v) * HOUR));
    const [x, y] = armyPosition(map, a, sim.state.time), [bx, by] = edgePoint(map, p, q, l1 / d);
    expect(Math.hypot(x - bx, y - by)).toBeLessThan(2);
  });

  it('Ausbaustufen kosten gleich viel und dauern gleich lang, nur die Festung dauert länger', () => {
    for (const b of Object.keys(BUILDINGS) as (keyof typeof BUILDINGS)[]) {
      const def = BUILDINGS[b];
      for (let l = 2; l <= def.maxLevel; l++) {
        expect(def.cost(l)).toEqual(def.cost(1));
        if (b !== 'fortress') expect(def.hours(l)).toBe(def.hours(1));
        else expect(def.hours(l)).toBeGreaterThan(def.hours(l - 1));
      }
    }
  });
});

describe('Plünderung bei Hauptstadt-Einnahme', () => {
  /** Kleinstaat mit mindestens zwei Provinzen, damit er die Einnahme überlebt */
  const minor = map.nations.find((n) => !n.major && map.provinces.filter((p) => p.nation === n.id).length >= 2)!;
  const own = (nat: string) => map.provinces.filter((p) => p.nation === nat);
  const capital = map.nations.find((n) => n.id === minor.id)!.capital;
  const ctx = (sim: Simulation) => ({ state: sim.state, map, log: () => {}, invalidate: () => {}, random: () => 0.5, newArmyId: () => 99999 });

  it('bringt dem Eroberer 20 % der Kasse des Kleinstaats ein', () => {
    const sim = newSim();
    sim.state.nations[minor.id].stock.money = 12345;
    sim.state.nations.DE.stock.money = 1000;
    conquer(ctx(sim), capital, 'DE');
    const loot = Math.floor(12345 * MILITARY.capitalPlunder);
    expect(sim.state.nations[minor.id].stock.money).toBe(12345 - loot);
    expect(sim.state.nations.DE.stock.money).toBe(1000 + loot);
    expect(sim.state.nations[minor.id].alive).toBe(true);
  });

  it('gewöhnliche Provinzen werden nicht geplündert', () => {
    const sim = newSim();
    const other = own(minor.id).find((p) => p.id !== capital)!;
    sim.state.nations[minor.id].stock.money = 12345;
    sim.state.nations.DE.stock.money = 1000;
    conquer(ctx(sim), other.id, 'DE');
    expect(sim.state.nations[minor.id].stock.money).toBe(12345);
    expect(sim.state.nations.DE.stock.money).toBe(1000);
  });
});
